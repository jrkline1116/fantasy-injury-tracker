// Shared helpers for the tick (scheduled) and api (app) functions.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

export type Admin = SupabaseClient;
export type Line = { team: string; text: string };
export type AlertRow = {
  user_id: string; kind: string; status?: string | null; title: string; lines: Line[];
  dedupe_key: string; held_until: string | null; push: boolean;
};

export function adminClient(): Admin {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/* ---------- statuses ---------- */
export const WONT_PLAY = new Set(["O", "IR", "SUS"]);
const LABELS: Record<string, string> = { ACT: "Active", Q: "Questionable", D: "Doubtful", O: "Out", IR: "Injured reserve", SUS: "Suspended" };
export const label = (s: string) => LABELS[s] ?? s;

export function mapStatus(raw?: string | null): string {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s || s === "active" || s === "probable") return "ACT";
  if (s.includes("suspen")) return "SUS";
  if (s.includes("reserve") || s === "ir" || s.startsWith("ir-") || s.includes("physically unable") || s === "pup" ||
      s.includes("non-football") || s === "nfi" || s === "cov") return "IR";
  if (s.startsWith("out")) return "O";
  if (s.startsWith("doubt")) return "D";
  if (s.startsWith("quest") || s.includes("day-to-day") || s.includes("game time")) return "Q";
  return "ACT";
}

/* ---------- names and teams ---------- */
export function normName(s: string): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'’`]/g, "").replace(/-/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
const TEAM_FIX: Record<string, string> = { WSH: "WAS", JAC: "JAX", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };
export const normTeam = (t?: string | null) => (t ? (TEAM_FIX[t.toUpperCase()] ?? t.toUpperCase()) : null);

/* ---------- small utilities ---------- */
export async function fetchAll<T>(build: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: unknown }>, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += page) {
    const { data, error } = await build(i, i + page - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return out;
}
export async function inChunks<T>(ids: string[], q: (ids: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>, size = 150): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) {
    const { data, error } = await q(ids.slice(i, i + size));
    if (error) throw error;
    out.push(...(data ?? []));
  }
  return out;
}

/* ---------- settings and quiet hours ---------- */
export type Settings = {
  user_id: string; mode: string; tx_on: boolean; tx_minutes: number; upside: boolean; bye: boolean;
  quiet_on: boolean; quiet_start: string; quiet_end: string; timezone: string;
};
export const defaultSettings = (user_id: string): Settings => ({
  user_id, mode: "all", tx_on: true, tx_minutes: 10, upside: true, bye: true,
  quiet_on: true, quiet_start: "22:00", quiet_end: "07:00", timezone: "America/Phoenix",
});
export function localClock(tz: string, d = new Date()): { min: number; weekday: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return { min: Number(get("hour")) * 60 + Number(get("minute")), weekday: get("weekday") };
}
const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
export function quietHoldUntil(s: Settings, now = new Date()): Date | null {
  if (!s.quiet_on) return null;
  const { min } = localClock(s.timezone, now);
  const a = toMin(s.quiet_start), b = toMin(s.quiet_end);
  if (a === b) return null;
  const inside = a < b ? (min >= a && min < b) : (min >= a || min < b);
  if (!inside) return null;
  return new Date(now.getTime() + ((b - min + 1440) % 1440) * 60000);
}

/* ---------- loading a user's teams ---------- */
export type Player = { id: string; full_name: string; pos: string; team: string | null; depth_order: number | null };
export type Ctx = {
  teams: any[]; roster: any[]; links: any[]; rules: any[];
  settings: Map<string, Settings>; players: Map<string, Player>; statuses: Map<string, string>;
  fired: string[]; // rule ids fired while building alerts
};

