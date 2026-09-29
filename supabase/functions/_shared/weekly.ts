// Tuesday morning (8am in each user's time zone), once per user per week:
//   1. Waiver report: your Out / Doubtful / IR / suspended players and your starters on bye next week,
//      each with a suggested backup. In linked leagues the backup is marked available or taken.
//   2. Monday updates: the latest status for each player whose news was held on Monday (one line each).
//   3. Auto-clear: every older alert in the user's history is removed, so each week starts fresh.
import { fetchAll, inChunks, loadUser, localClock, quietHoldUntil, deliver, shortName, word, WEEKLY_MIN, defaultSettings, type Admin, type AlertRow, type Ctx, type Line, type Player, type Settings } from "./core.ts";

const BAD = new Set(["O", "D", "IR", "SUS"]);
const SKIP_POS = new Set(["DL", "DE", "DT", "LB", "DB", "CB", "S"]); // IDP: no suggestions
// how deep on a depth chart a player can be and still be worth suggesting without a trending signal
const DEPTH_OK: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 99 };

type Pool = { players: (Player & { status: string })[]; trending: Map<string, number> };

/** Local YYYY-MM-DD in a time zone. */
function localDate(tz: string, d: Date) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
  catch { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
}

/** Sleeper's most-added players (last 3 days). Sleeper ids are our player ids. Best-effort: empty on failure. */
async function trendingAdds(): Promise<Map<string, number>> {
  try {
    const res = await fetch("https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=72&limit=300");
    if (!res.ok) return new Map();
    const rows = await res.json() as { player_id: string; count: number }[];
    return new Map(rows.map((r) => [String(r.player_id), Number(r.count) || 0]));
  } catch { return new Map(); }
}

/** Next week's schedule: which teams play, and the week number. Null if the schedule isn't loaded yet. */
async function nextWeek(admin: Admin, now: Date) {
  const { data: first } = await admin.from("games").select("week,season").gt("kickoff", now.toISOString()).order("kickoff").limit(1).maybeSingle();
  if (!first?.week) return null;
  const { data: wk } = await admin.from("games").select("home,away").eq("week", first.week).eq("season", first.season);
  const playing = new Set<string>((wk ?? []).flatMap((g) => [g.home, g.away]));
  if (playing.size < 20) return null; // schedule incomplete: skip the bye section rather than guess
  return { week: first.week as number, playing };
}

export async function weeklyJob(admin: Admin, now = new Date()) {
  const sets = await fetchAll<Settings>((a, b) => admin.from("user_settings").select("*").order("user_id").range(a, b));
  const due = sets.map((s) => ({ ...defaultSettings(s.user_id), ...s })).filter((s) => {
    const { min, weekday } = localClock(s.timezone, now);
    return weekday === "Tue" && min >= WEEKLY_MIN && s.last_weekly !== localDate(s.timezone, now);
  });
  if (!due.length) return { skipped: "nobody due" };

  let pool: Pool | null = null, nw: Awaited<ReturnType<typeof nextWeek>> | undefined;
  let reports = 0, cleared = 0;
  for (const st of due) {
    const today = localDate(st.timezone, now);
    // mark first so a crash can't cause a second report
    await admin.from("user_settings").update({ last_weekly: today }).eq("user_id", st.user_id);
    try {
      const lines: Line[] = [];
      const ctx = await loadUser(admin, st.user_id);
      if (st.waiver !== false && ctx) {
        if (nw === undefined) nw = await nextWeek(admin, now);
        if (!pool) pool = await loadPool(admin);
        lines.push(...await waiverLines(admin, ctx, st.user_id, pool, nw));
      }
      const held = await heldLines(admin, st.user_id);
      if (held.length) lines.push(...held);
      if (lines.length || (st.waiver !== false && ctx)) {
        const title = st.waiver !== false && ctx ? `${nw ? `Week ${nw.week} ` : ""}waiver report` : "Monday updates";
        if (!lines.length) lines.push({ team: "", text: "All clear: no injured players and no starters on bye next week." });
        const q = quietHoldUntil(st, now);
        const row: AlertRow = { user_id: st.user_id, kind: "report", title, lines, dedupe_key: `report:${st.user_id}:${today}`, held_until: q ? q.toISOString() : null, push: true };
        reports += await deliver(admin, [row]);
      }
      // weekly auto-clear: everything older than this report
      const { count } = await admin.from("alerts").delete({ count: "exact" }).eq("user_id", st.user_id).neq("kind", "report").lt("created_at", now.toISOString());
      await admin.from("alerts").delete().eq("user_id", st.user_id).eq("kind", "report").neq("dedupe_key", `report:${st.user_id}:${today}`);
      cleared += count ?? 0;
    } catch (e) { console.error("weekly", st.user_id, e); }
  }
  return { users: due.length, reports, cleared };
}

