// Excerpt 02 — Surviving duplicate and retried webhook deliveries
//
// Square can deliver the same refund more than once (paired refund.created / refund.updated
// events, plus its own retries). When a partial refund arrives, the platform cancels the
// member's unused sessions and records the revocation. A unique constraint on the
// revocation table makes "record it" happen exactly once.
//
// What to notice:
//   * ORDERING IS DELIBERATE: side effects first, the record second. If the function crashes
//     between them, the redelivery re-runs from a state that is closer to done. The opposite
//     order could leave credits revoked but sessions standing, with every redelivery hitting
//     the unique constraint and doing nothing — permanently inconsistent.
//   * A unique violation (Postgres 23505) is treated as SUCCESS, not as an error: it proves
//     this refund was already applied.
//   * Any other insert error is NOT acknowledged, so Square retries.
//
// Lightly edited from production: internal ticket references removed.

  if (disposition.partial) {
    const insert = await admin
      .from("session_credit_revocations")
      .insert({
        grant_id: grant.id,
        client_id: grant.client_id,
        credits_revoked: disposition.creditsRevoked,
        square_refund_id: refundId,
        refund_amount_cents: disposition.refundAmountCents,
        paid_cents_at_revocation: disposition.paidCents,
      })
      .select("id");

    if (insert.error) {
      // 23505 is unique_violation: THIS refund has already been applied. That is
      // Square's paired refund.created/refund.updated, or a retry, and it is a
      // SUCCESS — the credits are gone exactly once, which is the whole point of
      // the constraint. No second audit row: two records for one refund would be
      // a small lie of their own.
      const code = (insert.error as { code?: string }).code;
      if (code === "23505") {
        console.log("square-webhook partial refund already applied", {
          grant_id: grant.id,
          refund_id: refundId,
        });
        return textResponse(200, "ok");
      }
      // Anything else and the revocation did NOT land. Sessions may already be
      // cancelled, which is recoverable — the credits came back — so this is
      // worth retrying rather than acknowledging.
      // ... returns a non-2xx so Square redelivers ...
    }
  }
