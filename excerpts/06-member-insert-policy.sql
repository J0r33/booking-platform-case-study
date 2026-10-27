-- Excerpt 06 — A row-level security policy that checks itself at deploy time
--
-- Members create bookings straight from the browser through Supabase's auto-generated API, so
-- the database policy IS the access check. This policy lets a member insert a booking only for
-- their own profile, and only in the shape a member is allowed to create. Every server-owned
-- column (status, completion, reschedule links, no-show billing, staff assignment) must be
-- left at its default, so a member cannot book themselves as "completed" or attach a trainer.
--
-- What to notice:
--   * `(SELECT auth.uid())` instead of a bare `auth.uid()`: Postgres evaluates it once per
--     statement instead of once per row.
--   * The postflight block re-reads the policy from the catalog after the migration runs and
--     fails the deploy if any condition is missing. Policies get edited with ALTER POLICY,
--     which replaces the whole expression, so a later migration can silently drop a line.
--   * Part B fails if any OTHER insert policy appears. Permissive policies are OR-ed together,
--     so a new one could quietly route around every condition above.
--
-- Lightly edited from production: ticket references removed from comments and messages, and
-- a business-specific trigger check omitted.

ALTER POLICY "Members can create their own bookings" ON public.bookings
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.client_profiles cp
      WHERE cp.id = bookings.client_id AND cp.user_id = (SELECT auth.uid())
    )
    AND created_by_role = 'member'
    AND status = 'scheduled'
    AND rescheduled_from_booking_id IS NULL
    AND rescheduled_to_booking_id IS NULL
    AND completed_at IS NULL
    AND completed_by IS NULL
    AND bill_no_show = false
    AND booking_type = 'standard'
    AND facilitator_id IS NULL
  );

DO $postflight$
DECLARE
  v_check text;
  v_col text;
BEGIN
  -- A. The member INSERT policy carries every predicate, as Postgres deparses
  --    them. (Casts are matched without their type name: pg_get_expr qualifies
  --    a type not on the search_path.)
  SELECT with_check INTO v_check FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'bookings'
     AND policyname = 'Members can create their own bookings' AND cmd = 'INSERT';
  IF v_check IS NULL THEN
    RAISE EXCEPTION 'postflight: the member INSERT policy is missing';
  END IF;
  FOREACH v_col IN ARRAY ARRAY[
      '(created_by_role = ''member''::',
      '(status = ''scheduled''::',
      '(rescheduled_from_booking_id IS NULL)',
      '(rescheduled_to_booking_id IS NULL)',
      '(completed_at IS NULL)',
      '(completed_by IS NULL)',
      '(bill_no_show = false)',
      '(booking_type = ''standard''::',
      '(facilitator_id IS NULL)'] LOOP
    IF position(v_col IN v_check) = 0 THEN
      RAISE EXCEPTION 'postflight: the member INSERT policy lacks %', v_col;
    END IF;
  END LOOP;

  -- B. Still exactly the two INSERT-capable policies, both permissive: a new
  --    one a member could pass would OR around this predicate, and a
  --    restrictive one would change what the predicate means.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'bookings'
                AND cmd IN ('INSERT', 'ALL')
                AND (policyname NOT IN ('Members can create their own bookings',
                                        'Facilitators can create any booking')
                     OR permissive <> 'PERMISSIVE')) THEN
    RAISE EXCEPTION 'postflight: bookings has an INSERT policy this migration did not account for';
  END IF;
END;
$postflight$;