export async function loadTeams(admin: Admin, teamIds: string[]): Promise<Ctx> {
  const nowIso = new Date().toISOString();
  const [t, r, l, ru] = await Promise.all([
    admin.from("user_teams").select("*").in("id", teamIds),
    admin.from("roster").select("*").in("team_id", teamIds),
    admin.from("links").select("*").in("team_id", teamIds),
    admin.from("rules").select("*").in("team_id", teamIds).is("fired_at", null).gt("expires_at", nowIso),
  ]);
  const teams = t.data ?? [], roster = r.data ?? [], links = l.data ?? [], rules = ru.data ?? [];
  const userIds = [...new Set(teams.map((x) => x.user_id))];
  const pids = [...new Set([
    ...roster.map((x) => x.player_id), ...links.map((x) => x.player_id),
    ...rules.flatMap((x) => [x.trigger_player_id, x.start_player_id, x.over_player_id]),
  ])];
  const [s, p, st] = await Promise.all([
    admin.from("user_settings").select("*").in("user_id", userIds),
    inChunks<Player>(pids, (ids) => admin.from("nfl_players").select("id,full_name,pos,team,depth_order").in("id", ids)),
    inChunks<{ player_id: string; status: string }>(pids, (ids) => admin.from("player_status").select("player_id,status").in("player_id", ids)),
  ]);
  const settings = new Map<string, Settings>();
  for (const u of userIds) settings.set(u, defaultSettings(u));
  for (const row of s.data ?? []) settings.set(row.user_id, { ...defaultSettings(row.user_id), ...row });
  return {
    teams, roster, links, rules, settings, fired: [],
    players: new Map(p.map((x) => [x.id, x])),
    statuses: new Map(st.map((x) => [x.player_id, x.status])),
  };
}

export async function loadWatchers(admin: Admin, playerIds: string[], onlyUser?: string): Promise<Ctx | null> {
  if (!playerIds.length) return null;
  const teamIds = new Set<string>();
  for (const [table, col] of [["roster", "player_id"], ["links", "player_id"], ["rules", "trigger_player_id"]]) {
    const rows = await inChunks<{ team_id: string }>(playerIds, (ids) => {
      let q = admin.from(table).select("team_id").in(col, ids);
      if (onlyUser) q = q.eq("user_id", onlyUser);
      return q;
    });
    rows.forEach((x) => teamIds.add(x.team_id));
  }
  return teamIds.size ? loadTeams(admin, [...teamIds]) : null;
}

export async function loadUser(admin: Admin, userId: string): Promise<Ctx | null> {
  const { data } = await admin.from("user_teams").select("id").eq("user_id", userId);
  return data?.length ? loadTeams(admin, data.map((x) => x.id)) : null;
}

/* ---------- alert engine ----------
   Every alert uses one format:
     title:  "<Trigger> <STATUS>"                      e.g. "Burrow OUT"
     lines:  "→ <Your player> UPGRADE|DOWNGRADE · <action>"
             "In your lineup · <action>" / "On your bench · <action>"   (when the trigger is your own player)
             "RULE → start <A> over <B>"                                (your if/then rules)
*/
type Change = { playerId: string; from: string; to: string; eventId?: string | number };

const WORD: Record<string, string> = { ACT: "ACTIVE", Q: "QUESTIONABLE", D: "DOUBTFUL", O: "OUT", IR: "IR", SUS: "SUSPENDED" };
export const word = (s: string) => WORD[s] ?? s;
const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;
export function shortName(p: Player): string {
  if (p.pos === "DEF") return p.full_name;
  const t = p.full_name.split(/\s+/).filter((x) => !SUFFIX.test(x));
  return t.length > 1 ? t[t.length - 1] : p.full_name;
}
/** Short names for two players, falling back to full names if they'd look the same. */
function names(a: Player, b: Player): [string, string] {
  const sa = shortName(a), sb = shortName(b);
  return sa === sb ? [a.full_name, b.full_name] : [sa, sb];
}

const RANK: Record<string, number> = { ACT: 0, Q: 1, D: 2, O: 3, SUS: 3, IR: 4 };
/** What kind of move this is, so the wording can match it. */
function classify(from: string, to: string) {
  return {
    out: WONT_PLAY.has(to) && !WONT_PLAY.has(from),           // ruled out / IR / suspended
    back: !WONT_PLAY.has(to) && WONT_PLAY.has(from),          // out -> can play again (maybe still Q/D)
    clear: to === "ACT" && from !== "ACT",                     // fully cleared
    up: (RANK[to] ?? 0) < (RANK[from] ?? 0),                   // trending better
    down: (RANK[to] ?? 0) > (RANK[from] ?? 0),                 // trending worse
  };
}
const going = (from: string, to: string) => classify(from, to).out;
/** "Out or cleared": ruled out, back to playing, or fully cleared. Skips new Questionable/Doubtful tags. */
function isImpact(from: string, to: string) { const m = classify(from, to); return m.out || m.back || m.clear; }
const lower = (s: string) => word(s).toLowerCase();

