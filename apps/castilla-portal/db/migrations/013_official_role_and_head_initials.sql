-- What kind of seat an official holds, and initials for a head nobody elected.
--
-- Both raised by the public information website lane against its own rendering
-- code rather than against the schema.
--
-- ── 1. The role ──────────────────────────────────────────────────────────
--
-- The site renders four distinct groups: the Mayor, the Vice Mayor, the eight
-- Sangguniang Bayan members, and two ex-officio seats. `officials` carried
-- slug, name, position, office, initials, photo_url, ordinal — nothing saying
-- which group a row belongs to — so the only way to reconstruct it was
-- STRING-MATCHING ON `position`, which is the brittleness that lane removed
-- once already as F-07.
--
-- A position is prose written for a citizen to read: "Sangguniang Bayan Member
-- (ABC President)" is one edit away from not matching whatever pattern a client
-- guessed at. The role is the fact; the position is how it is worded.
--
-- The four values are the ones that lane asked for. Ex-officio seats are one
-- value, not two: the site groups them together, and if the ABC president and
-- the SK federation president ever need telling apart, that is an ADDITIVE
-- value here rather than a re-shaping.
alter table officials add column role text
  check (role in ('mayor', 'vice-mayor', 'sb-member', 'sb-ex-officio'));

-- Backfilled from `position`, ONCE, here — which is the only place that
-- matching is acceptable, because a migration runs against known data that can
-- be checked afterwards, while a client's match runs for ever against data
-- nobody has seen yet.
update officials set role = 'mayor'
 where position ilike '%mayor%' and position not ilike '%vice mayor%';
update officials set role = 'vice-mayor' where position ilike '%vice mayor%';
update officials set role = 'sb-ex-officio'
 where role is null and (position ilike '%ABC%' or position ilike '%SK %' or position ilike '%ex-officio%');
update officials set role = 'sb-member' where role is null;

-- Not null AFTER the backfill: every existing row now has one, and a future
-- insert that omits it would land in whichever group a client guessed last.
alter table officials alter column role set not null;

-- ── 2. Initials for a written head ───────────────────────────────────────
--
-- An office head comes from one of two places (migration 005): an elected
-- official, or a name written on the office itself. The elected ones carry
-- AUTHORED initials — the Mayor's are "IM", not the first letters of anything
-- mechanical — because deriving them means handling honorifics (Atty., Dr.),
-- generational suffixes (Jr.), post-nominals after a comma (, RSW) and quoted
-- nicknames: Isagani "Bong" B. Mendoza is IM.
--
-- Serving initials only for elected heads would leave the client deriving them
-- for the rest, which is the work this column exists to remove. So a written
-- head gets authored initials too.
alter table offices add column head_initials text
  check (head_initials is null or length(trim(head_initials)) > 0);

-- NULLABLE, and deliberately not yet required.
--
-- The initials for a written head have to be AUTHORED, and they are authored
-- where the rest of this content is: in the website lane's own
-- `offices.data.ts`, which `extract-portal-data.ts` reads. Requiring them now
-- would fail this migration against the offices that already have a written
-- head, and the only way to satisfy it would be to derive them here -- which is
-- exactly the derivation this column exists to abolish, moved server-side and
-- done once where nobody would ever look at it again.
--
-- So: the column exists, the extractor carries it, and it becomes NOT NULL in a
-- later migration once the source data has them. Until then a written head
-- serves no initials and the client's fallback still runs for those.
--
-- What IS enforced is the direction that can never be right: initials without a
-- written head to attach them to.
alter table offices
  add constraint office_head_initials_need_a_written_head
  check (head_initials is null or head_name is not null);

comment on column offices.head_initials is
  'Authored, never derived: honorifics, suffixes, post-nominals and nicknames make derivation wrong.';
