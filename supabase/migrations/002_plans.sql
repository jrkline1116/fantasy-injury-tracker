-- Fantasy Injury Tracker: free vs Pro plans.
-- Run after 001_init.sql (SQL Editor > New query > paste > Run).
-- Plans are OFF for now: free_team_limit() returns 1000, so everyone gets unlimited teams.
-- When Pro launches, change it to 1 (and set PLANS_ENABLED = true in app.js).
-- The plan lives in its own table that users can read but never write,
-- so nobody can upgrade themselves from the browser.

create table if not exists public.accounts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  plan       text not null default 'free' check (plan in ('free','pro')),
  pro_until  timestamptz,                 -- null = Pro with no end date
  source     text,                        -- 'manual', later 'stripe'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.accounts enable row level security;
drop policy if exists "read own account" on public.accounts;
create policy "read own account" on public.accounts for select to authenticated using (user_id = auth.uid());

create or replace function public.free_team_limit() returns int language sql immutable as $$ select 1000 $$;  -- change to 1 when Pro launches

create or replace function public.is_pro(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.accounts
    where user_id = uid and plan = 'pro' and (pro_until is null or pro_until > now())
  );
$$;

create or replace function public.enforce_team_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_pro(new.user_id)
     and (select count(*) from public.user_teams where user_id = new.user_id) >= public.free_team_limit() then
    raise exception 'FREE_TEAM_LIMIT' using hint = 'Free accounts include 1 team. Upgrade to Pro for more.';
  end if;
  return new;
end $$;

drop trigger if exists user_teams_limit on public.user_teams;
create trigger user_teams_limit before insert on public.user_teams
  for each row execute function public.enforce_team_limit();

-- To make yourself Pro for testing, run (with your email):
--   insert into public.accounts (user_id, plan, source)
--   select id, 'pro', 'manual' from auth.users where email = 'you@example.com'
--   on conflict (user_id) do update set plan = 'pro', pro_until = null, updated_at = now();
