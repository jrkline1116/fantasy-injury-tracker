-- Fantasy Injury Tracker: database schema
-- Paste this whole file into Supabase > SQL Editor > New query, then Run.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------- shared NFL data (written only by the backend) ----------

create table if not exists public.nfl_players (
  id           text primary key,          -- Sleeper player id (team abbreviation for defenses)
  full_name    text not null,
  search_name  text not null,             -- lowercased, punctuation and suffixes stripped
  pos          text not null,             -- QB RB WR TE K DEF
  team         text,                      -- Sleeper abbreviation, e.g. CIN, WAS
  depth_order  int,
  espn_id      text,
  updated_at   timestamptz not null default now()
);
create index if not exists nfl_players_team_idx on public.nfl_players (team, pos, depth_order);
create index if not exists nfl_players_espn_idx on public.nfl_players (espn_id);
create index if not exists nfl_players_search_idx on public.nfl_players using gin (search_name extensions.gin_trgm_ops);

create table if not exists public.player_status (
  player_id   text primary key references public.nfl_players(id) on delete cascade,
  status      text not null default 'ACT',  -- ACT Q D O IR SUS
  detail      text,
  updated_at  timestamptz not null default now()
);

create table if not exists public.status_events (
  id          bigint generated always as identity primary key,
  player_id   text not null,
  from_status text not null,
  to_status   text not null,
  created_at  timestamptz not null default now()
);
create index if not exists status_events_player_idx on public.status_events (player_id, created_at desc);

create table if not exists public.games (
  id       text primary key,              -- ESPN event id
  season   int,
  week     int,
  kickoff  timestamptz not null,
  home     text not null,
  away     text not null,
  state    text
);
create index if not exists games_kickoff_idx on public.games (kickoff);

create table if not exists public.job_state (
  key     text primary key,
  ran_at  timestamptz,
  info    jsonb
);

-- ---------- per-user data ----------

create table if not exists public.user_settings (
  user_id      uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  mode         text not null default 'impact' check (mode in ('all','impact','off')),
  tx_on        boolean not null default true,
  tx_minutes   int not null default 10 check (tx_minutes between 5 and 120 and tx_minutes % 5 = 0),
  upside       boolean not null default true,
  bye          boolean not null default true,
  quiet_on     boolean not null default true,
  quiet_start  time not null default '22:00',
  quiet_end    time not null default '07:00',
  timezone     text not null default 'America/Phoenix',
  updated_at   timestamptz not null default now()
);

create table if not exists public.user_teams (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name               text not null check (char_length(name) between 1 and 40),
  notify             text not null default 'inherit' check (notify in ('inherit','all','impact','off')),
  sort               int not null default 0,
  created_at         timestamptz not null default now()
);
create index if not exists user_teams_user_idx on public.user_teams (user_id);

create table if not exists public.roster (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  team_id     uuid not null references public.user_teams(id) on delete cascade,
  player_id   text not null references public.nfl_players(id) on delete cascade,
  slot        text not null default 'bench' check (slot in ('start','bench')),
  notify      text not null default 'inherit' check (notify in ('inherit','all','impact','mute')),
  created_at  timestamptz not null default now(),
  unique (team_id, player_id)
);
create index if not exists roster_player_idx on public.roster (player_id);

create table if not exists public.links (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  team_id     uuid not null references public.user_teams(id) on delete cascade,
  roster_id   uuid not null references public.roster(id) on delete cascade,
  player_id   text not null references public.nfl_players(id) on delete cascade,
  kind        text not null default 'custom' check (kind in ('qb','handcuff','custom')),
  notify      text not null default 'inherit' check (notify in ('inherit','all','impact','mute')),
  created_at  timestamptz not null default now(),
  unique (roster_id, player_id)
);
create index if not exists links_player_idx on public.links (player_id);

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  last_ok_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.alerts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,               -- status pregame bye test
  status      text,
  title       text not null,
  lines       jsonb not null default '[]',
  dedupe_key  text unique,
  push        boolean not null default true,
  held_until  timestamptz,
  pushed_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists alerts_user_idx on public.alerts (user_id, created_at desc);
create index if not exists alerts_held_idx on public.alerts (held_until) where pushed_at is null;

-- ---------- row level security ----------

alter table public.nfl_players        enable row level security;
alter table public.player_status      enable row level security;
alter table public.status_events      enable row level security;
alter table public.games              enable row level security;
alter table public.job_state          enable row level security;
alter table public.user_settings      enable row level security;
alter table public.user_teams         enable row level security;
alter table public.roster             enable row level security;
alter table public.links              enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.alerts             enable row level security;

-- shared NFL data: any signed-in user can read, only the backend (service role) writes
create policy "read players"  on public.nfl_players   for select to authenticated using (true);
create policy "read statuses" on public.player_status for select to authenticated using (true);
create policy "read games"    on public.games         for select to authenticated using (true);

-- your own rows only
create policy "own settings" on public.user_settings      for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own teams"    on public.user_teams         for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own roster"   on public.roster             for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and team_id in (select id from public.user_teams where user_id = auth.uid()));
create policy "own links"    on public.links              for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and team_id in (select id from public.user_teams where user_id = auth.uid()));
create policy "own push"     on public.push_subscriptions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "read own alerts"   on public.alerts for select to authenticated using (user_id = auth.uid());
create policy "delete own alerts" on public.alerts for delete to authenticated using (user_id = auth.uid());
