-- Fantasy Injury Tracker: lineup grid.
-- Run after 003_rules.sql (SQL Editor > New query > paste > Run).
-- Each roster row gets a lineup slot (QB, RB, WR, TE, FLEX, SFLEX, DST, K, IDP, BN)
-- and a row position. "slot" (start/bench), which the alert engine uses,
-- is set automatically from the lineup slot: BN = bench, anything else = starting.

alter table public.roster add column if not exists lineup_slot text not null default 'BN';
alter table public.roster add column if not exists sort int not null default 0;
alter table public.roster drop constraint if exists roster_lineup_slot_check;
alter table public.roster add constraint roster_lineup_slot_check
  check (lineup_slot in ('QB','RB','WR','TE','FLEX','SFLEX','DST','K','IDP','BN'));

update public.roster set lineup_slot = 'FLEX' where slot = 'start' and lineup_slot = 'BN';

create or replace function public.roster_sync_slot() returns trigger
language plpgsql as $$
begin
  new.slot := case when new.lineup_slot = 'BN' then 'bench' else 'start' end;
  return new;
end $$;

drop trigger if exists roster_slot on public.roster;
create trigger roster_slot before insert or update on public.roster
  for each row execute function public.roster_sync_slot();
