// League sync: Sleeper + ESPN + Yahoo. One person links a league, every team is pulled in,
// league-mates claim their team through an invite link, claimed teams stay in sync.
import { addPlayersToTeam, deliver, inChunks, normName, normTeam, type Admin } from "./core.ts";

/* ---------- secrets (ESPN cookies) ---------- */
async function secretKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("LEAGUE_SECRET_KEY");
  if (!raw) throw new Error("League linking isn't set up yet (missing LEAGUE_SECRET_KEY).");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function encryptJson(obj: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await secretKey(), new TextEncoder().encode(JSON.stringify(obj))));
  return b64(iv) + "." + b64(ct);
}
export async function decryptJson<T>(s: string): Promise<T> {
  const [iv, ct] = s.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await secretKey(), unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
type EspnCreds = { espn_s2?: string; swid?: string };

/* ---------- shared shapes ---------- */
export class ReconnectError extends Error {}
type Entry = { extId: string; name: string; team: string | null; pos: string | null; slot: string };
type FetchedTeam = { externalTeamId: string; name: string; manager: string | null; ownerKeys: string[]; entries: Entry[] };
type FetchedLeague = { name: string; teams: FetchedTeam[] };

export function currentSeason(d = new Date()): number {
  return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); // Jan-Feb belong to last season
}
const SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "SFLEX", "DST", "K", "IDP", "BN", "IR"];

/* ---------- Sleeper ---------- */
const SLEEPER = "https://api.sleeper.app/v1";
async function sleeperGet(path: string) {
  const res = await fetch(SLEEPER + path);
  if (!res.ok) throw new Error(`Sleeper returned ${res.status} for ${path}`);
  return res.json();
}
export async function sleeperUserLeagues(username: string) {
  const u = await sleeperGet(`/user/${encodeURIComponent(username)}`);
  if (!u?.user_id) throw new Error("No Sleeper user with that username.");
  const season = currentSeason();
  const leagues = await sleeperGet(`/user/${u.user_id}/leagues/nfl/${season}`);
  return { sleeperUserId: String(u.user_id), season, leagues: (leagues ?? []).map((l: any) => ({ id: String(l.league_id), name: l.name, teams: l.total_rosters })) };
}
const SLEEPER_SLOT: Record<string, string> = {
  QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DST",
  FLEX: "FLEX", WRRB_FLEX: "FLEX", REC_FLEX: "FLEX", WRT_FLEX: "FLEX", SUPER_FLEX: "SFLEX",
  DL: "IDP", LB: "IDP", DB: "IDP", IDP_FLEX: "IDP",
};
export async function fetchSleeper(leagueId: string): Promise<FetchedLeague> {
  const [league, rosters, users] = await Promise.all([
    sleeperGet(`/league/${leagueId}`), sleeperGet(`/league/${leagueId}/rosters`), sleeperGet(`/league/${leagueId}/users`),
  ]);
  if (!league?.league_id) throw new Error("Sleeper league not found.");
  const starterSlots: string[] = (league.roster_positions ?? []).filter((p: string) => !["BN", "IR", "TAXI"].includes(p));
  const userById = new Map((users ?? []).map((u: any) => [String(u.user_id), u]));
  const teams: FetchedTeam[] = (rosters ?? []).map((r: any) => {
    const owner: any = userById.get(String(r.owner_id));
    const starters: string[] = r.starters ?? [];
    const reserve = new Set<string>(r.reserve ?? []);
    const entries: Entry[] = [];
    const placed = new Set<string>();
    starters.forEach((pid, i) => {
      if (!pid || pid === "0") return;
      entries.push({ extId: String(pid), name: "", team: null, pos: null, slot: SLEEPER_SLOT[starterSlots[i]] ?? "FLEX" });
      placed.add(String(pid));
    });
    for (const pid of r.players ?? []) {
      if (placed.has(String(pid))) continue;
      entries.push({ extId: String(pid), name: "", team: null, pos: null, slot: reserve.has(pid) ? "IR" : "BN" });
      placed.add(String(pid));
    }
    return {
      externalTeamId: String(r.roster_id),
      name: owner?.metadata?.team_name || owner?.display_name || `Team ${r.roster_id}`,
      manager: owner?.display_name ?? null,
      ownerKeys: [r.owner_id, ...(r.co_owners ?? [])].filter(Boolean).map(String),
      entries,
    };
  });
  return { name: league.name, teams };
}

