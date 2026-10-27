// Excerpt 09 — Resolving a flagged refund: audit first, compare-and-swap, three honest answers
//
// When an automatic refund cannot complete, the charge is flagged for an admin to settle by
// hand. Two admins can open the same flag at once, and one admin can double-click.
//
// What to notice:
//   * AUDIT BEFORE MUTATION. If the audit record cannot be written, the flag is not cleared,
//     so nothing is ever settled without a record of who did it and when.
//   * COMPARE-AND-SWAP: the update names the expected prior state (`manual_refund_required =
//     true`). If someone else resolved it between the read and the write, this update
//     matches zero rows instead of silently overwriting their resolution.
//   * Three outcomes the admin can tell apart: already resolved (a harmless repeat, 200), lost
//     the race to a colleague (409), and a real fault (500). Merging any two of them would tell
//     the admin something false about their money.
//
// Lightly edited from production: an acceptance-criterion reference removed.

  const decision = buildResolutionPatch(snapshot, {
    resolution: body.resolution,
    squareRefundId: squareRefundId || undefined,
    note: note || undefined,
    now: new Date().toISOString(),
  })

  if (!decision.ok) {
    if (decision.refusal === 'not_flagged') {
      // Idempotent, not an error: a double click, or two operators working the
      // same banner, must not read as a failure. Audited so the second click is
      // still visible in the trail.
      await audit('trainer_charge_resolution_noop', { reason: 'not_flagged' }, chargeId)
      return json({ success: true, alreadyResolved: true })
    }
    await audit('trainer_charge_resolution_rejected', {
      reason: decision.refusal,
      resolution: body.resolution,
    }, chargeId)
    return json({ error: decision.refusal }, 422)
  }

  const prior = priorStateOf(snapshot)

  // Audit BEFORE the mutation.
  const audited = await audit('trainer_charge_resolved', {
    resolution: body.resolution,
    note,
    square_refund_id: squareRefundId || null,
    prior_status: prior.status,
    prior_refunded_at: prior.refunded_at,
    prior_square_refund_id: prior.square_refund_id,
    patch: decision.patch,
  }, chargeId)

  if (!audited) {
    // The clear must record who did it and when. If that record could not be
    // written, the clear must not happen — otherwise the flag comes off with
    // nothing anywhere saying who took it off.
    return json({ error: 'audit_write_failed' }, 500)
  }

  // COMPARE-AND-SWAP, not a bare id match. The flag was read at the top of this
  // handler and is written here; between those two points another admin can
  // resolve the same charge. Both requests would pass the in-memory not_flagged
  // check, both would write an audit row, and the last update would silently
  // overwrite the first one's square_refund_id and resolution. Naming the
  // expected pre-state in the filter makes the loser match zero rows.
  const { data: updated, error: updateErr } = await admin
    .from('trainer_session_charges')
    .update(decision.patch)
    .eq('id', chargeId)
    .eq('manual_refund_required', true)
    .select('id')

  if (updateErr) {
    await audit('trainer_charge_resolution_failed', {
      reason: 'update_error',
      detail: updateErr.message,
    }, chargeId)
    return json({ error: 'resolution_write_failed' }, 500)
  }
  if (!Array.isArray(updated) || updated.length === 0) {
    // A DIFFERENT STATE FROM A FAULT, and reported as one. Zero rows here means
    // the flag was no longer true when the write ran — somebody else resolved
    // this charge first. Collapsing that into 'resolution_write_failed' would
    // tell the operator their settlement failed when in fact someone else's
    // succeeded, and collapsing it into the idempotent no-op would tell them
    // theirs landed when it did not.
    await audit('trainer_charge_resolution_conflict', {
      reason: 'flag_cleared_concurrently',
      resolution: body.resolution,
    }, chargeId)
    return json({ error: 'resolved_by_someone_else' }, 409)
  }

  return json({ success: true, resolved: true })
