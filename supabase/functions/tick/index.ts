// Runs every minute from pg_cron. Each job decides for itself whether it's due.
//   Players + depth charts (Sleeper)   once a day
//   Schedule (ESPN scoreboard)         every 3 hours
//   Injury statuses (ESPN)             every 2 min near games, every 15 min otherwise
//   Held quiet-hours alerts            every run
//   Pre-game check                     every run when games are close
//   Bye-week warning                   every 30 min (sends Thursday 9am local)
//   Expired if/then rules cleanup      every hour
import {
  adminClient, byeLines, deliver, fetchAll, inChunks, json, loadUser, loadWatchers,
  localClock, mapStatus, normName, normTeam, pregameLines, pushAlert, statusAlerts,
  type Admin, type AlertRow,
} from "../_shared/core.ts";

const SLEEPER_PLAYERS = "https://api.sleeper.app/v1/players/nfl";
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const ESPN_INJURIES = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries";
const FANTASY_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF", "DL", "DE", "DT", "LB", "DB", "CB", "S"]);

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return new Response("forbidden", { status: 403 });
  const admin = adminClient();
  const now = new Date();
  const log: Record<string, unknown> = {};
  const state = await getState(admin);
  const due = (key: string, minutes: number) => !state[key] || now.getTime() - new Date(state[key]).getTime() >= minutes * 60000 - 5000;
  const run = async (key: string, fn: () => Promise<unknown>) => {
    try { await setState(admin, key, now); log[key] = await fn(); }
    catch (e) { log[key] = `error: ${(e as Error).message ?? e}`; console.error(key, e); }
  };

  if (due("players", 20 * 60)) await run("players", () => syncPlayers(admin));
  if (due("schedule", 180)) await run("schedule", () => syncSchedule(admin));

  const { data: gamesData } = await admin.from("games").select("*")
    .gte("kickoff", new Date(now.getTime() - 5 * 3600e3).toISOString())
    .lte("kickoff", new Date(now.getTime() + 8 * 86400e3).toISOString()).order("kickoff");
  const games = gamesData ?? [];
  const hot = games.some((g) => { const k = new Date(g.kickoff).getTime(); return k - now.getTime() < 3 * 3600e3 && now.getTime() - k < 4 * 3600e3; });

  if (due("injuries", hot ? 2 : 15)) await run("injuries", () => pollInjuries(admin, now, !state.injuries));
  await run("held", () => sendHeld(admin, now));
  if (games.some((g) => { const m = (new Date(g.kickoff).getTime() - now.getTime()) / 60000; return m > 0 && m <= 125; })) {
    await run("pregame", () => pregame(admin, now, games));
  }
  if (due("bye", 30)) await run("bye", () => byeWeek(admin, now, games));
  if (due("cleanup", 60)) await run("cleanup", async () => {
    const { count } = await admin.from("rules").delete({ count: "exact" }).lt("expires_at", new Date(now.getTime() - 86400e3).toISOString());
    return { rulesRemoved: count ?? 0 };
  });

  return json({ ok: true, hot, log });
});

async function getState(admin: Admin): Promise<Record<string, string>> {
  const { data } = await admin.from("job_state").select("key,ran_at");
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.ran_at]));
}
async function setState(admin: Admin, key: string, when: Date) {
  await admin.from("job_state").upsert({ key, ran_at: when.toISOString() });
}