/* ---------- Monday updates: one line per held player, with his latest status ---------- */
async function heldLines(admin: Admin, userId: string): Promise<Line[]> {
  const { data } = await admin.from("alerts").select("player_id,from_status,kind,lines,created_at").eq("user_id", userId).eq("monday_hold", true).order("created_at");
  const by = new Map<string, { from: string; team: string; statusChanged: boolean }>();
  for (const a of data ?? []) {
    if (!a.player_id) continue;
    const e = by.get(a.player_id) ?? { from: a.from_status ?? "ACT", team: a.lines?.[0]?.team ?? "", statusChanged: false };
    if (a.kind === "status") e.statusChanged = true;
    by.set(a.player_id, e);
  }
  if (!by.size) return [];
  const ids = [...by.keys()];
  const [pl, stt] = await Promise.all([
    inChunks<Player>(ids, (c) => admin.from("nfl_players").select("id,full_name,pos,team,depth_order").in("id", c)),
    inChunks<{ player_id: string; status: string; detail: string | null }>(ids, (c) => admin.from("player_status").select("player_id,status,detail").in("player_id", c)),
  ]);
  const P = new Map(pl.map((p) => [p.id, p])), S = new Map(stt.map((s) => [s.player_id, s]));
  const out: Line[] = [];
  for (const [pid, e] of by) {
    const p = P.get(pid); if (!p) continue;
    const cur = S.get(pid)?.status ?? "ACT", note = S.get(pid)?.detail;
    const head = `Monday update · ${shortName(p)} ${p.pos}, ${p.team ?? "FA"}`;
    const status = e.statusChanged && e.from !== cur ? `${word(e.from)} → ${word(cur)}` : word(cur);
    out.push({ team: e.team, text: `${head} · ${status}${note && cur !== "ACT" ? ` · ${note}` : ""}` });
  }
  return out;
}

/* ---------- waiver report ---------- */
async function loadPool(admin: Admin): Promise<Pool> {
  const [trending, players] = await Promise.all([
    trendingAdds(),
    fetchAll<Player>((a, b) => admin.from("nfl_players").select("id,full_name,pos,team,depth_order").in("pos", ["QB", "RB", "WR", "TE", "K", "DEF"]).not("team", "is", null).order("id").range(a, b)),
  ]);
  const st = await fetchAll<{ player_id: string; status: string }>((a, b) => admin.from("player_status").select("player_id,status").neq("status", "ACT").order("player_id").range(a, b));
  const stMap = new Map(st.map((s) => [s.player_id, s.status]));
  return { trending, players: players.map((p) => ({ ...p, status: stMap.get(p.id) ?? "ACT" })) };
}

/** Everyone rostered in the league each of this user's linked teams belongs to (null for manual teams). */
async function leagueRostered(admin: Admin, teams: any[]): Promise<Map<string, Set<string> | null>> {
  const out = new Map<string, Set<string> | null>();
  const linked = teams.filter((t) => t.league_team_id);
  for (const t of teams) out.set(t.id, null);
  if (!linked.length) return out;
  const { data: lts } = await admin.from("league_teams").select("id,league_id").in("id", linked.map((t) => t.league_team_id));
  const leagueIds = [...new Set((lts ?? []).map((x) => x.league_id))];
  const { data: all } = leagueIds.length ? await admin.from("league_teams").select("league_id,roster").in("league_id", leagueIds) : { data: [] };
  const byLeague = new Map<string, Set<string>>();
  for (const r of all ?? []) {
    const s = byLeague.get(r.league_id) ?? new Set<string>();
    for (const e of (r.roster ?? []) as { player_id: string }[]) s.add(e.player_id);
    byLeague.set(r.league_id, s);
  }
  for (const t of linked) {
    const lid = (lts ?? []).find((x) => x.id === t.league_team_id)?.league_id;
    out.set(t.id, lid ? byLeague.get(lid) ?? null : null);
  }
  return out;
}

