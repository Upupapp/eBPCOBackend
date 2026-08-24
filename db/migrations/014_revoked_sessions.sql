-- Sessions that have been signed out, for as long as that fact still matters.
--
-- Revoking a refresh token stops NEW access tokens being minted. It does
-- nothing to one already issued, which keeps working until it expires — so
-- "sign out of every device" did not sign anyone out of anything for up to
-- fifteen minutes. On a shared or lost handset that is the whole window in
-- which signing out was the thing to do.
--
-- The guard could have inferred liveness from `refresh_tokens` instead: a live
-- family has exactly one unconsumed, unrevoked row. That was rejected. It
-- couples the authentication path to the retention behaviour of a background
-- purge — the day that job's WHERE clause changes, every session in the system
-- ends — and it makes an authorisation decision out of a row that exists for a
-- different purpose.
--
-- So revocation is recorded explicitly, and the record expires. An access token
-- lives at most fifteen minutes, so after that the record protects nothing the
-- token's own expiry does not. That is what keeps this table small enough to
-- consult on every request.
create table revoked_sessions (
  -- The refresh-token family, which is what an access token carries as `sid`.
  family_id   uuid        primary key,
  revoked_at  timestamptz not null default now(),

  -- revoked_at + the access-token lifetime. Past this, any token bearing this
  -- family has expired on its own.
  expires_at  timestamptz not null,

  constraint revocation_expires_after_it_happens check (expires_at > revoked_at)
);

comment on table revoked_sessions is
  'Signed-out sessions, kept only as long as an access token could outlive the sign-out. '
  'Swept by the operational-data-purge job.';

create index revoked_sessions_expiring on revoked_sessions (expires_at);