function level(st: Settings, team: any, r: any, l: any): string {
  if (l && l.notify !== "inherit") return l.notify;
  if (r && r.notify !== "inherit") return r.notify;
  if (team.notify !== "inherit") return team.notify;
  return st.mode;
}
function wants(lv: string, from: string, to: string): boolean {
  if (lv === "off" || lv === "mute") return false;
  if (lv === "all") return true;
  return isImpact(from, to);
}
function ruleMet(rule: any, from: string, to: string) {
  return rule.on_status === "active" ? (to === "ACT" && from !== "ACT") : going(from, to);
}
function ruleLine(ctx: Ctx, rule: any): string | null {
  const a = ctx.players.get(rule.start_player_id), b = ctx.players.get(rule.over_player_id);
  if (!a || !b) return null;
  const [sa, sb] = names(a, b);
  return `RULE → start ${sa} over ${sb}`;
}

export function benchSnoozed(team: any, now = new Date()) {
  return !!team.bench_snooze_until && new Date(team.bench_snooze_until).getTime() > now.getTime();
}

/** Injury news: a watched injured player's report changed (same status). One alert per player per new note. */
export function newsAlerts(ctx: Ctx, items: { playerId: string; note: string }[], opts: { now: Date }): AlertRow[] {
  const out: AlertRow[] = [];
  const hash = (t: string) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  for (const it of items) {
    const pl = ctx.players.get(it.playerId);
    const status = ctx.statuses.get(it.playerId) ?? "ACT";
    if (!pl || !it.note || status === "ACT") continue;
    const byUser = new Map<string, Line[]>();
    for (const t of ctx.teams) {
      const st = ctx.settings.get(t.user_id)!;
      if ((st as any).news === false) continue;
      const benchQuiet = benchSnoozed(t, opts.now);
      const add = (text: string) => { const a = byUser.get(t.user_id) ?? []; a.push({ team: t.name, text }); byUser.set(t.user_id, a); };
      const troster = ctx.roster.filter((r) => r.team_id === t.id);
      for (const r of troster.filter((r) => r.player_id === it.playerId)) {
        if (r.slot === "bench" && benchQuiet) continue;
        const lv = level(st, t, r, null);
        if (lv === "off" || lv === "mute") continue;
        add(`${r.slot === "start" ? "In your lineup" : "On your bench"} · ${it.note}`);
      }
      for (const l of ctx.links.filter((x) => x.team_id === t.id && x.player_id === it.playerId)) {
        const r = troster.find((x) => x.id === l.roster_id), fp = r && ctx.players.get(r.player_id);
        if (!r || !fp || (r.slot === "bench" && benchQuiet)) continue;
        const lv = level(st, t, r, l);
        if (lv === "off" || lv === "mute") continue;
        add(`→ watch ${names(pl, fp)[1]} · ${it.note}`);
      }
    }
    for (const [uid, lines] of byUser) {
      const held = quietHoldUntil(ctx.settings.get(uid)!, opts.now);
      out.push({
        user_id: uid, kind: "news", status, title: `${shortName(pl)} ${pl.pos}, ${pl.team ?? "FA"} · ${word(status)} · update`,
        lines, dedupe_key: `news:${uid}:${it.playerId}:${hash(it.note)}`, held_until: held ? held.toISOString() : null, push: true,
      });
    }
  }
  return out;
}

