// Called by the app (signed-in users only). Actions:
//   addPlayers  add players to a team with automatic QB and handcuff links
//   simulate    send yourself a test alert for a status change (doesn't change real data)
//   pregameNow  send yourself a pre-game check right now
//   testPush    send a plain test notification
import { addPlayersToTeam, adminClient, cors, deliver, json, loadUser, pregameLines, sendPush, statusAlerts, type Admin } from "../_shared/core.ts";

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
        const n = await sendPush(admin, user.id, { title: "Fantasy Injury Tracker", body: "Notifications are working on this device.", tag: "test", url: "./#alerts" });
        return json({ devices: n });
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
