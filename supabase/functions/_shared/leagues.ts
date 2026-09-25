// League sync: Sleeper + ESPN. One person links a league, every team is pulled in,
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
  if (tried.every((t) => /40[13]/.test(t))) {
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

/* ---------- matching platform players to our player list ---------- */
async function matchEntries(admin: Admin, platform: string, teams: FetchedTeam[]) {
  const all = teams.flatMap((t) => t.entries);
  const byExt = new Map<string, string>();
  if (platform === "sleeper") {
    const ids = [...new Set(all.map((e) => e.extId))];
    const found = await inChunks<{ id: string }>(ids, (c) => admin.from("nfl_players").select("id").in("id", c));
    found.forEach((f) => byExt.set(f.id, f.id));
  } else {
    const espnIds = [...new Set(all.filter((e) => !e.extId.startsWith("DST:")).map((e) => e.extId))];
    const found = await inChunks<{ id: string; espn_id: string }>(espnIds, (c) => admin.from("nfl_players").select("id,espn_id").in("espn_id", c));
    found.forEach((f) => byExt.set(f.espn_id, f.id));
    for (const e of all) if (e.extId.startsWith("DST:") && e.team) byExt.set(e.extId, e.team); // our defense ids are team abbreviations
    // name fallback for anyone ESPN-id matching missed
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
  if (platform === "espn") {
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
export async function syncLeague(admin: Admin, league: any, opts: { quiet?: boolean } = {}) {
  let creds: EspnCreds = {};
  if (league.platform === "espn") {
    const { data: sec } = await admin.from("league_secrets").select("ciphertext").eq("league_id", league.id).maybeSingle();
    if (sec?.ciphertext) creds = await decryptJson<EspnCreds>(sec.ciphertext);
  }
  let fetched: FetchedLeague;
  try {
    fetched = league.platform === "sleeper" ? await fetchSleeper(league.external_id) : await fetchEspn(league.external_id, league.season, creds);
  } catch (e) {
    const reconnect = e instanceof ReconnectError;
    await admin.from("leagues").update({ status: reconnect ? "reconnect" : "error", last_error: (e as Error).message }).eq("id", league.id);
    if (reconnect && !opts.quiet) {
      await deliver(admin, [{
        user_id: league.linked_by, kind: "roster", title: `Reconnect ${league.name}`,
        lines: [{ team: league.name, text: "ESPN stopped accepting the saved login, so syncing is paused for everyone in this league. Open the team's settings and reconnect ESPN." }],
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
  if (!["sleeper", "espn"].includes(platform)) throw new Error("That platform isn't supported yet.");
  const externalId = platform === "espn" ? parseEspnLeagueId(input.league) : String(input.league ?? "").trim();
  if (!externalId || !/^\d+$/.test(externalId)) throw new Error(platform === "espn" ? "Paste the ESPN league URL (it contains leagueId=...)." : "Pick a Sleeper league.");
  const season = currentSeason();
  const creds: EspnCreds = { espn_s2: input.espn_s2?.trim() || undefined, swid: normSwid(input.swid) };
  if (platform === "espn" && !!creds.espn_s2 !== !!creds.swid) throw new Error("Add both cookies (espn_s2 and SWID), or leave both blank for a public league.");

  let { data: league } = await admin.from("leagues").select("*").eq("platform", platform).eq("external_id", externalId).eq("season", season).maybeSingle();
  const isNew = !league;
  if (!league) {
    const { data, error } = await admin.from("leagues").insert({ platform, external_id: externalId, season, name: `${platform === "espn" ? "ESPN" : "Sleeper"} league`, linked_by: userId }).select().single();
    if (error) throw error;
    league = data;
  }
  // the person who links (or re-links with fresh cookies) becomes the league's connection
  if (platform === "espn" && creds.espn_s2) {
    await admin.from("league_secrets").upsert({ league_id: league.id, ciphertext: await encryptJson(creds), updated_at: new Date().toISOString() });
    if (league.linked_by !== userId) await admin.from("leagues").update({ linked_by: userId }).eq("id", league.id);
    league.linked_by = userId;
  }
  try {
    await syncLeague(admin, league, { quiet: true });
  } catch (e) {
    if (isNew) await admin.from("leagues").delete().eq("id", league.id);
    throw e;
  }
  // find the linker's own team
  const ownerKey = platform === "espn" ? creds.swid : input.sleeperUserId;
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
