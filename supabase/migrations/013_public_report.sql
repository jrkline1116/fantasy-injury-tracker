-- Fantasy Injury Assist 2.8.1: public injury report (injuries.html), readable without signing in.
-- Run in Supabase > SQL Editor > New query > paste > Run. Safe to run more than once.
--
-- Signed-out visitors get ONE read-only function, not access to any table. It returns only
-- public NFL facts: name, position, team, designation, when it changed, practice participation
-- (DNP/LP/FP by day) and the next game. No user data, and no ESPN news text (the detail/note
-- columns stay private because that wording belongs to ESPN).

create or replace function public.injury_report()
returns json
language sql
stable
security definer
set search_path = public
as $$
  with hurt as (
    select p.id, p.full_name, p.pos, p.team, s.status, s.updated_at
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
  prac as (                        -- this week's practice reports, oldest first
    select r.player_id,
           json_agg(json_build_object('d', r.report_date, 'p', r.participation) order by r.report_date) as days
    from practice_reports r
    join hurt h on h.id = r.player_id
    where r.report_date >= (now() at time zone 'America/New_York')::date - 6
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
        'id', h.id, 'name', h.full_name, 'pos', h.pos, 'team', h.team, 'status', h.status,
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