export function statusAlerts(ctx: Ctx, changes: Change[], opts: { now: Date; test?: boolean }): AlertRow[] {
  const out: AlertRow[] = [];
  for (const ch of changes) {
    const pl = ctx.players.get(ch.playerId);
    if (!pl) continue;
    const m = classify(ch.from, ch.to), isOut = m.out;
    const byUser = new Map<string, { lines: Line[]; urgent: boolean }>();

    for (const t of ctx.teams) {
      const st = ctx.settings.get(t.user_id)!;
      const add = (text: string, urgent = false) => {
        const e = byUser.get(t.user_id) ?? { lines: [], urgent: false };
        e.lines.push({ team: t.name, text }); e.urgent ||= urgent; byUser.set(t.user_id, e);
      };
      const troster = ctx.roster.filter((r) => r.team_id === t.id);
      const tlinks = ctx.links.filter((l) => l.team_id === t.id);
      const benchQuiet = benchSnoozed(t, opts.now);

      // 1. your if/then rules (always fire; they're explicit)
      let ruleFired = false;
      for (const rule of ctx.rules.filter((x) => x.team_id === t.id && x.trigger_player_id === ch.playerId)) {
        if (!ruleMet(rule, ch.from, ch.to)) continue;
        const line = ruleLine(ctx, rule);
        if (!line) continue;
        add(line, true); ruleFired = true;
        if (!opts.test) ctx.fired.push(rule.id);
      }

      // 2. the trigger is on your roster
      for (const r of troster.filter((r) => r.player_id === ch.playerId)) {
        if (r.slot === "bench" && benchQuiet) continue;
        if (!wants(level(st, t, r, null), ch.from, ch.to)) continue;
        const starting = r.slot === "start";
        const where = starting ? "In your lineup" : "On your bench";
        if (!ruleFired) {
          if (m.out) add(`${where} · ${starting ? "swap him out" : "no change needed"}`);
          else if (m.clear) add(`${where} · ${starting ? "cleared to play" : "cleared to play, consider starting"}`);
          else if (m.up) add(`${where} · trending up, still ${lower(ch.to)}`);
          else if (m.down && ch.to === "D") add(`${where} · ${starting ? "doubtful, line up a backup" : "doubtful, unlikely to play"}`);
          else if (m.down) add(`${where} · ${lower(ch.to)}, ${starting ? "monitor before kickoff" : "monitor"}`);
          else add(`${where} · ${lower(ch.to)}`);
        }
        // his handcuff moves up
        if (m.out && starting && st.upside) {
          for (const hc of tlinks.filter((l) => l.roster_id === r.id && l.kind === "handcuff")) {
            const hp = ctx.players.get(hc.player_id);
            if (!hp || (hp.depth_order ?? 99) < (pl.depth_order ?? 99)) continue; // linked RB is the starter, not a handcuff
            const owned = troster.find((x) => x.player_id === hc.player_id);
            const ownedLinksBack = owned && tlinks.some((l) => l.roster_id === owned.id && l.player_id === pl.id);
            if (ownedLinksBack) continue; // that player's own link reports it
            add(`→ ${names(hp, pl)[0]} UPGRADE · ${owned ? (owned.slot === "bench" ? "start him" : "keep him in") : "check waivers"}`);
          }
        }
      }

      // 3. the trigger is linked to one of your players
      for (const l of tlinks.filter((l) => l.player_id === ch.playerId)) {
        const r = troster.find((x) => x.id === l.roster_id);
        const fp = r && ctx.players.get(r.player_id);
        if (!r || !fp) continue;
        if (r.slot === "bench" && benchQuiet) continue;
        if (!wants(level(st, t, r, l), ch.from, ch.to)) continue;
        const [trig, f] = names(pl, fp);
        const starting = r.slot === "start";
        if (l.kind === "handcuff" || l.kind === "teammate") {
          const ahead = (pl.depth_order ?? 99) < (fp.depth_order ?? 99);
          if (!ahead) continue; // a player behind yours doesn't change your player's role
          const gain = fp.pos === "RB" ? "more work" : fp.pos === "QB" ? "the start" : "more targets";
          if (m.out) { if (!st.upside) continue; add(`→ ${f} UPGRADE · ${gain}, ${starting ? "keep him in" : "consider starting"}`); }
          else if (m.clear) add(`→ ${f} DOWNGRADE · ${starting ? "consider benching" : "keep him benched"}`);
          else if (m.up) add(`→ ${f} WATCH · ${trig} trending up, still ${lower(ch.to)}`);
          else if (m.down) add(`→ ${f} WATCH · ${trig} ${lower(ch.to)}, could open up ${gain}`);
        } else {
          if (m.out) add(`→ ${f} DOWNGRADE · ${starting ? "consider benching" : "keep him benched"}`);
          else if (m.clear) add(`→ ${f} UPGRADE · ${starting ? "good to go" : "consider starting"}`);
          else if (m.up) add(`→ ${f} WATCH · ${trig} trending up, still ${lower(ch.to)}`);
          else if (m.down) add(`→ ${f} WATCH · ${trig} ${lower(ch.to)}, ${starting ? "monitor before kickoff" : "monitor"}`);
        }
      }
    }

    for (const [uid, e] of byUser) {
      const st = ctx.settings.get(uid)!;
      const held = isOut || e.urgent || opts.test ? null : quietHoldUntil(st, opts.now);
      out.push({
        user_id: uid, kind: opts.test ? "test" : "status", status: ch.to,
        title: `${opts.test ? "Test: " : ""}${shortName(pl)} ${pl.pos}, ${pl.team ?? "FA"} · ${word(ch.from)} → ${word(ch.to)}`,
        lines: e.lines,
        dedupe_key: opts.test ? `test:${crypto.randomUUID()}` : `status:${uid}:${ch.playerId}:${ch.eventId ?? Date.now()}`,
        held_until: held ? held.toISOString() : null, push: true,
      });
    }
  }
  return out;
}

