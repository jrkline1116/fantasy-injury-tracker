// Called by the app (signed-in users only). Actions:
//   addPlayers  add players to a team with automatic QB and handcuff links
//   simulate    send yourself a test alert for a status change (doesn't change real data)
//   pregameNow  send yourself a pre-game check right now
//   testPush    send a plain test notification
//   sleeperLeagues / linkLeague / leagueForInvite / claimTeam / leagueInfo /
//   syncLeagueNow / releaseClaim / unlinkTeam   league sync (Sleeper + ESPN + Yahoo)
//   yahooStart / yahooLeagues                    Yahoo sign-in and league list
//   deleteAccount                                 erase the account and everything tied to it
import { addPlayersToTeam, adminClient, cors, deliver, json, loadUser, pregameLines, sendPush, statusAlerts, type Admin } from "../_shared/core.ts";
import { claimTeam, leagueForInvite, leagueInfo, linkLeague, ReconnectError, sleeperUserLeagues, syncLeague, yahooAuthUrl, yahooConnected, yahooDiagnose, yahooUserLeagues } from "../_shared/leagues.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = adminClient();
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth } = await admin.auth.getUser(token);
    const user = auth?.user;
    if (!user) return json({ error: "Your session expired. Sign in again." }, 401);
    const body = await req.json().catch(() => ({}));

    switch (body.action) {
      case "addPlayers": {
        const team = await ownTeam(admin, user.id, body.teamId);
        const players = (Array.isArray(body.players) ? body.players : []).slice(0, 60)
          .map((p: any) => ({ playerId: String(p.playerId), lineupSlot: String(p.lineupSlot ?? "BN"), sort: Number(p.sort ?? 0) }));
        const ins = await addPlayersToTeam(admin, team, players);
        return json({ added: ins.length, roster: ins });
      }
      case "simulate": {
        const ctx = await loadUser(admin, user.id);
        if (!ctx) return json({ error: "Add a player first." }, 400);
        const pid = String(body.playerId), to = String(body.status);
        let from = ctx.statuses.get(pid) ?? "ACT";
        if (from === to) from = to === "ACT" ? "O" : "ACT";
        ctx.statuses.set(pid, to);
        const rows = statusAlerts(ctx, [{ playerId: pid, from, to }], { now: new Date(), test: true });
        if (!rows.length) return json({ pushed: 0, note: "Your notification settings filter this change out, so no alert would be sent." });
        return json({ pushed: await deliver(admin, rows) });
      }
      case "pregameNow": {
        const ctx = await loadUser(admin, user.id);
        const lines = ctx ? pregameLines(ctx, user.id, null) : [];
        if (!lines.length) return json({ pushed: 0, note: "No starters to check yet." });
        return json({ pushed: await deliver(admin, [{ user_id: user.id, kind: "test", title: "Test: pre-game check", lines, dedupe_key: `test:${crypto.randomUUID()}`, held_until: null, push: true }]) });
      }
      case "testPush": {
        const n = await sendPush(admin, user.id, { title: "Fantasy Injury Assist", body: "Notifications are working on this device.", tag: "test", url: "./#alerts" });
        return json({ devices: n });
      }
      case "sleeperLeagues": {
        const name = String(body.username ?? "").trim();
        if (!/^[A-Za-z0-9_]{1,40}$/.test(name)) return json({ error: "Enter your Sleeper username." }, 400);
        const r = await sleeperUserLeagues(name);
        const { data: linked } = await admin.from("leagues").select("external_id").eq("platform", "sleeper").eq("season", r.season).in("external_id", r.leagues.map((l: any) => l.id));
        return json({ ...r, alreadyLinked: (linked ?? []).map((x) => x.external_id) });
      }
      case "yahooCheck": return json(await yahooDiagnose(admin, user.id));
      case "yahooStart": return json({ url: await yahooAuthUrl(user.id, String(body.returnTo ?? "")) });
      case "yahooLeagues": {
        if (!(await yahooConnected(admin, user.id))) return json({ connected: false });
        try {
          const r = await yahooUserLeagues(admin, user.id);
          const { data: linked } = r.leagues.length
            ? await admin.from("leagues").select("external_id").eq("platform", "yahoo").eq("season", r.season).in("external_id", r.leagues.map((l) => l.id))
            : { data: [] };
          return json({ connected: true, ...r, alreadyLinked: (linked ?? []).map((x: any) => x.external_id) });
        } catch (e) {
          if (e instanceof ReconnectError) return json({ connected: false, note: e.message });
          throw e;
        }
      }
      case "linkLeague": return json(await linkLeague(admin, user.id, body));
      case "leagueForInvite": return json(await leagueForInvite(admin, user.id, String(body.code ?? "")));
      case "claimTeam": return json({ teamId: await claimTeam(admin, user.id, String(body.leagueTeamId), { code: String(body.code ?? "") }) });
      case "leagueInfo": return json(await leagueInfo(admin, user.id, String(body.teamId)));
      case "syncLeagueNow": {
        const info = await leagueInfo(admin, user.id, String(body.teamId));
        if (!info) return json({ error: "That team isn't linked to a league." }, 400);
        const { data: league } = await admin.from("leagues").select("*").eq("id", info.leagueId).single();
        return json(await syncLeague(admin, league, { quiet: true }));
      }
      case "releaseClaim": {
        const { data: lt } = await admin.from("league_teams").select("id, leagues(linked_by)").eq("id", String(body.leagueTeamId)).maybeSingle();
        if (!lt || (lt as any).leagues?.linked_by !== user.id) return json({ error: "Only the person who linked the league can release teams." }, 403);
        await admin.from("user_teams").update({ league_team_id: null }).eq("league_team_id", lt.id);
        return json({ ok: true });
      }
      case "unlinkTeam": {
        await admin.from("user_teams").update({ league_team_id: null }).eq("id", String(body.teamId)).eq("user_id", user.id);
        return json({ ok: true });
      }
      case "deleteAccount": {
        // Leagues this person linked: hand them to another member who claimed a team, so the
        // league keeps working for everyone else. Their own ESPN cookies / Yahoo login go with them.
        const { data: mine } = await admin.from("leagues").select("id,platform").eq("linked_by", user.id);
        for (const l of mine ?? []) {
          const { data: lts } = await admin.from("league_teams").select("id").eq("league_id", l.id);
          const { data: heir } = await admin.from("user_teams").select("user_id").in("league_team_id", (lts ?? []).map((x) => x.id)).neq("user_id", user.id).limit(1).maybeSingle();
          if (!heir) continue; // nobody else uses it: deleted along with the account
          await admin.from("league_secrets").delete().eq("league_id", l.id);
          const update: Record<string, unknown> = { linked_by: heir.user_id };
          if (l.platform === "yahoo") Object.assign(update, { status: "reconnect", last_error: "The person who linked this league deleted their account. Reconnect Yahoo to keep syncing." });
          await admin.from("leagues").update(update).eq("id", l.id);
        }
        const { error } = await admin.auth.admin.deleteUser(user.id);
        if (error) throw error;
        return json({ ok: true });
      }
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message ?? String(e) }, 500);
  }
});

async function ownTeam(admin: Admin, userId: string, teamId: string) {
  const { data } = await admin.from("user_teams").select("*").eq("id", teamId).eq("user_id", userId).maybeSingle();
  if (!data) throw new Error("Team not found.");
  return data;
}
