// Practice participation from ESPN injury notes, plus the evening practice digest.
import { benchSnoozed, deliver, loadWatchers, quietHoldUntil, shortName, type Admin, type AlertRow, type Line } from "./core.ts";

export type Practice = "DNP" | "LP" | "FP";
const WORD: Record<Practice, string> = { DNP: "DID NOT PRACTICE", LP: "LIMITED", FP: "FULL" };
const RANK: Record<Practice, number> = { DNP: 0, LP: 1, FP: 2 };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Date + weekday in US Eastern time, where NFL practice reports are dated. */
export function eastern(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday"), hour: Number(get("hour")) };
}
function addDays(iso: string, n: number) {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

/** Read "did not practice / limited / full participant" out of a note, and which day it was. */
export function parsePractice(note: string | null | undefined, now = new Date()): { participation: Practice; date: string } | null {
  if (!note || !/practic|participant|\bDNP\b/i.test(note)) return null;
  let p: Practice | null = null;
  if (/did not practice|didn'?t practice|\bDNP\b|non-?participant|sat out (?:of )?(?:\w+'s )?practice|held out of (?:\w+'s )?practice|missed (?:\w+'s )?practice|absent from (?:\w+'s )?practice|not practicing/i.test(note)) p = "DNP";
  else if (/\blimited\b/i.test(note)) p = "LP";
  else if (/full participant|practiced fully|practiced in full|full practice|fully participated|full participation|a full go/i.test(note)) p = "FP";
  if (!p) return null;
  const today = eastern(now);
  const m = note.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
  let date = today.date;
  if (m) {
    const want = DAYS.findIndex((d) => d.toLowerCase() === m[1].toLowerCase());
    const have = DAYS.indexOf(today.weekday);
    const back = (have - want + 7) % 7;
    date = addDays(today.date, -back);                 // most recent such weekday (today counts)
  }
  return { participation: p, date };
}

/** Save any practice reports found in fresh notes. The first report for a player/day wins. */
export async function savePractice(admin: Admin, notes: { playerId: string; note: string | null }[], now = new Date()) {
  const rows = notes.map((n) => { const r = parsePractice(n.note, now); return r && { player_id: n.playerId, report_date: r.date, participation: r.participation, note: n.note }; })
    .filter(Boolean) as Record<string, unknown>[];
  if (!rows.length) return 0;
  const { data } = await admin.from("practice_reports").upsert(rows, { onConflict: "player_id,report_date", ignoreDuplicates: true }).select("player_id");
  return data?.length ?? 0;
}

/** Evening digest: one alert per user covering today's practice reports for players they care about. */
export async function practiceDigest(admin: Admin, now = new Date()) {
  const et = eastern(now);
  if (et.weekday === "Sunday" || et.hour < 20) return { skipped: "not digest time" };
  const { data: today } = await admin.from("practice_reports").select("*").eq("report_date", et.date);
  if (!today?.length) return { skipped: "no reports today" };
  const ids = today.map((r) => r.player_id);
  const ctx = await loadWatchers(admin, ids);
  if (!ctx) return { sent: 0 };
  // yesterday-or-earlier this week, for the trend arrow
  const { data: earlier } = await admin.from("practice_reports").select("*").in("player_id", ids).lt("report_date", et.date).gte("report_date", addDays(et.date, -6)).order("report_date", { ascending: false });
  const prev = new Map<string, Practice>();
  for (const r of earlier ?? []) if (!prev.has(r.player_id)) prev.set(r.player_id, r.participation);
  const todayBy = new Map(today.map((r) => [r.player_id, r.participation as Practice]));

  const trend = (pid: string) => {
    const now_ = todayBy.get(pid)!, was = prev.get(pid);
    if (!was || was === now_) return "";
    return RANK[now_] > RANK[was] ? ` (up from ${WORD[was].toLowerCase()})` : ` (down from ${WORD[was].toLowerCase()})`;
  };
  const rows: AlertRow[] = [];
  const users = [...new Set(ctx.teams.map((t) => t.user_id))];
  for (const uid of users) {
    const st = ctx.settings.get(uid)!;
    if ((st as any).practice === false) continue;
    const key = `practice:${uid}:${et.date}`;
    const { data: exists } = await admin.from("alerts").select("id").eq("dedupe_key", key).maybeSingle();
    if (exists) continue;
    const lines: Line[] = [];
    for (const t of ctx.teams.filter((x) => x.user_id === uid)) {
      const troster = ctx.roster.filter((r) => r.team_id === t.id && !(r.slot === "bench" && benchSnoozed(t, now)));
      const seen = new Set<string>();
      for (const r of troster) {
        const p = ctx.players.get(r.player_id);
        if (!p || !todayBy.has(p.id) || seen.has(p.id)) continue;
        seen.add(p.id);
        lines.push({ team: t.name, text: `${shortName(p)} ${WORD[todayBy.get(p.id)!]}${trend(p.id)} · ${r.slot === "start" ? "in your lineup" : "on your bench"}` });
      }
      for (const l of ctx.links.filter((x) => x.team_id === t.id && todayBy.has(x.player_id))) {
        const lp = ctx.players.get(l.player_id), r = troster.find((x) => x.id === l.roster_id), fp = r && ctx.players.get(r.player_id);
        if (!lp || !fp || seen.has(lp.id + ":" + fp.id)) continue;
        seen.add(lp.id + ":" + fp.id);
        lines.push({ team: t.name, text: `${shortName(lp)} ${WORD[todayBy.get(lp.id)!]}${trend(lp.id)} → watch ${shortName(fp)}` });
      }
    }
    if (!lines.length) continue;
    const held = quietHoldUntil(st, now);
    rows.push({ user_id: uid, kind: "practice", title: `Practice report · ${et.weekday}`, lines, dedupe_key: key, held_until: held ? held.toISOString() : null, push: true });
  }
  return { sent: await deliver(admin, rows), users: rows.length };
}
