-- Fantasy Injury Tracker: league sync (Sleeper + ESPN) with invite-to-claim.
-- Run after 006_sleeper_status.sql (SQL Editor > New query > paste > Run).
--
-- One person links a league. Every team in it is pulled in. League-mates open an
-- invite link and claim their team. Claimed teams stay in sync automatically.
-- These tables are only read/written by the backend (no browser access at all),
-- so ESPN cookies and other people's rosters never reach the app directly.

create table if not exists public.leagues (
  id           uuid primary key default gen_random_uuid(),
  platform     text not null check (platform in ('sleeper','espn','yahoo')),
  external_id  text not null,
  season       int  not null,
  name         text not null,
  linked_by    uuid not null references auth.users(id) on delete cascade,
  invite_code  text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
  status       text not null default 'ok' check (status in ('ok','error','reconnect')),
  last_error   text,
  synced_at    timestamptz,
  created_at   timestamptz not null default now(),
  unique (platform, external_id, season)
);

create table if not exists public.league_secrets (
  league_id   uuid primary key references public.leagues(id) on delete cascade,
  ciphertext  text not null,            -- AES-GCM encrypted JSON, key lives only in the edge function
  updated_at  timestamptz not null default now()
);

create table if not exists public.league_teams (
  id                uuid primary key default gen_random_uuid(),
  league_id         uuid not null references public.leagues(id) on delete cascade,
  external_team_id  text not null,
  name              text not null,
  manager           text,
  owner_keys        text[] not null default '{}',   -- platform user ids that own this team
  roster            jsonb not null default '[]',    -- [{player_id, lineup_slot}]
  unmatched         jsonb not null default '[]',    -- players we couldn't match, shown to the user
  synced_at         timestamptz,
  unique (league_id, external_team_id)
);

-- a claimed team is an ordinary user_team pointing at its league team
alter table public.user_teams add column if not exists league_team_id uuid references public.league_teams(id) on delete set null;
create unique index if not exists user_teams_league_team_uniq on public.user_teams (league_team_id) where league_team_id is not null;

alter table public.leagues        enable row level security;
alter table public.league_secrets enable row level security;
alter table public.league_teams   enable row level security;
-- no policies on purpose: only the backend (service role) can touch these tables
