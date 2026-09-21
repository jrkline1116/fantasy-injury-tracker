-- Fantasy Injury Tracker: if/then lineup rules.
-- Run after 002_plans.sql (SQL Editor > New query > paste > Run).
-- Example: "If McConkey is ruled Active, start McConkey over Mike Evans."
-- Rules last one week (expire Tuesday) and fire once.

create table if not exists public.rules (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  team_id            uuid not null references public.user_teams(id) on delete cascade,
  trigger_player_id  text not null references public.nfl_players(id) on delete cascade,
  on_status          text not null check (on_status in ('active','out')),
  start_player_id    text not null references public.nfl_players(id) on delete cascade,
  over_player_id     text not null references public.nfl_players(id) on delete cascade,
  expires_at         timestamptz not null,
  fired_at           timestamptz,
  created_at         timestamptz not null default now(),
  check (start_player_id <> over_player_id)
);
create index if not exists rules_trigger_idx on public.rules (trigger_player_id) where fired_at is null;
create index if not exists rules_team_idx on public.rules (team_id);

alter table public.rules enable row level security;
drop policy if exists "own rules" on public.rules;
create policy "own rules" on public.rules for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and team_id in (select id from public.user_teams where user_id = auth.uid()));
