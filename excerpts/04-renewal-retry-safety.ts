// Excerpt 04 — "Positive evidence charges; absence of evidence defers"
//
// An hourly job renews memberships. Part of a renewal can be paid from the member's account
// credit, and the rest goes to their card through Square. If a previous run debited credit and
// then died before reaching Square, the next run must not take that credit again.
//
// The guard reads the credit ledger for movements already made for THIS renewal period. An
// earlier version ignored the read's error. A failed read came back as "nothing applied yet",
// which is the same value a clean read gives, so the guard was switched off by exactly the
// failure it existed for. Tests written against that version showed both outcomes: the card
// charged full price for a renewal already part-paid in credit, or the ledger debited twice.
//
// What to notice:
//   * A failed read now throws a deferral. The renewal waits for the next hour instead of
//     guessing.
//   * The scope comes from time (`created_at >= current_period_end`), because the period only
//     advances on success.
//   * Amounts are recomputed treating prior debits as already paid.
//
// Lightly edited from production: comments condensed, ticket references removed.

      // IDEMPOTENCY: this cron runs hourly with no pending-row anchor. Any renewal
      // credit movement for this membership created at or after current_period_end
      // belongs to THIS renewal attempt, because the period only advances on success.
      //
      // AND THE READ MUST ANSWER. Treating a failed read as "no prior attempt" is
      // indistinguishable from a clean read that found none — and both money harms
      // (card overcharge, double ledger debit) follow from it.
      //
      // Positive evidence charges; absence of evidence defers.
      const priorRead = priorRenewalMovesFrom(await supabase
        .from("account_credits")
        .select("amount_cents")
        .eq("source_ref_id", m.id)
        .in("source", ["renewal_apply", "renewal_reversal"])
        .gte("created_at", m.current_period_end));
      if (!priorRead.ok) {
        throw new RenewalDeferred("renewal_idempotency_read", priorRead.detail);
      }
      const alreadyAppliedCents = priorRead.alreadyAppliedCents;

      // Recompute this renewal from the discount, treating prior debits as already paid.
      const afterDiscountCents = Math.max(0, pricing.listCents - pricing.discountCents);
      const remainingNeedCents = Math.max(0, afterDiscountCents - alreadyAppliedCents);
      const newCreditCents = Math.min(pricing.creditBalanceCents, remainingNeedCents);
      const totalCents = Math.max(0, remainingNeedCents - newCreditCents);