export function pregameLines(ctx: Ctx, userId: string, playing: Set<string> | null): Line[] {
  const lines: Line[] = [];
  const inWindow = (p?: Player) => !!p && (!playing || (!!p.team && playing.has(p.team)));
  for (const t of ctx.teams.filter((t) => t.user_id === userId)) {
    const starters = ctx.roster.filter((r) => r.team_id === t.id && r.slot === "start" && inWindow(ctx.players.get(r.player_id)));
    const rules = ctx.rules.filter((x) => x.team_id === t.id && inWindow(ctx.players.get(x.trigger_player_id)));
    if (!starters.length && !rules.length) continue;
    const issues: string[] = [];
    for (const r of starters) {
      const p = ctx.players.get(r.player_id)!;
      const s = ctx.statuses.get(p.id) ?? "ACT";
      if (WONT_PLAY.has(s)) issues.push(`${shortName(p)} ${word(s)} · swap him out`);
      else if (s !== "ACT") issues.push(`${shortName(p)} ${word(s)} · decide now`);
      for (const l of ctx.links.filter((l) => l.roster_id === r.id && l.kind !== "handcuff" && l.notify !== "mute")) {
        const lp = ctx.players.get(l.player_id);
        const ls = ctx.statuses.get(l.player_id) ?? "ACT";
        if (lp && WONT_PLAY.has(ls)) { const [a, b] = names(lp, p); issues.push(`${a} ${word(ls)} → ${b} DOWNGRADE`); }
      }
    }
    for (const rule of rules) {
      const tp = ctx.players.get(rule.trigger_player_id)!;
      const s = ctx.statuses.get(tp.id) ?? "ACT";
      const met = rule.on_status === "active" ? s === "ACT" : WONT_PLAY.has(s);
      const decided = rule.on_status === "active" ? WONT_PLAY.has(s) : s === "ACT";
      if (met) { const line = ruleLine(ctx, rule); if (line) issues.push(line); }
      else if (!decided) issues.push(`Rule waiting: ${shortName(tp)} still ${word(s)}`);
    }
    lines.push({ team: t.name, text: issues.length ? issues.join(" | ") : "All clear. Every starter in this window is active." });
  }
  return lines;
}

export function byeLines(ctx: Ctx, userId: string, playing: Set<string>): Line[] {
  const lines: Line[] = [];
  for (const t of ctx.teams.filter((t) => t.user_id === userId)) {
    const onBye = ctx.roster.filter((r) => r.team_id === t.id && r.slot === "start")
      .map((r) => ctx.players.get(r.player_id)).filter((p): p is Player => !!p && !!p.team && !playing.has(p.team));
    if (onBye.length) lines.push({ team: t.name, text: `${onBye.map((p) => shortName(p)).join(", ")} ON BYE · swap ${onBye.length === 1 ? "him" : "them"} out` });
  }
  return lines;
}

