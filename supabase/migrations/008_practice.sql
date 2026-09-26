-- Fantasy Injury Tracker: practice participation (DNP / Limited / Full).
-- Run after 007_league_sync.sql (SQL Editor > New query > paste > Run).
-- Filled from ESPN's injury notes ("was a limited participant in Wednesday's practice").

create table if not exists public.practice_reports (
  player_id      text not null references public.nfl_players(id) on delete cascade,
  report_date    date not null,                          -- the practice day (Eastern time)
  participation  text not null check (participation in ('DNP','LP','FP')),
  note           text,
  source         text not null default 'espn_note',
  created_at     timestamptz not null default now(),
  primary key (player_id, report_date)
);
create index if not exists practice_reports_date_idx on public.practice_reports (report_date);

alter table public.practice_reports enable row level security;
drop policy if exists "read practice" on public.practice_reports;
create policy "read practice" on public.practice_reports for select to authenticated using (true);

-- a switch for the daily practice digest (on by default)
alter table public.user_settings add column if not exists practice boolean not null default true;
