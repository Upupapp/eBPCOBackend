-- TAB 01 — the content model.
--
-- Two invariants shape every table here, and they outrank convenience:
--
--   Provenance is DATA. Where a fact came from, when, and by what method are
--   columns, because the sourcing comments in the portal's data files are the
--   most valuable thing in that repository and a schema that drops them keeps
--   the value while destroying the reason to believe it.
--
--   `isPlaceholder` is a PUBLICATION GATE. Unconfirmed content is withheld from
--   citizens and kept in full, because the draft value is where the
--   confirmation conversation with the LGU starts.

-- ── Confirmation state ───────────────────────────────────────────────────
--
-- Three states, not a boolean. `pending` is "nobody has confirmed this yet";
-- `withheld` is "we have decided not to publish it" -- the owner's ruling on
-- personal staff contacts needs the second, and it is not the first.
--
-- Deliberately NO `verified_by_lgu` boolean beside this. One state machine.
create type confirmation_state as enum ('confirmed', 'pending', 'withheld');

-- How a fact was obtained. Not decoration: several facts in the source were
-- found by search extraction BECAUSE castillasorsogon.gov.ph blocks automated
-- fetching, and a reader weighing the municipality's founding date needs to
-- know that. An enum so the answer cannot drift into free text.
create type provenance_method as enum ('direct-read', 'search-extraction', 'official-document');

-- ── Entities ─────────────────────────────────────────────────────────────
--
-- Slugs are the PUBLIC identifier and must be stable: they are already in
-- citizens' URLs. Surrogate keys are internal; the API speaks slugs.

create table office_categories (
  id       text primary key,
  label    text not null,
  ordinal  int  not null
);

create table offices (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique,
  name               text not null,
  category_id        text not null references office_categories (id) on delete restrict,
  short_description  text not null,
  about_text         text not null,
  -- The committed order groups executive offices first and is deliberate;
  -- TAB 03 forbids sorting by name. A set has no order, so the order is stored.
  ordinal            int  not null
);

-- An ordered list, not free text. TAB 08's search reads it, and the reason four
-- of the likeliest search terms on a building-permit portal currently return
-- nothing is that the client's haystack stops one field short of it.
create table office_services (
  office_id  uuid not null references offices (id) on delete cascade,
  ordinal    int  not null,
  service    text not null,
  primary key (office_id, ordinal)
);

create table office_related (
  office_id          uuid not null references offices (id) on delete cascade,
  related_office_id  uuid not null references offices (id) on delete restrict,
  ordinal            int  not null,
  primary key (office_id, related_office_id),
  -- An office relating to itself is a data error, not a relationship.
  constraint office_related_is_not_self check (office_id <> related_office_id)
);

create table officials (
  id        uuid primary key default gen_random_uuid(),
  slug      text not null unique,
  name      text not null,
  position  text not null,
  office    text not null,
  initials  text not null,
  photo_url text,
  ordinal   int  not null
);

-- The Mayor's and Vice Mayor's office heads ARE these records. One fact, one
-- row: the portal previously named the Mayor on one page and showed his office
-- as headless on another, because each page carried its own copy.
alter table offices add column head_official_id uuid references officials (id) on delete restrict;

create table permit_office_groups (
  id       text primary key,
  label    text not null,
  ordinal  int  not null
);

create table permits (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  -- Canonical, verbatim. 'Civil / Structural Permit' has spaces around its
  -- slash and 'Building Permit – New Construction' uses an EN DASH; both are
  -- load-bearing and shared with the eBPCO admin portal.
  name                text not null unique,
  office_group_id     text not null references permit_office_groups (id) on delete restrict,
  -- NULLABLE ON PURPOSE. The two BFP permits are issued by the Bureau of Fire
  -- Protection, a national agency with no municipal office record. No migration
  -- or seeder may invent a BFP office row to make this column tidy.
  issuing_office_id   uuid references offices (id) on delete restrict,
  issuing_office_name text not null,
  description         text not null,
  validity            text not null,
  process_note        text,
  ordinal             int  not null
);

create table permit_requirements (
  permit_id    uuid not null references permits (id) on delete cascade,
  ordinal      int  not null,
  requirement  text not null,
  primary key (permit_id, ordinal)
);

create table profile_fields (
  id             uuid primary key default gen_random_uuid(),
  label          text not null unique,
  -- Display text, used verbatim. The count below is the numeric part and
  -- `count_suffix` the rest, so a client that animates a count lands on exactly
  -- this string.
  value          text not null,
  -- Set only on genuine magnitudes. ZIP 4713 and PSGC 0506206000 are
  -- identifiers, and counting up to a postal code is meaningless.
  count          numeric,
  count_suffix   text,
  count_decimals int,
  ordinal        int not null,

  -- A suffix or a precision without a count describes nothing. The magnitude is
  -- authored, never parsed back out of the display string.
  constraint profile_count_is_whole check (
    (count is not null) or (count_suffix is null and count_decimals is null)
  )
);

create table content_pages (
  -- Keyed by MEANING, not by id: the client references 'history', 'vision',
  -- 'mission', 'seal-description', 'privacy-policy' by what they are.
  key        text primary key,
  title      text not null,
  body       text not null,
  updated_at timestamptz not null default now()
);