/* ---------- push delivery ---------- */
let vapidReady = false;
export async function sendPush(admin: Admin, userId: string, payload: Record<string, unknown>): Promise<number> {
  if (!vapidReady) {
    webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT")!, Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);
    vapidReady = true;
  }
  const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", userId);
  let ok = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      ok++;
      await admin.from("push_subscriptions").update({ last_ok_at: new Date().toISOString() }).eq("id", s.id);
    } catch (e) {
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push failed", code, (e as { body?: string })?.body ?? String(e));
    }
  }
  return ok;
}

export async function pushAlert(admin: Admin, a: { id: string; user_id: string; kind: string; title: string; lines: Line[] }) {
  const body = a.lines.map((l) => (l.team ? `${l.team}: ${l.text}` : l.text)).join("\n");
  const sent = await sendPush(admin, a.user_id, { title: a.title, body, tag: a.kind === "pregame" ? "pregame" : a.id, url: "./#alerts" });
  await admin.from("alerts").update({ pushed_at: new Date().toISOString() }).eq("id", a.id);
  return sent;
}

/** Insert alerts (duplicates by dedupe_key are skipped) and push the new ones that aren't held for quiet hours. */
export async function deliver(admin: Admin, rows: AlertRow[]): Promise<number> {
  if (!rows.length) return 0;
  const { data, error } = await admin.from("alerts").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true }).select();
  if (error) throw error;
  let n = 0;
  for (const a of data ?? []) if (a.push && !a.held_until) { await pushAlert(admin, a); n++; }
  return n;
}

/* ---------- adding players with automatic links ---------- */
export const LINEUP_SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "SFLEX", "DST", "K", "IDP", "BN"];
export async function addPlayersToTeam(admin: Admin, team: { id: string; user_id: string }, adds: { playerId: string; lineupSlot?: string; sort?: number }[]) {
  if (!adds.length) return [];
  const rows = adds.map((a, i) => {
    const lineup_slot = LINEUP_SLOTS.includes(a.lineupSlot ?? "") ? a.lineupSlot! : "BN";
    return { user_id: team.user_id, team_id: team.id, player_id: a.playerId, lineup_slot, slot: lineup_slot === "BN" ? "bench" : "start", sort: Number.isInteger(a.sort) ? a.sort : i };
  });
  const { data: ins, error } = await admin.from("roster").upsert(rows, { onConflict: "team_id,player_id", ignoreDuplicates: true }).select();
  if (error) throw error;
  if (!ins?.length) return [];
  const { data: pl } = await admin.from("nfl_players").select("id,pos,team,depth_order").in("id", ins.map((r) => r.player_id));
  const nflTeams = [...new Set((pl ?? []).filter((p) => p.team && ["WR", "TE", "RB"].includes(p.pos)).map((p) => p.team))];
  if (!nflTeams.length) return ins;
  const { data: depth } = await admin.from("nfl_players").select("id,pos,team,depth_order")
    .in("team", nflTeams).in("pos", ["QB", "RB", "WR", "TE"]).not("depth_order", "is", null).order("depth_order");
  const linkRows: Record<string, unknown>[] = [];
  for (const r of ins) {
    const p = (pl ?? []).find((x) => x.id === r.player_id);
    if (!p?.team) continue;
    if (p.pos === "WR" || p.pos === "TE") {
      const qb = (depth ?? []).find((d) => d.team === p.team && d.pos === "QB");
      if (qb) linkRows.push({ user_id: team.user_id, team_id: team.id, roster_id: r.id, player_id: qb.id, kind: "qb" });
    }
    if (["RB", "WR", "TE"].includes(p.pos)) {
      const mates = (depth ?? []).filter((d) => d.team === p.team && d.pos === p.pos && d.id !== p.id);
      const mine = p.depth_order ?? 99;
      const ahead = mates.filter((d) => (d.depth_order ?? 99) < mine).pop();     // the one directly ahead
      const behind = mates.find((d) => (d.depth_order ?? 99) > mine);            // his handcuff
      const target = ahead ?? behind;
      if (target) linkRows.push({ user_id: team.user_id, team_id: team.id, roster_id: r.id, player_id: target.id, kind: ahead ? "teammate" : "handcuff" });
    }
  }
  if (linkRows.length) await admin.from("links").upsert(linkRows, { onConflict: "roster_id,player_id", ignoreDuplicates: true });
  return ins;
}

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
