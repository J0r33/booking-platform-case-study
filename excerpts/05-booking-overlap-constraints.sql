-- Excerpt 05 — No double-booking, enforced by the database
--
-- Two people tapping "Book" at the same moment both pass an application-level "is this slot
-- free?" check. These exclusion constraints make overlapping bookings impossible at the
-- database itself, whatever the application does.
--
-- What to notice:
--   * Three independent rules: one live booking per station (a bookable piece of equipment),
--     no member in two places at once, and no trainer leading two sessions at once.
--   * `tstzrange(...) WITH &&` means "time ranges overlap", and the GiST index checks it.
--   * Cancelled bookings are excluded, so a cancelled slot can be rebooked.
--
-- Lightly edited from production: ticket references and a staff member's name removed from
-- the comments. (Requires the btree_gist extension.)

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_station_no_overlap
    EXCLUDE USING gist (station WITH =, tstzrange(start_time, end_time) WITH &&)
    WHERE (status <> 'cancelled');

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_member_no_overlap
    EXCLUDE USING gist (client_id WITH =, tstzrange(start_time, end_time) WITH &&)
    WHERE (status <> 'cancelled');

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_trainer_no_overlap
    EXCLUDE USING gist (facilitator_id WITH =, tstzrange(start_time, end_time) WITH &&)
    WHERE (status <> 'cancelled' AND booking_type = 'training');

COMMENT ON CONSTRAINT bookings_station_no_overlap ON public.bookings IS
  'One live (not cancelled) booking per station at a time.';
COMMENT ON CONSTRAINT bookings_member_no_overlap ON public.bookings IS
  'A member never has two live bookings that overlap.';
COMMENT ON CONSTRAINT bookings_trainer_no_overlap ON public.bookings IS
  'A trainer leads one station at a time (trainer-led bookings only).';