/* ---------- ESPN ---------- */
const ESPN_SLOT: Record<number, string> = {
  0: "QB", 1: "QB", 2: "RB", 3: "FLEX", 4: "WR", 5: "FLEX", 6: "TE", 7: "SFLEX",
  8: "IDP", 9: "IDP", 10: "IDP", 11: "IDP", 12: "IDP", 13: "IDP", 14: "IDP", 15: "IDP",
  16: "DST", 17: "K", 20: "BN", 21: "IR", 23: "FLEX", 24: "FLEX",
};
const ESPN_TEAM: Record<number, string> = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN",
  11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX",
  33: "BAL", 34: "HOU",
};
export function parseEspnLeagueId(input: string): string | null {
  const s = String(input ?? "").trim();
  if (/^\d{3,12}$/.test(s)) return s;
  return s.match(/leagueId=(\d{3,12})/i)?.[1] ?? null;
}
export function normSwid(swid?: string) {
  if (!swid) return undefined;
  const s = swid.trim().replace(/^%7B/i, "{").replace(/%7D$/i, "}").toUpperCase();
  return s.startsWith("{") ? s : `{${s}}`;
}
const ESPN_HOSTS = ["https://lm-api-reads.fantasy.espn.com", "https://fantasy.espn.com"];
async function espnGet(leagueId: string, season: number, creds: EspnCreds) {
  const path = `/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam&view=mRoster&view=mSettings`;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "FantasyInjuryTracker/1.0" };
  if (creds.espn_s2 && creds.swid) headers.cookie = `espn_s2=${creds.espn_s2}; SWID=${creds.swid}`;
  const tried: string[] = [];
  for (const host of ESPN_HOSTS) {
    const res = await fetch(host + path, { headers });
    if (res.ok) {
      const text = await res.text();
      try { return JSON.parse(text); } catch { tried.push(`${new URL(host).hostname}: not JSON`); continue; }
    }
    if (res.status === 401 || res.status === 403) {
      tried.push(`${new URL(host).hostname}:${res.status}`);
      continue;
    }
    if (res.status === 404) throw new Error(`ESPN couldn't find league ${leagueId} for ${season}. Check the league URL.`);
    tried.push(`${new URL(host).hostname}:${res.status}`);
  }
  // Private leagues: the API host says 401/403, and the backup host answers with an HTML login page instead
  if (tried.some((t) => /40[13]/.test(t)) && tried.every((t) => /40[13]|not JSON/.test(t))) {
    throw new ReconnectError(creds.espn_s2 ? "ESPN rejected the saved cookies. Reconnect ESPN with fresh espn_s2 and SWID." : "This is a private ESPN league. Add your espn_s2 and SWID cookies.");
  }
  throw new Error(`ESPN request failed (${tried.join(", ")})`);
}
export async function fetchEspn(leagueId: string, season: number, creds: EspnCreds): Promise<FetchedLeague> {
  const d = await espnGet(leagueId, season, creds);
  const members = new Map((d.members ?? []).map((m: any) => [String(m.id).toUpperCase(), m]));
  const teams: FetchedTeam[] = (d.teams ?? []).map((t: any) => {
    const owners: string[] = (t.owners ?? []).map((o: any) => String(o).toUpperCase());
    const m: any = members.get(owners[0]);
    const entries: Entry[] = (t.roster?.entries ?? []).map((e: any) => {
      const p = e.playerPoolEntry?.player ?? {};
      const isDst = p.defaultPositionId === 16 || Number(e.playerId) < 0;
      return {
        extId: isDst ? `DST:${ESPN_TEAM[p.proTeamId] ?? ""}` : String(e.playerId),
        name: p.fullName ?? "",
        team: ESPN_TEAM[p.proTeamId] ?? null,
        pos: isDst ? "DEF" : null,
        slot: ESPN_SLOT[e.lineupSlotId] ?? "BN",
      };
    });
    return {
      externalTeamId: String(t.id),
      name: t.name || [t.location, t.nickname].filter(Boolean).join(" ") || t.abbrev || `Team ${t.id}`,
      manager: m ? (m.displayName || [m.firstName, m.lastName].filter(Boolean).join(" ")) : null,
      ownerKeys: owners,
      entries,
    };
  });
  return { name: d.settings?.name ?? `ESPN league ${leagueId}`, teams };
}

