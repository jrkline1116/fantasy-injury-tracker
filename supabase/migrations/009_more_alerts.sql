-- Fantasy Injury Tracker: louder defaults + bench snooze + injury news alerts.
-- Run after 008_practice.sql (SQL Editor > New query > paste > Run).

-- 1. Default to "Everything" (every status change). Users can turn it down in Settings.
alter table public.user_settings alter column mode set default 'all';
update public.user_settings set mode = 'all' where mode = 'impact';

-- 2. Injury news: an alert whenever a watched injured player's report changes (on by default)
alter table public.user_settings add column if not exists news boolean not null default true;

-- 3. Snooze bench-player alerts per team (null = on; a date = snoozed until then)
alter table public.user_teams add column if not exists bench_snooze_until timestamptz;
