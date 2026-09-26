-- Fantasy Injury Tracker: Yahoo league sync.
-- Run after 009_more_alerts.sql (SQL Editor > New query > paste > Run).
--
-- Yahoo uses a real sign-in (OAuth) instead of cookies. Each person's Yahoo tokens are
-- stored encrypted here, one row per person. A Yahoo league syncs with the tokens of the
-- person who linked it. Backend-only table: no browser access at all.

create table if not exists public.platform_auth (
  user_id     uuid not null references auth.users(id) on delete cascade,
  platform    text not null check (platform in ('yahoo')),
  ciphertext  text not null,            -- AES-GCM encrypted JSON, key lives only in the edge functions
  updated_at  timestamptz not null default now(),
  primary key (user_id, platform)
);

alter table public.platform_auth enable row level security;
-- no policies on purpose: only the backend (service role) can touch this table
