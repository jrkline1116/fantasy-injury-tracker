-- Fantasy Injury Assist: Monday hold + Tuesday waiver report + weekly auto-clear.
-- Run after 010_yahoo.sql (SQL Editor > New query > paste > Run).
-- Run this BEFORE deploying the api and tick functions from v2.6.0.

-- 1. New switches (both on by default)
alter table public.user_settings add column if not exists hold_monday boolean not null default true;  -- hold Monday news for players who already played
alter table public.user_settings add column if not exists waiver      boolean not null default true;  -- Tuesday waiver report
alter table public.user_settings add column if not exists last_weekly text;                            -- local date of the last Tuesday run (backend only)

-- 2. Alerts remember which player they're about, so Monday's held updates can be rolled into one line each on Tuesday
alter table public.alerts add column if not exists player_id   text;
alter table public.alerts add column if not exists from_status text;
alter table public.alerts add column if not exists monday_hold boolean not null default false;
create index if not exists alerts_monday_idx on public.alerts (user_id) where monday_hold;
