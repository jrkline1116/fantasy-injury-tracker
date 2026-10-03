-- Fantasy Injury Assist: snooze one roster player (and his linked players) from the bell on the Teams screen.
-- Run after 011_weekly.sql (SQL Editor > New query > paste > Run), BEFORE deploying api and tick from v2.8.0.
alter table public.roster add column if not exists snooze_until timestamptz;  -- null = not snoozed