/* ---------- Yahoo ---------- */
// Yahoo uses OAuth: the person signs in on Yahoo's own page and Yahoo sends them to the
// `yahoo` edge function, which stores their tokens (encrypted) in platform_auth. A Yahoo
// league syncs with the tokens of whoever linked it. Yahoo rosters are readable by any
// member of the league, so one connection covers every team.
const Y_AUTH = "https://api.login.yahoo.com/oauth2";
const Y_API = "https://fantasysports.yahooapis.com/fantasy/v2";
type YahooCreds = { access_token: string; refresh_token: string; expires_at: number; guid?: string };

// Where people may be sent back to after signing in with Yahoo (prefix match).
export const APP_URLS = [
  "https://jrkline1116.github.io/fantasy-injury-tracker/",
  "https://fantasyinjuryassist.com/",
  "https://www.fantasyinjuryassist.com/",
  "http://localhost",
  "http://127.0.0.1",
];
function yahooClient() {
  const id = Deno.env.get("YAHOO_CLIENT_ID"), secret = Deno.env.get("YAHOO_CLIENT_SECRET");
  if (!id || !secret) throw new Error("Yahoo linking isn't set up yet (missing YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET).");
  const redirect = Deno.env.get("YAHOO_REDIRECT_URI") || `${Deno.env.get("SUPABASE_URL")}/functions/v1/yahoo`;
  return { id, secret, redirect };
}
const b64u = (u: Uint8Array) => b64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
async function stateKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("LEAGUE_SECRET_KEY");
  if (!raw) throw new Error("League linking isn't set up yet (missing LEAGUE_SECRET_KEY).");
  return crypto.subtle.importKey("raw", new TextEncoder().encode("yahoo-state:" + raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
/** The Yahoo sign-in page URL. `state` is signed so the callback knows which user it's for. */
export async function yahooAuthUrl(userId: string, returnTo: string) {
  const c = yahooClient();
  const back = String(returnTo ?? "");
  if (!APP_URLS.some((u) => back.startsWith(u))) throw new Error("Open the app from its normal address and try again.");
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ u: userId, r: back, t: Date.now() })));
  const sig = b64u(new Uint8Array(await crypto.subtle.sign("HMAC", await stateKey(), new TextEncoder().encode(payload))));
  // ask for Fantasy Sports read access explicitly; newer Yahoo apps otherwise issue sign-in-only tokens
  const q = new URLSearchParams({ client_id: c.id, redirect_uri: c.redirect, response_type: "code", scope: "fspt-r", state: `${payload}.${sig}` });
  return `${Y_AUTH}/request_auth?${q}`;
}
export async function readYahooState(state: string): Promise<{ u: string; r: string; t: number }> {
  const [payload, sig] = String(state ?? "").split(".");
  if (!payload || !sig) throw new Error("That Yahoo sign-in link is incomplete. Start again from the app.");
  const ok = await crypto.subtle.verify("HMAC", await stateKey(), unb64u(sig), new TextEncoder().encode(payload));
  if (!ok) throw new Error("That Yahoo sign-in link isn't valid. Start again from the app.");
  const s = JSON.parse(new TextDecoder().decode(unb64u(payload)));
  if (!APP_URLS.some((u) => String(s.r).startsWith(u))) throw new Error("Unknown return address.");
  return s;
}
async function yahooToken(params: Record<string, string>) {
  const c = yahooClient();
  const res = await fetch(`${Y_AUTH}/get_token`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${c.id}:${c.secret}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ redirect_uri: c.redirect, ...params }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    if (params.grant_type === "refresh_token" && res.status >= 400 && res.status < 500) throw new ReconnectError("Yahoo sign-in expired. Reconnect Yahoo.");
    throw new Error(`Yahoo sign-in failed (${d.error_description || d.error || res.status}).`);
  }
  return d;
}
async function saveYahoo(admin: Admin, userId: string, creds: YahooCreds) {
  const { error } = await admin.from("platform_auth").upsert({ user_id: userId, platform: "yahoo", ciphertext: await encryptJson(creds), updated_at: new Date().toISOString() }, { onConflict: "user_id,platform" });
  if (error) throw error;
}
/** Called by the `yahoo` function after the person approves access on Yahoo. */
export async function yahooConnect(admin: Admin, userId: string, code: string) {
  const d = await yahooToken({ grant_type: "authorization_code", code });
  await saveYahoo(admin, userId, { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + Number(d.expires_in ?? 3600) * 1000, guid: d.xoauth_yahoo_guid });
  // leagues this person linked were paused waiting for them: resume
  await admin.from("leagues").update({ status: "ok", last_error: null }).eq("platform", "yahoo").eq("linked_by", userId).eq("status", "reconnect");
}
async function yahooCreds(admin: Admin, userId: string): Promise<YahooCreds> {
  const { data } = await admin.from("platform_auth").select("ciphertext").eq("user_id", userId).eq("platform", "yahoo").maybeSingle();
  if (!data?.ciphertext) throw new ReconnectError("Yahoo isn't connected. Reconnect Yahoo.");
  let c = await decryptJson<YahooCreds>(data.ciphertext);
  if (c.expires_at - Date.now() < 120_000) {
    const d = await yahooToken({ grant_type: "refresh_token", refresh_token: c.refresh_token });
    c = { ...c, access_token: d.access_token, refresh_token: d.refresh_token || c.refresh_token, expires_at: Date.now() + Number(d.expires_in ?? 3600) * 1000, guid: d.xoauth_yahoo_guid || c.guid };
    await saveYahoo(admin, userId, c);
  }
  return c;
}
export async function yahooConnected(admin: Admin, userId: string) {
  const { data } = await admin.from("platform_auth").select("user_id").eq("user_id", userId).eq("platform", "yahoo").maybeSingle();
  return !!data;
}
async function yahooGet(creds: YahooCreds, path: string) {
  const res = await fetch(`${Y_API}${path}${path.includes("?") ? "&" : "?"}format=json`, { headers: { Authorization: `Bearer ${creds.access_token}`, accept: "application/json" } });
  if (res.status === 401) throw new ReconnectError("Yahoo sign-in expired. Reconnect Yahoo.");
  if (res.status === 403) {
    const body = await res.text().catch(() => "");
    console.error("Yahoo 403", path, body.slice(0, 500));
    throw new ReconnectError("Yahoo didn't give this app access to your fantasy data. Sign in with Yahoo again and tap Agree.");
  }
  if (!res.ok) {
    // pass along Yahoo's own explanation (JSON or XML error body) so problems are diagnosable
    const body = await res.text().catch(() => "");
    let why = "";
    try { const j = JSON.parse(body); why = j?.error?.description ?? j?.error?.message ?? ""; } catch { /* not JSON */ }
    if (!why) why = (body.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? body.match(/oauth_problem="?([a-z_]+)/i)?.[1] ?? "").trim();
    console.error("Yahoo error", res.status, path, body.slice(0, 500));
    throw new Error(`Yahoo returned ${res.status}${why ? `: ${why.slice(0, 200)}` : ""}`);
  }
  return (await res.json())?.fantasy_content;
}
// Yahoo's JSON: collections look like {"0": {team: ...}, "1": {...}, count: 2}, and records are
// arrays of one-key objects ([{team_key}, {name}, ...]) that we merge into one object.
function yItems(coll: any, key: string): any[] {
  if (!coll || typeof coll !== "object") return [];
  return Object.keys(coll).filter((k) => /^\d+$/.test(k)).sort((a, b) => +a - +b).map((k) => coll[k]?.[key]).filter(Boolean);
}
function yMerge(x: any): Record<string, any> {
  const o: Record<string, any> = {};
  const walk = (v: any) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.assign(o, v); };
  walk(x);
  return o;
}
const yPart = (rec: any[], key: string) => (Array.isArray(rec) ? rec.slice(1).find((p) => p && typeof p === "object" && key in p)?.[key] : undefined);

export async function yahooUserLeagues(admin: Admin, userId: string) {
  const creds = await yahooCreds(admin, userId);
  const fc = await yahooGet(creds, "/users;use_login=1/games;game_keys=nfl/leagues");
  const user = yItems(fc?.users, "user")[0];
  const leagues: { id: string; name: string; teams: number }[] = [];
  let season = currentSeason();
  for (const g of yItems(yPart(user, "games"), "game")) {
    const gm = yMerge(Array.isArray(g) ? g[0] : g);
    if (gm.season) season = Number(gm.season);
    for (const l of yItems(yPart(g, "leagues"), "league")) {
      const lm = yMerge(l);
      if (lm.league_key) leagues.push({ id: String(lm.league_key), name: String(lm.name ?? "Yahoo league"), teams: Number(lm.num_teams ?? 0) });
    }
  }
  return { season, leagues };
}
const YAHOO_SLOT: Record<string, string> = {
  QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DST",
  "W/R/T": "FLEX", "W/R": "FLEX", "W/T": "FLEX", "R/T": "FLEX", "Q/W/R/T": "SFLEX",
  D: "IDP", DB: "IDP", DL: "IDP", LB: "IDP", DE: "IDP", DT: "IDP", CB: "IDP", S: "IDP",
  BN: "BN", IR: "IR", "IR+": "IR", NA: "IR",
};
function yahooTeam(t: any, fallbackMeta?: Record<string, any>): FetchedTeam {
  const tm = { ...(fallbackMeta ?? {}), ...yMerge(Array.isArray(t) ? t[0] : t) };
  const mgrs: any[] = Array.isArray(tm.managers) ? tm.managers.map((m: any) => m?.manager).filter(Boolean) : yItems(tm.managers, "manager");
  const roster = yPart(t, "roster");
  const players = yItems(roster?.["0"]?.players ?? roster?.players, "player");
  const entries: Entry[] = players.map((p: any) => {
    const pm = yMerge(p[0]);
    const pos = String(yMerge(yPart(p, "selected_position")).position ?? "BN");
    const team = normTeam(pm.editorial_team_abbr ?? null);
    const isDst = pm.display_position === "DEF" || pm.position_type === "DT";
    return { extId: isDst ? `DST:${team ?? ""}` : String(pm.player_id), name: pm.name?.full ?? "", team, pos: isDst ? "DEF" : (pm.display_position ?? null), slot: YAHOO_SLOT[pos] ?? "BN" };
  });
  return {
    externalTeamId: String(tm.team_key),
    name: String(tm.name ?? `Team ${tm.team_id ?? ""}`),
    manager: mgrs[0]?.nickname ?? null,
    ownerKeys: mgrs.map((m) => String(m.guid ?? "").toUpperCase()).filter(Boolean),
    entries,
  };
}
export async function fetchYahoo(admin: Admin, leagueKey: string, linkerId: string): Promise<FetchedLeague> {
  const creds = await yahooCreds(admin, linkerId);
  try {
    const fc = await yahooGet(creds, `/league/${leagueKey}/teams/roster`);
    const lg = fc?.league;
    const teams = yItems(yPart(lg, "teams"), "team");
    if (teams.length) return { name: String(yMerge(lg[0]).name ?? "Yahoo league"), teams: teams.map((t) => yahooTeam(t)) };
  } catch (e) {
    if (e instanceof ReconnectError) throw e;
  }
  // fallback: list the teams, then read each roster
  const fc = await yahooGet(creds, `/league/${leagueKey}/teams`);
  const lg = fc?.league;
  if (!lg) throw new Error("Yahoo league not found.");
  const metas = yItems(yPart(lg, "teams"), "team").map((t) => yMerge(Array.isArray(t) ? t[0] : t));
  const teams: FetchedTeam[] = [];
  for (const m of metas) {
    const r = await yahooGet(creds, `/team/${m.team_key}/roster`);
    teams.push(yahooTeam(r?.team, m));
  }
  return { name: String(yMerge(lg[0]).name ?? "Yahoo league"), teams };
}

/* ---------- matching platform players to our player list ---------- */
async function matchEntries(admin: Admin, platform: string, teams: FetchedTeam[]) {
  const all = teams.flatMap((t) => t.entries);
  const byExt = new Map<string, string>();
  if (platform === "sleeper") {
    const ids = [...new Set(all.map((e) => e.extId))];
    const found = await inChunks<{ id: string }>(ids, (c) => admin.from("nfl_players").select("id").in("id", c));
    found.forEach((f) => byExt.set(f.id, f.id));
  } else {
    if (platform === "espn") {
      const espnIds = [...new Set(all.filter((e) => !e.extId.startsWith("DST:")).map((e) => e.extId))];
      const found = await inChunks<{ id: string; espn_id: string }>(espnIds, (c) => admin.from("nfl_players").select("id,espn_id").in("espn_id", c));
      found.forEach((f) => byExt.set(f.espn_id, f.id));
    }
    for (const e of all) if (e.extId.startsWith("DST:") && e.team) byExt.set(e.extId, e.team); // our defense ids are team abbreviations
    // match by name + NFL team (Yahoo, and anyone ESPN-id matching missed)
    const missing = all.filter((e) => !byExt.has(e.extId) && e.name);
    const names = [...new Set(missing.map((e) => normName(e.name)))];
    if (names.length) {
      const cands = await inChunks<{ id: string; search_name: string; team: string | null }>(names, (c) => admin.from("nfl_players").select("id,search_name,team").in("search_name", c));
      for (const e of missing) {
        const n = normName(e.name);
        const hits = cands.filter((c) => c.search_name === n);
        const pick = hits.find((c) => c.team === normTeam(e.team)) ?? (hits.length === 1 ? hits[0] : undefined);
        if (pick) byExt.set(e.extId, pick.id);
      }
    }
  }
  if (platform !== "sleeper") {
    const dstIds = [...new Set(all.filter((e) => e.extId.startsWith("DST:")).map((e) => byExt.get(e.extId)).filter(Boolean) as string[])];
    const ok = new Set((await inChunks<{ id: string }>(dstIds, (c) => admin.from("nfl_players").select("id").in("id", c))).map((x) => x.id));
    for (const e of all) if (e.extId.startsWith("DST:") && !ok.has(byExt.get(e.extId) ?? "")) byExt.delete(e.extId);
  }
  return teams.map((t) => {
    const roster: { player_id: string; lineup_slot: string }[] = [];
    const unmatched: string[] = [];
    const seen = new Set<string>();
    for (const e of t.entries) {
      const pid = byExt.get(e.extId);
      if (!pid) { unmatched.push(e.name || e.extId); continue; }
      if (seen.has(pid)) continue;
      seen.add(pid);
      roster.push({ player_id: pid, lineup_slot: e.slot });
    }
    roster.sort((a, b) => SLOT_ORDER.indexOf(a.lineup_slot) - SLOT_ORDER.indexOf(b.lineup_slot));
    return { ...t, roster, unmatched };
  });
}

/* ---------- sync one league ---------- */
const PNAME: Record<string, string> = { espn: "ESPN", sleeper: "Sleeper", yahoo: "Yahoo" };
export async function syncLeague(admin: Admin, league: any, opts: { quiet?: boolean } = {}) {
  let creds: EspnCreds = {};
  if (league.platform === "espn") {
    const { data: sec } = await admin.from("league_secrets").select("ciphertext").eq("league_id", league.id).maybeSingle();
    if (sec?.ciphertext) creds = await decryptJson<EspnCreds>(sec.ciphertext);
  }
  let fetched: FetchedLeague;
  try {
    fetched = league.platform === "sleeper" ? await fetchSleeper(league.external_id)
      : league.platform === "yahoo" ? await fetchYahoo(admin, league.external_id, league.linked_by)
      : await fetchEspn(league.external_id, league.season, creds);
  } catch (e) {
    const reconnect = e instanceof ReconnectError;
    await admin.from("leagues").update({ status: reconnect ? "reconnect" : "error", last_error: (e as Error).message }).eq("id", league.id);
    if (reconnect && !opts.quiet) {
      await deliver(admin, [{
        user_id: league.linked_by, kind: "roster", title: `Reconnect ${league.name}`,
        lines: [{ team: league.name, text: `${PNAME[league.platform] ?? "The league site"} stopped accepting the saved login, so syncing is paused for everyone in this league. Open the team's settings and reconnect ${PNAME[league.platform] ?? ""}.` }],
        dedupe_key: `reconnect:${league.id}:${new Date().toISOString().slice(0, 10)}`, held_until: null, push: true,
      }]);
    }
    throw e;
  }
  const matched = await matchEntries(admin, league.platform, fetched.teams);
  const now = new Date().toISOString();
  const rows = matched.map((t) => ({
    league_id: league.id, external_team_id: t.externalTeamId, name: t.name, manager: t.manager,
    owner_keys: t.ownerKeys, roster: t.roster, unmatched: t.unmatched, synced_at: now,
  }));
  const { data: lts, error } = await admin.from("league_teams").upsert(rows, { onConflict: "league_id,external_team_id" }).select();
  if (error) throw error;
  await admin.from("leagues").update({ name: fetched.name, status: "ok", last_error: null, synced_at: now }).eq("id", league.id);

  // push the fresh rosters into every claimed team
  const { data: claimed } = await admin.from("user_teams").select("*").in("league_team_id", (lts ?? []).map((x) => x.id));
  let changed = 0;
  for (const ut of claimed ?? []) {
    const lt = (lts ?? []).find((x) => x.id === ut.league_team_id);
    if (!lt) continue;
    const r = await applyRoster(admin, ut, lt.roster);
    if ((r.added.length || r.removed.length) && !opts.quiet) {
      changed++;
      const parts = [r.added.length ? `Added ${r.added.join(", ")}.` : "", r.removed.length ? `Removed ${r.removed.join(", ")}.` : ""].filter(Boolean);
      await deliver(admin, [{ user_id: ut.user_id, kind: "roster", title: `${ut.name} roster updated`, lines: [{ team: ut.name, text: parts.join(" ") }], dedupe_key: `roster:${ut.id}:${Date.now()}`, held_until: null, push: false }]);
    }
  }
  return { teams: rows.length, claimed: claimed?.length ?? 0, changed };
}

/** Make a user's team match the league: add, remove, and re-slot players. */
export async function applyRoster(admin: Admin, ut: { id: string; user_id: string }, roster: { player_id: string; lineup_slot: string }[]) {
  const { data: current } = await admin.from("roster").select("id,player_id,lineup_slot,sort").eq("team_id", ut.id);
  const cur = new Map((current ?? []).map((c) => [c.player_id, c]));
  const want = new Map(roster.map((r, i) => [r.player_id, { ...r, sort: i }]));
  const removed = (current ?? []).filter((c) => !want.has(c.player_id));
  if (removed.length) await admin.from("roster").delete().in("id", removed.map((c) => c.id));
  for (const [pid, w] of want) {
    const c = cur.get(pid);
    if (c && (c.lineup_slot !== w.lineup_slot || c.sort !== w.sort)) await admin.from("roster").update({ lineup_slot: w.lineup_slot, sort: w.sort }).eq("id", c.id);
  }
  const adds = [...want.values()].filter((w) => !cur.has(w.player_id)).map((w) => ({ playerId: w.player_id, lineupSlot: w.lineup_slot, sort: w.sort }));
  await addPlayersToTeam(admin, ut, adds);
  const nameOf = async (ids: string[]) => ids.length ? ((await admin.from("nfl_players").select("full_name").in("id", ids)).data ?? []).map((x) => x.full_name) : [];
  return { added: await nameOf(adds.map((a) => a.playerId)), removed: await nameOf(removed.map((c) => c.player_id)) };
}

/* ---------- linking and claiming ---------- */
export async function linkLeague(admin: Admin, userId: string, input: { platform: string; league: string; espn_s2?: string; swid?: string; sleeperUserId?: string }) {
  const platform = input.platform;
  if (!["sleeper", "espn", "yahoo"].includes(platform)) throw new Error("That platform isn't supported yet.");
  const externalId = platform === "espn" ? parseEspnLeagueId(input.league) : String(input.league ?? "").trim();
  if (platform === "yahoo") {
    if (!/^\d+\.l\.\d+$/.test(externalId ?? "")) throw new Error("Pick a Yahoo league.");
  } else if (!externalId || !/^\d+$/.test(externalId)) throw new Error(platform === "espn" ? "Paste the ESPN league URL (it contains leagueId=...)." : "Pick a Sleeper league.");
  if (!externalId) throw new Error("Pick a league.");
  const yahoo = platform === "yahoo" ? await yahooCreds(admin, userId) : null;
  const season = currentSeason();
  const creds: EspnCreds = { espn_s2: input.espn_s2?.trim() || undefined, swid: normSwid(input.swid) };
  if (platform === "espn" && !!creds.espn_s2 !== !!creds.swid) throw new Error("Add both cookies (espn_s2 and SWID), or leave both blank for a public league.");

  let { data: league } = await admin.from("leagues").select("*").eq("platform", platform).eq("external_id", externalId).eq("season", season).maybeSingle();
  const isNew = !league;
  if (!league) {
    const { data, error } = await admin.from("leagues").insert({ platform, external_id: externalId, season, name: `${PNAME[platform]} league`, linked_by: userId }).select().single();
    if (error) throw error;
    league = data;
  }
  // the person who links (or re-links with fresh cookies) becomes the league's connection
  if (platform === "espn" && creds.espn_s2) {
    await admin.from("league_secrets").upsert({ league_id: league.id, ciphertext: await encryptJson(creds), updated_at: new Date().toISOString() });
    if (league.linked_by !== userId) await admin.from("leagues").update({ linked_by: userId }).eq("id", league.id);
    league.linked_by = userId;
  }
  // Yahoo: the person linking now is the connection (their Yahoo sign-in is known to work)
  if (platform === "yahoo" && (league.linked_by !== userId || league.status !== "ok")) {
    await admin.from("leagues").update({ linked_by: userId, status: "ok", last_error: null }).eq("id", league.id);
    league.linked_by = userId; league.status = "ok";
  }
  try {
    await syncLeague(admin, league, { quiet: true });
  } catch (e) {
    if (isNew) await admin.from("leagues").delete().eq("id", league.id);
    throw e;
  }
  // find the linker's own team
  const ownerKey = platform === "espn" ? creds.swid : platform === "yahoo" ? yahoo?.guid : input.sleeperUserId;
  const { data: teams } = await admin.from("league_teams").select("id,owner_keys").eq("league_id", league.id);
  const mine = ownerKey ? (teams ?? []).find((t) => (t.owner_keys ?? []).map((k: string) => k.toUpperCase()).includes(ownerKey.toUpperCase())) : undefined;
  let teamId: string | null = null;
  if (mine) {
    try { teamId = await claimTeam(admin, userId, mine.id, { skipInviteCheck: true }); } catch { /* already claimed by someone else */ }
  }
  return { leagueId: league.id, inviteCode: league.invite_code, teamId };
}

export async function leagueForInvite(admin: Admin, userId: string, code: string) {
  const { data: league } = await admin.from("leagues").select("id,name,platform,status").eq("invite_code", code).maybeSingle();
  if (!league) throw new Error("That invite link isn't valid anymore.");
  const { data: teams } = await admin.from("league_teams").select("id,name,manager").eq("league_id", league.id).order("name");
  const { data: claims } = await admin.from("user_teams").select("league_team_id,user_id").in("league_team_id", (teams ?? []).map((t) => t.id));
  return {
    league,
    teams: (teams ?? []).map((t) => {
      const c = (claims ?? []).find((x) => x.league_team_id === t.id);
      return { ...t, claimed: !!c, mine: c?.user_id === userId };
    }),
  };
}

export async function claimTeam(admin: Admin, userId: string, leagueTeamId: string, opts: { code?: string; skipInviteCheck?: boolean } = {}) {
  const { data: lt } = await admin.from("league_teams").select("*, leagues(*)").eq("id", leagueTeamId).maybeSingle();
  if (!lt) throw new Error("Team not found.");
  const league = (lt as any).leagues;
  if (!opts.skipInviteCheck && league.linked_by !== userId && league.invite_code !== opts.code) throw new Error("You need the league's invite link to claim a team.");
  const { data: existing } = await admin.from("user_teams").select("id,user_id").eq("league_team_id", leagueTeamId).maybeSingle();
  if (existing) {
    if (existing.user_id === userId) return existing.id;
    throw new Error("Someone already claimed that team. Ask the person who linked the league to release it.");
  }
  const { data: mine } = await admin.from("user_teams").select("name").eq("user_id", userId);
  let name = String(lt.name || league.name).slice(0, 40);
  if ((mine ?? []).some((t) => t.name === name)) name = `${lt.name} · ${league.name}`.slice(0, 40);
  const { data: ut, error } = await admin.from("user_teams").insert({ user_id: userId, name, league_team_id: lt.id, sort: (mine ?? []).length }).select().single();
  if (error) throw error;
  await applyRoster(admin, ut, lt.roster ?? []);
  return ut.id as string;
}

/** Everything the team-settings screen needs about a synced team. */
export async function leagueInfo(admin: Admin, userId: string, teamId: string) {
  const { data: ut } = await admin.from("user_teams").select("*").eq("id", teamId).eq("user_id", userId).maybeSingle();
  if (!ut?.league_team_id) return null;
  const { data: lt } = await admin.from("league_teams").select("*, leagues(*)").eq("id", ut.league_team_id).maybeSingle();
  if (!lt) return null;
  const league = (lt as any).leagues;
  const isLinker = league.linked_by === userId;
  let claims: any[] = [];
  if (isLinker) {
    const { data: teams } = await admin.from("league_teams").select("id,name,manager").eq("league_id", league.id).order("name");
    const { data: cl } = await admin.from("user_teams").select("league_team_id,user_id").in("league_team_id", (teams ?? []).map((t) => t.id));
    claims = (teams ?? []).map((t) => ({ ...t, claimed: (cl ?? []).some((c) => c.league_team_id === t.id), mine: (cl ?? []).some((c) => c.league_team_id === t.id && c.user_id === userId) }));
  }
  return {
    platform: league.platform, leagueName: league.name, teamName: lt.name, status: league.status, lastError: league.last_error,
    syncedAt: league.synced_at, isLinker, externalId: league.external_id, inviteCode: isLinker ? league.invite_code : null, leagueId: league.id,
    unmatched: lt.unmatched ?? [], claims,
  };
}