/* ---------- players and depth charts from Sleeper ---------- */
async function syncPlayers(admin: Admin) {
  const res = await fetch(SLEEPER_PLAYERS);
  if (!res.ok) throw new Error(`Sleeper players ${res.status}`);
  const all = await res.json() as Record<string, any>;
  const rows: Record<string, unknown>[] = [];
  for (const p of Object.values(all)) {
    const pos = p.position === "DEF" ? "DEF" : p.position;
    if (!FANTASY_POS.has(pos)) continue;
    if (!p.team && !p.active) continue;
    const full = pos === "DEF" ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() : (p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim());
    if (!full) continue;
    const depthOk = p.depth_chart_position && String(p.depth_chart_position).replace(/^[LR]/, "") === pos;
    rows.push({
      id: String(p.player_id), full_name: full, search_name: normName(full), pos, team: p.team ?? null,
      depth_order: depthOk ? (p.depth_chart_order ?? null) : (pos === "QB" || pos === "RB" ? (p.depth_chart_order ?? null) : null),
      espn_id: p.espn_id ? String(p.espn_id) : null, updated_at: new Date().toISOString(),
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("nfl_players").upsert(rows.slice(i, i + 500), { onConflict: "id" });
    if (error) throw error;
  }
  return { players: rows.length };
}

/* ---------- schedule from ESPN ---------- */
async function syncSchedule(admin: Admin) {
  const res = await fetch(ESPN_SCOREBOARD);
  if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
  const d = await res.json();
  const rows = (d.events ?? []).map((ev: any) => {
    const cs = ev.competitions?.[0]?.competitors ?? [];
    return {
      id: String(ev.id), season: ev.season?.year ?? d.season?.year ?? null, week: ev.week?.number ?? d.week?.number ?? null,
      kickoff: ev.date, state: ev.status?.type?.state ?? null,
      home: normTeam(cs.find((c: any) => c.homeAway === "home")?.team?.abbreviation),
      away: normTeam(cs.find((c: any) => c.homeAway === "away")?.team?.abbreviation),
    };
  }).filter((r: any) => r.home && r.away && r.kickoff);
  if (rows.length) {
    const { error } = await admin.from("games").upsert(rows, { onConflict: "id" });
    if (error) throw error;
  }
  return { games: rows.length };
}

/* ---------- injury statuses from ESPN ---------- */
type Inj = { espnId: string | null; name: string; team: string | null; status: string; detail: string | null };
function extractInjuries(data: unknown): Inj[] {
  const out: Inj[] = [];
  const walk = (o: any, team?: string | null) => {
    if (Array.isArray(o)) { o.forEach((x) => walk(x, team)); return; }
    if (!o || typeof o !== "object") return;
    const here = typeof o.abbreviation === "string" && o.abbreviation.length <= 4 ? o.abbreviation : team;
    if (o.athlete && typeof o.athlete === "object" && typeof o.status === "string") {
      const a = o.athlete;
      const id = a.id ? String(a.id) : (JSON.stringify(a.links ?? "").match(/\/id\/(\d+)/)?.[1] ?? null);
      out.push({ espnId: id, name: a.displayName ?? a.fullName ?? "", team: normTeam(a.team?.abbreviation ?? here ?? null), status: o.status, detail: o.shortComment ?? o.type?.description ?? null });
      return;
    }
    for (const k of Object.keys(o)) walk(o[k], here);
  };
  walk(data);
  return out;
}

async function pollInjuries(admin: Admin, now: Date, firstRun: boolean) {
  const res = await fetch(ESPN_INJURIES, { headers: { "user-agent": "FantasyInjuryTracker/1.0" } });
  if (!res.ok) throw new Error(`ESPN injuries ${res.status}`);
  const entries = extractInjuries(await res.json());
  if (entries.length < 50) throw new Error(`injury feed looked incomplete (${entries.length} entries); skipped`);

  const players = await fetchAll<{ id: string; espn_id: string | null; search_name: string; team: string | null }>(
    (a, b) => admin.from("nfl_players").select("id,espn_id,search_name,team").order("id").range(a, b));
  const byEspn = new Map<string, string>();
  const byName = new Map<string, { id: string; team: string | null }[]>();
  for (const p of players) {
    if (p.espn_id) byEspn.set(p.espn_id, p.id);
    const arr = byName.get(p.search_name) ?? []; arr.push(p); byName.set(p.search_name, arr);
  }

  const rank: Record<string, number> = { ACT: 0, Q: 1, D: 2, O: 3, SUS: 4, IR: 5 };
  const next = new Map<string, { status: string; detail: string | null }>();
  for (const e of entries) {
    let pid = e.espnId ? byEspn.get(e.espnId) : undefined;
    if (!pid) {
      const c = byName.get(normName(e.name)) ?? [];
      pid = (c.find((x) => x.team === e.team) ?? (c.length === 1 ? c[0] : undefined))?.id;
    }
    if (!pid) continue;
    const code = mapStatus(e.status);
    if (code === "ACT") continue;
    const prev = next.get(pid);
    if (!prev || rank[code] > rank[prev.status]) next.set(pid, { status: code, detail: e.detail });
  }

  const current = await fetchAll<{ player_id: string; status: string }>(
    (a, b) => admin.from("player_status").select("player_id,status").neq("status", "ACT").order("player_id").range(a, b));
  const cur = new Map(current.map((c) => [c.player_id, c.status]));
  const changes: { playerId: string; from: string; to: string; eventId?: string | number }[] = [];
  for (const [pid, v] of next) if ((cur.get(pid) ?? "ACT") !== v.status) changes.push({ playerId: pid, from: cur.get(pid) ?? "ACT", to: v.status });
  for (const [pid, s] of cur) if (!next.has(pid)) changes.push({ playerId: pid, from: s, to: "ACT" });

  const clears = changes.filter((c) => c.to === "ACT").length;
  if (!firstRun && clears > 150) throw new Error(`${clears} players cleared at once; feed probably partial, skipped`);

  const stamp = now.toISOString();
  const upserts = changes.map((c) => ({ player_id: c.playerId, status: c.to, detail: next.get(c.playerId)?.detail ?? null, updated_at: stamp }));
  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await admin.from("player_status").upsert(upserts.slice(i, i + 500), { onConflict: "player_id" });
    if (error) throw error;
  }
  if (!changes.length) return { entries: entries.length, changes: 0 };
  const { data: ev } = await admin.from("status_events")
    .insert(changes.map((c) => ({ player_id: c.playerId, from_status: c.from, to_status: c.to }))).select("id,player_id");
  for (const c of changes) c.eventId = ev?.find((x) => x.player_id === c.playerId)?.id;
  if (firstRun) return { entries: entries.length, seeded: changes.length };

  const ctx = await loadWatchers(admin, changes.map((c) => c.playerId));
  if (!ctx) return { entries: entries.length, changes: changes.length, alerts: 0 };
  for (const c of changes) ctx.statuses.set(c.playerId, c.to);
  const pushed = await deliver(admin, statusAlerts(ctx, changes, { now }));
  if (ctx.fired.length) await admin.from("rules").update({ fired_at: now.toISOString() }).in("id", ctx.fired);
  return { entries: entries.length, changes: changes.length, pushed, rulesFired: ctx.fired.length };
}

/* ---------- alerts held for quiet hours ---------- */
async function sendHeld(admin: Admin, now: Date) {
  const { data } = await admin.from("alerts").select("*").is("pushed_at", null).eq("push", true)
    .not("held_until", "is", null).lte("held_until", now.toISOString()).limit(200);
  for (const a of data ?? []) await pushAlert(admin, a);
  return { sent: data?.length ?? 0 };
}

/* ---------- pre-game check ---------- */
async function pregame(admin: Admin, now: Date, games: any[]) {
  const groups = new Map<string, Set<string>>();
  for (const g of games) {
    const mins = (new Date(g.kickoff).getTime() - now.getTime()) / 60000;
    if (mins <= 0 || mins > 125) continue;
    const key = new Date(g.kickoff).toISOString();
    const s = groups.get(key) ?? new Set<string>(); s.add(g.home); s.add(g.away); groups.set(key, s);
  }
  let sent = 0;
  for (const [kick, playing] of groups) {
    const mins = Math.round((new Date(kick).getTime() - now.getTime()) / 60000);
    const pl = await inChunks<{ id: string }>([...playing], (t) => admin.from("nfl_players").select("id").in("team", t), 40);
    const starters = await inChunks<{ user_id: string }>(pl.map((p) => p.id), (ids) => admin.from("roster").select("user_id").eq("slot", "start").in("player_id", ids));
    const users = [...new Set(starters.map((s) => s.user_id))];
    if (!users.length) continue;
    const { data: sets } = await admin.from("user_settings").select("user_id,tx_on,tx_minutes").in("user_id", users);
    const setMap = new Map((sets ?? []).map((s) => [s.user_id, s]));
    for (const uid of users) {
      const s = setMap.get(uid) ?? { tx_on: true, tx_minutes: 10 };
      if (!s.tx_on || mins > s.tx_minutes) continue;
      const key = `pregame:${uid}:${kick}`;
      const { data: exists } = await admin.from("alerts").select("id").eq("dedupe_key", key).maybeSingle();
      if (exists) continue;
      const ctx = await loadUser(admin, uid);
      if (!ctx) continue;
      const lines = pregameLines(ctx, uid, playing);
      if (!lines.length) continue;
      sent += await deliver(admin, [{ user_id: uid, kind: "pregame", title: `Kickoff in ${mins} min`, lines, dedupe_key: key, held_until: null, push: true }]);
    }
  }
  return { sent };
}

/* ---------- bye week (Thursday 9am in each user's time zone) ---------- */
async function byeWeek(admin: Admin, now: Date, games: any[]) {
  const upcoming = games.filter((g) => new Date(g.kickoff).getTime() > now.getTime() - 12 * 3600e3);
  if (!upcoming.length) return { skipped: "no games" };
  const { week, season } = upcoming[0];
  const { data: wk } = await admin.from("games").select("home,away").eq("week", week).eq("season", season);
  const playing = new Set<string>((wk ?? []).flatMap((g) => [g.home, g.away]));
  if (playing.size < 20) return { skipped: "schedule incomplete" };
  const { data: sets } = await admin.from("user_settings").select("user_id,bye,timezone").eq("bye", true);
  const rows: AlertRow[] = [];
  for (const s of sets ?? []) {
    const { min, weekday } = localClock(s.timezone, now);
    if (weekday !== "Thu" || min < 9 * 60) continue;
    const key = `bye:${s.user_id}:${season}-${week}`;
    const { data: exists } = await admin.from("alerts").select("id").eq("dedupe_key", key).maybeSingle();
    if (exists) continue;
    const ctx = await loadUser(admin, s.user_id);
    if (!ctx) continue;
    const lines = byeLines(ctx, s.user_id, playing);
    if (lines.length) rows.push({ user_id: s.user_id, kind: "bye", title: `Week ${week} bye-week check`, lines, dedupe_key: key, held_until: null, push: true });
  }
  return { sent: await deliver(admin, rows) };
}
