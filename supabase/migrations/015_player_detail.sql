-- Fantasy Injury Assist 2.9.0: tap a player on the injury report for details.
-- Run in Supabase > SQL Editor > New query > paste > Run, BEFORE deploying tick and api. Safe to run more than once.
--
-- 1. nfl_players gets the injury itself (body part + start date) from Sleeper's player data (tick fills it).
-- 2. injury_report() (013/014) now also returns that body part, e.g. "Concussion".
-- 3. player_detail(id): public, read-only. One player's designation history, recent practice days and next game.
--    Public NFL facts only, like injury_report().
-- 4. player_news_cache: the api function's 15-minute cache of each player's latest news (signed-in users only).
--    No policies, so only the backend can read or write it.

alter table public.nfl_players add column if not exists injury_body_part text;   -- "Ankle", "Concussion"
alter table public.nfl_players add column if not exists injury_start     date;   -- when Sleeper says it started

create table if not exists public.player_news_cache (
  player_id   text primary key references public.nfl_players(id) on delete cascade,
  fetched_at  timestamptz not null default now(),
  items       jsonb not null default '[]'::jsonb
);
alter table public.player_news_cache enable row level security;

create or replace function public.injury_report()
returns json
language sql
stable
security definer
set search_path = public
as $$
  with hurt as (
    select p.id, p.full_name, p.pos, p.team, p.injury_body_part, s.status, s.updated_at
    from player_status s
    join nfl_players p on p.id = s.player_id
    where s.status <> 'ACT'
      and p.pos in ('QB','RB','WR','TE','K')
      and p.team is not null
  ),
  since as (                       -- most recent change into the current designation
    select distinct on (e.player_id) e.player_id, e.from_status, e.created_at
    from status_events e
    join hurt h on h.id = e.player_id and e.to_status = h.status
    order by e.player_id, e.created_at desc
  ),
  lastg as (                       -- each team's most recent game that has kicked off (Eastern date)
    select t.team, max((t.kickoff at time zone 'America/New_York')::date) as gday
    from (select home as team, kickoff from games union all select away as team, kickoff from games) t
    where t.kickoff <= now()
    group by t.team
  ),
  prac as (                        -- this week's practice reports (since the last game), oldest first
    select r.player_id,
           json_agg(json_build_object('d', r.report_date, 'p', r.participation) order by r.report_date) as days
    from practice_reports r
    join hurt h on h.id = r.player_id
    left join lastg lg on lg.team = h.team
    where r.report_date > coalesce(lg.gday, (now() at time zone 'America/New_York')::date - 7)
      and r.report_date >= (now() at time zone 'America/New_York')::date - 10
    group by r.player_id
  ),
  nxt as (                         -- each team's next (or current) game
    select distinct on (t.team) t.team, g.kickoff, g.home, g.away, g.state
    from (select home as team, * from games union all select away as team, * from games) t
    join games g on g.id = t.id
    where g.kickoff > now() - interval '5 hours' and coalesce(g.state, 'pre') <> 'post'
    order by t.team, g.kickoff
  )
  select json_build_object(
    'generated_at', now(),
    'last_change', (select max(updated_at) from player_status),
    'players', coalesce((
      select json_agg(json_build_object(
        'id', h.id, 'name', h.full_name, 'pos', h.pos, 'team', h.team, 'status', h.status, 'injury', h.injury_body_part,
        'since', coalesce(si.created_at, h.updated_at), 'from', si.from_status,
        'practice', pr.days,
        'opp', case when n.team is null then null when n.home = h.team then n.away else '@' || n.home end,
        'kickoff', n.kickoff, 'live', n.state = 'in'
      ))
      from hurt h
      left join since si on si.player_id = h.id
      left join prac pr on pr.player_id = h.id
      left join nxt n on n.team = h.team
    ), '[]'::json)
  );
$$;

revoke all on function public.injury_report() from public;
grant execute on function public.injury_report() to anon, authenticated;


create or replace function public.player_detail(pid text)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with p as (
    select p.id, p.full_name, p.pos, p.team, p.espn_id, p.injury_body_part, p.injury_start,
           coalesce(s.status, 'ACT') as status, s.updated_at
    from nfl_players p left join player_status s on s.player_id = p.id
    where p.id = pid
  ),
  nxt as (
    select g.kickoff, g.home, g.away, g.state
    from games g, p
    where (g.home = p.team or g.away = p.team)
      and g.kickoff > now() - interval '5 hours' and coalesce(g.state, 'pre') <> 'post'
    order by g.kickoff limit 1
  )
  select case when not exists (select 1 from p) then null else json_build_object(
    'id', p.id, 'name', p.full_name, 'pos', p.pos, 'team', p.team, 'espn_id', p.espn_id,
    'status', p.status, 'injury', p.injury_body_part, 'injury_start', p.injury_start,
    'history', coalesce((
      select json_agg(json_build_object('at', e.created_at, 'from', e.from_status, 'to', e.to_status) order by e.created_at desc)
      from (select * from status_events where player_id = pid and created_at > now() - interval '60 days'
            order by created_at desc limit 20) e
    ), '[]'::json),
    'practice', coalesce((
      select json_agg(json_build_object('d', r.report_date, 'p', r.participation) order by r.report_date desc)
      from practice_reports r
      where r.player_id = pid and r.report_date >= (now() at time zone 'America/New_York')::date - 21
    ), '[]'::json),
    'opp', (select case when n.home = p.team then n.away else '@' || n.home end from nxt n),
    'kickoff', (select n.kickoff from nxt n),
    'live', (select n.state = 'in' from nxt n)
  ) end
  from p;
$$;

revoke all on function public.player_detail(text) from public;
grant execute on function public.player_detail(text) to anon, authenticated;