async function waiverLines(admin: Admin, ctx: Ctx, userId: string, pool: Pool, nw: { week: number; playing: Set<string> } | null): Promise<Line[]> {
  const lines: Line[] = [];
  const teams = ctx.teams.filter((t) => t.user_id === userId);
  const rostered = await leagueRostered(admin, teams);
  const onBye = (p?: Player | null) => !!nw && !!p?.team && !nw.playing.has(p.team);
  const trend = (id: string) => pool.trending.get(id) ?? 0;

  for (const t of teams) {
    const mine = ctx.roster.filter((r) => r.team_id === t.id);
    const mineIds = new Set(mine.map((r) => r.player_id));
    const league = rostered.get(t.id) ?? null;
    const tag = (id: string) => mineIds.has(id) ? "on your roster" : league ? (league.has(id) ? "taken" : "available") : "check waivers";
    const used = new Set<string>(); // don't suggest the same pickup twice for one team

    /** Best healthy free agent at a position whose team plays next week. */
    const bestAvailable = (pos: string): Player | null => {
      const cands = pool.players.filter((p) => p.pos === pos && !BAD.has(p.status) && !onBye(p) && !mineIds.has(p.id) && !used.has(p.id)
        && !(league && league.has(p.id)) && (trend(p.id) > 0 || (p.depth_order ?? 99) <= (DEPTH_OK[pos] ?? 1)));
      cands.sort((a, b) => trend(b.id) - trend(a.id) || (a.depth_order ?? 99) - (b.depth_order ?? 99));
      return cands[0] ?? null;
    };
    /** The player behind him on his NFL team's depth chart (inherits the work). */
    const nextManUp = (p: Player): Player | null => {
      if (!["QB", "RB", "WR", "TE"].includes(p.pos) || p.depth_order == null) return null;
      const mates = pool.players.filter((x) => x.team === p.team && x.pos === p.pos && x.id !== p.id && !BAD.has(x.status) && (x.depth_order ?? 99) > (p.depth_order ?? 0) && x.depth_order != null);
      mates.sort((a, b) => (a.depth_order! - b.depth_order!) || trend(b.id) - trend(a.id));
      return mates[0] ?? null;
    };
    /** A healthy bench player of yours at the same position who plays next week. */
    const ownCover = (p: Player): Player | null => {
      for (const r of mine) {
        if (r.slot !== "bench" || r.lineup_slot === "IR") continue;
        const x = ctx.players.get(r.player_id);
        if (x && x.id !== p.id && x.pos === p.pos && !BAD.has(ctx.statuses.get(x.id) ?? "ACT") && !onBye(x) && !used.has(x.id)) return x;
      }
      return null;
    };
    const suggest = (p: Player, injured: boolean): string => {
      if (SKIP_POS.has(p.pos)) return "";
      const own = ownCover(p);
      if (own) { used.add(own.id); return ` · backup: ${own.full_name} (your bench)`; }
      const nmu = injured && !onBye(p) ? nextManUp(p) : null;
      if (nmu && tag(nmu.id) !== "taken") { used.add(nmu.id); return ` · backup: ${nmu.full_name} (${tag(nmu.id)})`; }
      const fa = bestAvailable(p.pos);
      if (fa) { used.add(fa.id); return ` · backup: ${fa.full_name}, ${fa.team} (${tag(fa.id)})${nmu ? `; ${shortName(nmu)} is taken` : ""}`; }
      return nmu ? ` · backup: ${nmu.full_name} (taken)` : "";
    };

    // injured / suspended: starters first, then bench
    const sorted = [...mine].sort((a, b) => (a.slot === "start" ? 0 : 1) - (b.slot === "start" ? 0 : 1) || (a.sort ?? 0) - (b.sort ?? 0));
    const listed = new Set<string>();
    for (const r of sorted) {
      const p = ctx.players.get(r.player_id); if (!p) continue;
      const s = ctx.statuses.get(p.id) ?? "ACT";
      if (!BAD.has(s)) continue;
      listed.add(p.id);
      const where = r.lineup_slot === "IR" ? "in IR slot" : r.slot === "start" ? "starter" : "bench";
      lines.push({ team: t.name, text: `${shortName(p)} ${p.pos} ${word(s)} (${where})${r.lineup_slot === "IR" ? "" : suggest(p, true)}` });
    }
    // starters on bye next week
    if (nw) {
      for (const r of sorted) {
        if (r.slot !== "start") continue;
        const p = ctx.players.get(r.player_id);
        if (!p || listed.has(p.id) || !onBye(p)) continue;
        lines.push({ team: t.name, text: `${shortName(p)} ${p.pos} ON BYE week ${nw.week}${suggest(p, false)}` });
      }
    }
  }
  return lines;
}
