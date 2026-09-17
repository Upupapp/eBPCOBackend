-- `businesses_category_check` (migration 003) still only allows the
-- original six categories ('Retail', 'Food Service', 'Services',
-- 'Manufacturing', 'Wholesale', 'Other'). `businesses.controller.ts`'s own
-- `businessShape.category` zod enum was widened at some point to a
-- different eight-value list — same five plus 'Construction', 'Transport',
-- 'Agriculture' in place of 'Wholesale' — and nothing widened this
-- constraint to match.
--
-- The result: a real citizen choosing "Construction" (or "Transport" or
-- "Agriculture") on the Citizen Portal's own business-registration form —
-- options the form offers because they ARE valid per the controller's own
-- validation — passed that validation and then crashed with a raw
-- "violates check constraint" 500 at the database, first caught live
-- registering an actual business through the real portal.
--
-- Fixed as a union of both vocabularies, not a replacement: the
-- controller's zod enum is what actually gates every new row, so the
-- database only needs to be permissive enough not to reject what the app
-- can legitimately send. Keeping 'Wholesale' costs nothing and protects any
-- row already carrying it (a fresh CHECK constraint validates every
-- existing row against the new list, so dropping a value in use would
-- refuse to apply at all).
alter table businesses drop constraint businesses_category_check;
alter table businesses add constraint businesses_category_check check (category in
  ('Retail', 'Food Service', 'Services', 'Manufacturing', 'Wholesale', 'Other',
   'Construction', 'Transport', 'Agriculture'));
