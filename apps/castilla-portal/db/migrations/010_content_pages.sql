-- The narrative pages: history, vision, mission, seal description, privacy
-- policy. `content_pages` was created in migration 001 and, like
-- `office_related` before it, never written to.
--
-- Three of the five are deliberately incomplete, and each incompleteness is a
-- decision somebody made carefully. The Vision statement was found only as a
-- truncated fragment and is a PLACEHOLDER rather than a half-quote. The seal
-- description transcribes what is visually present and explicitly disclaims
-- heraldic meaning. The privacy policy awaits the LGU's own. A model that
-- treats these as free-text blobs erases that reasoning the first time anyone
-- edits them, so the placeholder-ness is a column and the sourcing is
-- provenance, exactly as it is for every other field in this schema.
alter table content_pages
  add column ordinal        int  not null default 0,
  -- TRUE means: this text is standing in for content the LGU has not supplied,
  -- and the client should render its honest 'pending publication' notice rather
  -- than present the text as the municipality's own words.
  add column is_placeholder boolean not null default false,
  add column source_note    text;

comment on column content_pages.is_placeholder is
  'True when the body is standing in for content the LGU has not yet supplied. '
  'Distinct from the confirmation state in field_state: a page can be an '
  'honest, sourced description of a placeholder situation.';

-- Revision history with an author and a timestamp. The privacy policy in
-- particular WILL be replaced by an LGU-authored document, and the placeholder
-- must stay retrievable afterwards — the same reason TAB 06 keeps a superseded
-- form: what the site said at a given time is a fact about the site.
create table content_page_revisions (
  id             uuid primary key default gen_random_uuid(),
  key            text not null references content_pages (key) on delete cascade,
  title          text not null,
  body           text not null,
  is_placeholder boolean not null,
  -- Who wrote it. Not nullable and not blank, for the same reason a withdrawal
  -- must name someone: 'the text was changed' is not a history.
  author         text not null check (length(trim(author)) > 0),
  recorded_at    timestamptz not null default now()
);

create index content_page_revisions_by_key
  on content_page_revisions (key, recorded_at desc);
