/* Fantasy Injury Tracker — app */
"use strict";
const APP_VERSION = "2.0.0"; // keep in sync with sw.js VERSION
const CFG = window.FIT_CONFIG || {};
const CONFIGURED = CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("YOUR-") && CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_ANON_KEY.includes("YOUR-");
const sb = CONFIGURED ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } }) : null;

const STATUS = { ACT: ["Active", "A"], Q: ["Questionable", "Q"], D: ["Doubtful", "D"], O: ["Out", "O"], IR: ["Injured reserve", "IR"], SUS: ["Suspended", "SUS"] };
const MODES = { all: "Everything", impact: "Out or cleared", off: "Off" };
const LINK_KINDS = { qb: "QB link", teammate: "Ahead of him", handcuff: "Handcuff", custom: "Custom link" };
const PLANS_ENABLED = false; // off for now: unlimited teams for everyone. Turn on when Pro launches.
const FREE_TEAMS = 1; // must match free_team_limit() in 002_plans.sql once plans are enabled
const NOTIFY = { inherit: "Default", all: "Everything", impact: "Out or cleared", mute: "Muted" };
const SLOTS = [["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"], ["FLEX", "FLEX"], ["SFLEX", "S-FLEX"], ["DST", "D/ST"], ["K", "K"], ["IDP", "IDP"], ["BN", "BENCH"], ["IR", "IR"]];
const SLOT_POS = { QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], FLEX: ["RB", "WR", "TE"], SFLEX: ["QB", "RB", "WR", "TE"], DST: ["DEF"], K: ["K"], IDP: ["DL", "DE", "DT", "LB", "DB", "CB", "S"], BN: null, IR: null };
const DEFAULT_ROWS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "DST", "K", "BN", "BN", "BN", "BN", "BN", "BN"]; // 15 rows
const MIN_ROWS = DEFAULT_ROWS.length;
const WORD = { ACT: "ACTIVE", Q: "QUESTIONABLE", D: "DOUBTFUL", O: "OUT", IR: "IR", SUS: "SUSPENDED" };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stLabel = (s) => STATUS[s]?.[0] || s;
const badge = (s, sm) => `<span class="st ${s}${sm ? " sm" : ""}" title="${esc(stLabel(s))}">${esc(STATUS[s]?.[1] || s)}</span>`;
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[.'’`]/g, "").replace(/-/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const S = {
  session: null, settings: null, teams: [], roster: [], links: [], rules: [], emptySlots: JSON.parse(localStorage.getItem("fit-empty") || "{}"), extraRows: JSON.parse(localStorage.getItem("fit-extra") || "{}"), players: new Map(), statuses: new Map(), alerts: [],
  plan: "free", activeTeam: localStorage.getItem("fit-team"), leagueMeta: {}, pendingJoin: null, view: (location.hash || "#teams").slice(1), pushState: "unknown", loaded: false,
};

/* ---------------- boot ---------------- */
$("ver").textContent = "v" + APP_VERSION;
registerSW();
if (!CONFIGURED) {
  $("view").innerHTML = `<div class="panel empty"><h2>Almost there</h2><p>Fill in config.js with your Supabase URL, key, and VAPID public key, then push to GitHub. The README walks through it.</p></div>`;
} else {
  sb.auth.onAuthStateChange((_e, session) => {
    const was = S.session?.user?.id;
    S.session = session;
    if (!session) { S.loaded = false; renderSignIn(); }
    else if (session.user.id !== was) loadAll();
  });
  sb.auth.getSession().then(({ data }) => { S.session = data.session; if (!data.session) renderSignIn(); else loadAll(); });
}
function readHash() {
  const h = (location.hash || "#teams").slice(1);
  const m = h.match(/^join=([A-Za-z0-9]+)/);
  if (m) { S.pendingJoin = m[1]; history.replaceState(null, "", location.pathname + "#teams"); S.view = "teams"; }
  else S.view = h;
}
readHash();
window.addEventListener("hashchange", () => { readHash(); if (S.loaded) { render(); if (S.pendingJoin) joinDlg(); } });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.loaded && !userBusy()) refresh(); });
const userBusy = () => dlg.open || ["INPUT", "SELECT"].includes(document.activeElement?.tagName);
setInterval(() => { if (document.visibilityState === "visible" && S.loaded && !userBusy()) refresh(); }, 60000);

/* ---------------- auth ---------------- */
function renderSignIn(msg) {
  $("nav").hidden = true; $("tabs").innerHTML = "";
  $("view").innerHTML = `<div class="panel setting" style="margin-top:8px">
    <h2>Sign in</h2><p class="sub">We'll email you a sign-in link. No password needed.</p>
    <label class="f" for="em">Email</label><input type="email" id="em" autocomplete="email" placeholder="you@example.com" value="${esc(localStorage.getItem("fit-email") || "")}">
    <div class="actions"><button class="btn" data-act="sendLink">Email me a link</button></div>
    <div id="authMsg" class="${msg ? "err" : "hint"}">${esc(msg || "")}</div></div>`;
}
let resendTimer = null;
async function sendLink(email) {
  email = (email || $("em")?.value || "").trim();
  if (!email) return $("em")?.focus();
  const btn = document.querySelector('[data-act="sendLink"],[data-act="resendLink"]');
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) {
    renderSignIn(/rate|seconds|security/i.test(error.message) ? "Too many sign-in emails in a short time. Wait a minute and try again." : error.message);
    if ($("em")) $("em").value = email;
    return;
  }
  localStorage.setItem("fit-email", email);
  renderLinkSent(email);
}
function renderLinkSent(email) {
  $("view").innerHTML = `<div class="panel setting sent" style="margin-top:8px">
    <div class="check" aria-hidden="true">✓</div>
    <h2>Check your email</h2>
    <p>We sent a sign-in link to <b>${esc(email)}</b>.</p>
    <p class="sub">Open that email on this phone and tap the link. It can take a minute; check spam if it's not there.</p>
    <div class="actions"><button class="btn ghost" data-act="resendLink" data-email="${esc(email)}" disabled>Resend in 60s</button><button class="btn ghost" data-act="changeEmail">Use a different email</button></div></div>`;
  let left = 60;
  clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    const b = document.querySelector('[data-act="resendLink"]');
    if (!b) return clearInterval(resendTimer);
    left--;
    if (left <= 0) { clearInterval(resendTimer); b.disabled = false; b.textContent = "Resend link"; }
    else b.textContent = `Resend in ${left}s`;
  }, 1000);
}

/* ---------------- data ---------------- */
async function loadAll() {
  $("nav").hidden = false;
  try {
    await ensureSettings();
    await refresh(true);
    S.loaded = true;
    await checkPush();
    render();
    if (S.pendingJoin) joinDlg();
  } catch (e) { showError(e); }
}
async function ensureSettings() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Phoenix";
  let { data, error } = await sb.from("user_settings").select("*").maybeSingle();
  if (error) throw error;
  if (!data) ({ data, error } = await sb.from("user_settings").insert({ timezone: tz }).select().single());
  else if (data.timezone !== tz) ({ data, error } = await sb.from("user_settings").update({ timezone: tz }).eq("user_id", data.user_id).select().single());
  if (error) throw error;
  S.settings = data;
}
async function refresh(silent) {
  const [t, r, l, a, acct, ru] = await Promise.all([
    sb.from("user_teams").select("*").order("sort").order("created_at"),
    sb.from("roster").select("*").order("created_at"),
    sb.from("links").select("*").order("created_at"),
    sb.from("alerts").select("*").order("created_at", { ascending: false }).limit(60),
    sb.from("accounts").select("plan,pro_until").maybeSingle(),
    sb.from("rules").select("*").gt("expires_at", new Date().toISOString()).order("created_at"),
  ]);
  S.rules = ru.data || [];
  const ac = acct.data;
  S.plan = ac && ac.plan === "pro" && (!ac.pro_until || new Date(ac.pro_until) > new Date()) ? "pro" : "free";
  for (const x of [t, r, l, a]) if (x.error) throw x.error;
  S.teams = t.data; S.roster = r.data; S.links = l.data; S.alerts = a.data;
  const ids = [...new Set([...S.roster.map((x) => x.player_id), ...S.links.map((x) => x.player_id), ...S.rules.flatMap((x) => [x.trigger_player_id, x.start_player_id, x.over_player_id])])];
  const players = [], statuses = [];
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const [p, s] = await Promise.all([
      sb.from("nfl_players").select("id,full_name,pos,team,depth_order").in("id", chunk),
      sb.from("player_status").select("player_id,status,detail,updated_at").in("player_id", chunk),
    ]);
    players.push(...(p.data || [])); statuses.push(...(s.data || []));
  }
  S.players = new Map(players.map((p) => [p.id, p]));
  S.statuses = new Map(statuses.map((s) => [s.player_id, s]));
  if (!S.teams.find((x) => x.id === S.activeTeam)) S.activeTeam = S.teams[0]?.id || null;
  if (!silent) render();
}
const team = () => S.teams.find((t) => t.id === S.activeTeam);
const statusOf = (pid) => S.statuses.get(pid)?.status || "ACT";
const P = (pid) => S.players.get(pid) || { id: pid, full_name: "Unknown player", pos: "?", team: null };

/** Run a database write without waiting on it. The screen already shows the change;
 *  if the write fails, show the error and reload the real data. */
function bg(q) {
  Promise.resolve(q).then((res) => { if (res && res.error) throw res.error; })
    .catch((e) => { showError(e); refresh().catch(() => {}); });
}
async function ensurePlayers(ids) {
  const need = ids.filter((id) => id && !S.players.has(id));
  const [p, st] = await Promise.all([
    need.length ? sb.from("nfl_players").select("id,full_name,pos,team,depth_order").in("id", need) : { data: [] },
    ids.length ? sb.from("player_status").select("player_id,status,detail,updated_at").in("player_id", ids) : { data: [] },
  ]);
  (p.data || []).forEach((x) => S.players.set(x.id, x));
  (st.data || []).forEach((x) => S.statuses.set(x.player_id, x));
}

/* ---------------- api (edge function) ---------------- */
async function api(action, payload = {}) {
  const { data, error } = await sb.functions.invoke("api", { body: { action, ...payload } });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch { /* keep message */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/* ---------------- render ---------------- */
function render() {
  if (!S.loaded) return;
  const tabs = $("tabs");
  tabs.innerHTML = S.view === "teams"
    ? S.teams.map((t) => `<button class="tab" role="tab" aria-selected="${t.id === S.activeTeam}" data-team="${t.id}">${esc(t.name)}</button>`).join("") + `<button class="tab add" data-act="newTeam">+ Team${canAddTeam() ? "" : " (Pro)"}</button>`
    : "";
  document.querySelectorAll("nav.bottom button").forEach((b) => {
    if (b.dataset.nav === S.view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  renderBanner();
  const v = $("view");
  v.innerHTML = S.view === "alerts" ? viewAlerts() : S.view === "settings" ? viewSettings() : viewTeams();
}
function renderBanner() {
  const b = $("banner");
  if (S.waitingSW) { b.innerHTML = `<div class="bannerbox"><span>A new version is ready.</span><button class="btn small" data-act="applyUpdate">Update now</button></div>`; return; }
  if (S.pushState === "off" && S.view !== "settings") { b.innerHTML = `<div class="bannerbox"><span>Turn on notifications to get alerts on this device.</span><button class="btn small" data-act="enablePush">Turn on</button></div>`; return; }
  b.innerHTML = "";
}

const synced = (t) => !!t?.league_team_id;
const PLATFORM = { espn: "ESPN", sleeper: "Sleeper", yahoo: "Yahoo" };
async function loadLeagueMeta(t, force) {
  if (!synced(t) || (S.leagueMeta[t.id] && !force)) return;
  S.leagueMeta[t.id] = { loading: true };
  try { S.leagueMeta[t.id] = await api("leagueInfo", { teamId: t.id }) || { missing: true }; }
  catch (e) { S.leagueMeta[t.id] = { error: e.message }; }
  if (team()?.id === t.id && S.view === "teams" && !userBusy()) render();
}
function syncBar(t) {
  const m = S.leagueMeta[t.id];
  if (!m || m.loading) { loadLeagueMeta(t); return `<div class="syncbar">Synced from your league…</div>`; }
  if (m.error || m.missing) return `<div class="syncbar warn">Couldn't load league info. <button class="linkbtn" data-act="syncNow">Try again</button></div>`;
  if (m.status === "reconnect") return `<div class="syncbar warn">${m.isLinker ? `${esc(PLATFORM[m.platform])} needs you to reconnect.` : "Sync paused: the league's ESPN login expired."} <button class="linkbtn" data-act="teamSettings">${m.isLinker ? "Reconnect" : "Details"}</button></div>`;
  return `<div class="syncbar">Synced from ${esc(PLATFORM[m.platform])} · ${esc(m.leagueName)} · ${m.syncedAt ? esc(ago(m.syncedAt)) : "just now"} <button class="linkbtn" data-act="syncNow">Sync now</button>${m.unmatched?.length ? `<br><span class="warn">${m.unmatched.length} player${m.unmatched.length === 1 ? "" : "s"} couldn't be matched: ${esc(m.unmatched.join(", "))}</span>` : ""}</div>`;
}
function ago(ts) {
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  return m < 2 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} days ago`;
}
function lineupRows(t) {
  const filled = S.roster.filter((r) => r.team_id === t.id).sort((x, y) => (x.sort ?? 0) - (y.sort ?? 0) || String(x.created_at || "").localeCompare(String(y.created_at || "")));
  const used = new Set(), rows = [];
  for (const r of filled) { let i = r.sort; while (used.has(i) || i < 0) i++; used.add(i); rows[i] = r; }
  const n = synced(t) ? rows.length : Math.max(MIN_ROWS, rows.length) + (S.extraRows[t.id] || 0);
  const empty = S.emptySlots[t.id] || {};
  return Array.from({ length: n }, (_, i) => rows[i] ? { i, r: rows[i], slot: rows[i].lineup_slot } : { i, r: null, slot: empty[i] || DEFAULT_ROWS[i] || "BN" });
}
function viewTeams() {
  const t = team();
  if (!t) return `<div class="panel empty"><h2>Add your first team</h2><p>Name it after your league, then fill in your lineup and bench.</p>
    <div class="actions" style="justify-content:center"><button class="btn" data-act="newTeam">Add a team</button></div></div>`;
  const rules = S.rules.filter((x) => x.team_id === t.id);
  const rulesSec = rules.length ? `<h2>If/then rules this week</h2><div class="panel">${rules.map(rowRule).join("")}</div>` : "";
  const rows = lineupRows(t).filter((x) => !synced(t) || x.r);
  return (synced(t) ? syncBar(t) : "") + `<div class="panel lineup${synced(t) ? " locked" : ""}">${rows.map(rowLineup).join("") || `<div class="note">No players yet. Tap Sync now after your league drafts.</div>`}
      ${synced(t) ? "" : `<button class="row addrow" data-act="addRow">+ Add another player</button>`}</div>
    <div class="actions"><button class="btn ghost" data-act="addRule">Add if/then rule</button><button class="btn ghost" data-act="teamSettings">Team settings</button></div>` + rulesSec;
}
/** The most useful line of news for this row: his own if he's dinged,
 *  otherwise the linked player everyone's waiting on (Bigsby -> Barkley). */
function rowNote(r, p, st) {
  if (st && st.status !== "ACT" && st.detail) return `<span class="rnote">${esc(trim(st.detail))}</span>`;
  const hurt = S.links.filter((l) => l.roster_id === r.id).map((l) => [l, S.statuses.get(l.player_id)])
    .filter(([, s]) => s && s.status !== "ACT" && s.detail)
    .sort(([, a], [, b]) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (!hurt) return "";
  const lp = P(hurt[0].player_id);
  return `<span class="rnote">${esc(short(lp))}: ${esc(trim(hurt[1].detail))}</span>`;
}
const trim = (t) => (t.length > 110 ? t.slice(0, 107).replace(/[\s,;:]+$/, "") + "…" : t);
function rowLineup({ i, r, slot }) {
  const sel = `<select class="slotsel" data-slotrow="${i}" data-rid="${r ? r.id : ""}" aria-label="Lineup slot"${synced(team()) ? " disabled" : ""}>${SLOTS.map(([v, l]) => `<option value="${v}"${v === slot ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  if (!r) return `<div class="lrow">${sel}<div class="lname"><input type="search" class="gq" data-row="${i}" placeholder="Add player" autocomplete="off" aria-label="Player name"><div class="gres panel" id="gres${i}" hidden></div></div><span class="lst"></span></div>`;
  const p = P(r.player_id), st = statusOf(p.id), full = S.statuses.get(p.id);
  const links = S.links.filter((l) => l.roster_id === r.id);
  return `<div class="lrow">${sel}<div class="lname"><button class="pbtn" data-roster="${r.id}"><span class="name">${esc(p.full_name)}</span> <span class="meta">${esc(p.pos)}, ${esc(p.team || "FA")}</span>
      ${links.length ? `<span class="lk">${links.map((l) => { const lp = P(l.player_id); return `↳ ${esc(short(lp))} ${statusOf(lp.id) !== "ACT" ? `(${esc(WORD[statusOf(lp.id)])})` : ""}`; }).join(" · ")}</span>` : ""}
      ${rowNote(r, p, full)}</button></div>
    <span class="lst">${badge(st)}</span></div>`;
}
async function runGridSearch(i, q, slot) {
  const box = $("gres" + i); if (!box) return;
  const n = norm(q);
  if (n.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
  let query = sb.from("nfl_players").select("id,full_name,pos,team,depth_order").ilike("search_name", `%${n}%`).not("team", "is", null);
  if (SLOT_POS[slot]) query = query.in("pos", SLOT_POS[slot]);
  const { data, error } = await query.order("depth_order", { nullsFirst: false }).limit(10);
  const input = document.querySelector(`.gq[data-row="${i}"]`);
  if (!input || input.value !== q) return;
  const taken = new Set(S.roster.filter((r) => r.team_id === S.activeTeam).map((r) => r.player_id));
  const list = (data || []).filter((p) => !taken.has(p.id));
  box.hidden = false;
  box.innerHTML = error ? `<div class="note">${esc(error.message)}</div>` : list.length
    ? list.map((p) => `<button class="row" data-gpick="${esc(p.id)}" data-gname="${esc(p.full_name)}" data-gpos="${esc(p.pos)}" data-gteam="${esc(p.team || "")}" data-row="${i}">${badge(S.statuses.get(p.id)?.status || "ACT", 1)}<span class="who"><span class="name">${esc(p.full_name)}</span> <span class="meta">${esc(p.pos)}, ${esc(p.team)}</span></span></button>`).join("")
    : `<div class="note">No ${SLOT_POS[slot] ? esc(SLOTS.find((x) => x[0] === slot)[1]) + " " : ""}players match.</div>`;
}
const short = (p) => { if (p.pos === "DEF") return p.full_name; const t = p.full_name.split(/\s+/).filter((x) => !/^(jr|sr|ii|iii|iv|v)\.?$/i.test(x)); return t.length > 1 ? t[t.length - 1] : p.full_name; };
function noteBlock(pid) {
  const st = S.statuses.get(pid);
  if (!st?.detail) return "";
  return `<div class="pnote">${esc(st.detail)}<span class="when">Updated ${esc(when(st.updated_at))}</span></div>`;
}
function ruleText(rule) {
  const tp = P(rule.trigger_player_id), a = P(rule.start_player_id), b = P(rule.over_player_id);
  return `If <b>${esc(short(tp))}</b> is ${rule.on_status === "active" ? "ACTIVE" : "OUT"} → start <b>${esc(short(a))}</b> over <b>${esc(short(b))}</b>`;
}
function rowRule(rule) {
  const st = statusOf(rule.trigger_player_id);
  return `<div class="row">${badge(st, 1)}<span class="who">${ruleText(rule)}<br><span class="meta">${rule.fired_at ? "Sent " + esc(when(rule.fired_at)) : "Waiting · clears " + esc(new Date(rule.expires_at).toLocaleDateString([], { weekday: "short" }))}</span></span>
    <button class="btn ghost small" data-delrule="${rule.id}" aria-label="Delete rule">Delete</button></div>`;
}
function rowPlayer(r) {
  const p = P(r.player_id), st = statusOf(p.id);
  const links = S.links.filter((l) => l.roster_id === r.id);
  const detail = S.statuses.get(p.id)?.detail;
  return `<button class="row player" data-roster="${r.id}">${badge(st)}
    <span class="who"><span class="name">${esc(p.full_name)}</span> ${r.notify !== "inherit" ? `<span class="tag">${esc(NOTIFY[r.notify])}</span>` : ""}<br>
    <span class="meta">${esc(p.pos)}, ${esc(p.team || "FA")}${detail && st !== "ACT" ? `. ${esc(detail)}` : ""}</span>
    ${links.length ? `<span class="links">${links.map((l) => { const lp = P(l.player_id); return `<span class="link"><span class="arrow">↳</span>${badge(statusOf(lp.id), 1)}<span><b>${esc(lp.full_name)}</b> ${esc(lp.pos)}, ${esc(LINK_KINDS[l.kind].toLowerCase())}${l.notify === "mute" ? " (muted)" : ""}</span></span>`; }).join("")}</span>` : ""}
    </span></button>`;
}

function viewAlerts() {
  const tracked = trackedPlayers();
  const tools = `<h2>Test your setup</h2><p class="sub">Test alerts only go to you and don't change anyone's real statuses.</p>
    <div class="panel setting">
      <div class="actions" style="margin-top:0"><button class="btn ghost small" data-act="testPush">Send test notification</button><button class="btn ghost small" data-act="pregameNow">Run pre-game check now</button></div>
      ${tracked.length ? `<label class="f" for="simP">Simulate a status change</label><select id="simP">${tracked.map((p) => `<option value="${esc(p.id)}">${esc(p.full_name)} (${esc(p.pos)}, ${esc(p.team || "FA")}), now ${esc(stLabel(statusOf(p.id)))}</option>`).join("")}</select>
      <div class="grid2" style="margin-top:8px"><select id="simS" aria-label="New status">${Object.keys(STATUS).map((k) => `<option value="${k}"${k === "O" ? " selected" : ""}>${STATUS[k][0]}</option>`).join("")}</select><button class="btn small" data-act="simulate">Simulate</button></div>` : ""}
    </div>`;
  const list = S.alerts.length
    ? `<div class="panel">${S.alerts.map((a) => `<div class="alert"><div class="head">${a.status ? badge(a.status, 1) : `<span class="st T sm">${a.kind === "pregame" ? "T-" : a.kind === "bye" ? "BYE" : a.kind === "roster" ? "SYNC" : "TEST"}</span>`}<span class="ttl">${esc(a.title)}</span><span class="time">${esc(when(a.created_at))}</span></div>
        <ul>${(a.lines || []).map((l) => `<li>${l.team ? `<span class="tm">${esc(l.team)}:</span> ` : ""}${esc(l.text)}</li>`).join("")}</ul>
        ${a.held_until && !a.pushed_at ? `<div class="held">Held until ${esc(new Date(a.held_until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))} for quiet hours</div>` : ""}</div>`).join("")}</div>
       <div class="actions"><button class="btn ghost small" data-act="clearAlerts">Clear alert history</button></div>`
    : `<p class="sub">No alerts yet. They'll show up here as well as on your phone.</p>`;
  return `<h2>Alert history</h2>${list}${tools}`;
}
function trackedPlayers() {
  const ids = new Set([...S.roster.map((r) => r.player_id), ...S.links.map((l) => l.player_id)]);
  return [...ids].map(P).sort((a, b) => a.full_name.localeCompare(b.full_name));
}

const seg = (key, val, opts) => `<div class="seg" role="group">${Object.entries(opts).map(([k, v]) => `<button data-seg="${key}" data-val="${k}" aria-pressed="${val === k}">${v}</button>`).join("")}</div>`;
function viewSettings() {
  const s = S.settings;
  const pushLine = { on: "On for this device.", off: "Off for this device.", denied: "Blocked. Allow notifications for this site in Chrome's site settings, then reload.", unsupported: "This browser can't receive push notifications. On Android, use Chrome and add the app to your home screen.", unknown: "Checking…" }[S.pushState];
  return `<h2>This device</h2>
  <div class="panel"><div class="setting"><div class="top"><span class="t">Push notifications</span>
    ${S.pushState === "off" ? `<button class="btn small" data-act="enablePush">Turn on</button>` : S.pushState === "on" ? `<button class="btn ghost small" data-act="testPush">Test</button>` : ""}</div>
    <div class="hint">${esc(pushLine)}</div></div></div>
  <h2>Alerts</h2><p class="sub">The default for every team. Teams, players, and links can override it.</p>
  <div class="panel">
    <div class="setting">${seg("mode", s.mode, MODES)}
      <div class="hint">${s.mode === "impact" ? "Alerts when a player is ruled out (Out, IR, suspended) or cleared to play. Skips new Questionable and Doubtful tags." : s.mode === "all" ? "Every status change, including Questionable and Doubtful." : "No status alerts. Pre-game and bye checks still follow their own switches."}</div></div>
    <div class="setting"><div class="top"><span class="t">Pre-game check</span><input type="checkbox" class="switch" data-toggle="tx_on" aria-label="Pre-game check" ${s.tx_on ? "checked" : ""}></div>
      <div class="tx"><output id="txOut">T-${s.tx_minutes}</output><input type="range" min="5" max="120" step="5" value="${s.tx_minutes}" data-range="tx_minutes" aria-label="Minutes before kickoff" ${s.tx_on ? "" : "disabled"}></div>
      <div class="hint">One summary this many minutes before each kickoff window, covering starters playing in it. Inactive lists come out about 90 minutes before.</div></div>
    <div class="setting"><div class="top"><span class="t">Upside alerts</span><input type="checkbox" class="switch" data-toggle="upside" aria-label="Upside alerts" ${s.upside ? "checked" : ""}></div>
      <div class="hint">Handcuff and bench opportunities, like "starter out, start your backup."</div></div>
    <div class="setting"><div class="top"><span class="t">Bye-week warning</span><input type="checkbox" class="switch" data-toggle="bye" aria-label="Bye-week warning" ${s.bye ? "checked" : ""}></div>
      <div class="hint">Thursday at 9am when a starter's team is on bye.</div></div>
    <div class="setting"><div class="top"><span class="t">Quiet hours</span><input type="checkbox" class="switch" data-toggle="quiet_on" aria-label="Quiet hours" ${s.quiet_on ? "checked" : ""}></div>
      <div class="grid2" style="margin-top:10px"><div><label class="f" for="qs">From</label><input type="time" id="qs" data-time="quiet_start" value="${s.quiet_start.slice(0, 5)}"></div><div><label class="f" for="qe">Until</label><input type="time" id="qe" data-time="quiet_end" value="${s.quiet_end.slice(0, 5)}"></div></div>
      <div class="hint">Ruled-out alerts and pre-game checks still come through. Everything else waits until quiet hours end. Time zone: ${esc(s.timezone)}.</div></div>
  </div>
  <h2>Account</h2>
  <div class="panel"><div class="setting"><div class="top"><span>${esc(S.session?.user?.email || "")}</span><button class="btn ghost small" data-act="signOut">Sign out</button></div></div>
    ${PLANS_ENABLED ? `<div class="setting"><div class="top"><span class="t">Plan: ${S.plan === "pro" ? "Pro" : "Free"}</span>${S.plan === "pro" ? `<span class="tag">Unlimited teams</span>` : `<button class="btn ghost small" data-act="upgrade">About Pro</button>`}</div>
      <div class="hint">${S.plan === "pro" ? "Thanks for supporting the app." : `Free includes ${FREE_TEAMS} team with every alert type.`}</div></div>` : ""}</div>
  <p class="sub" style="margin-top:16px">Version ${APP_VERSION}. ${CFG.BMC_URL ? `Enjoying it? <a href="${esc(CFG.BMC_URL)}" target="_blank" rel="noopener">Buy me a coffee</a>.` : ""}</p>`;
}

/* ---------------- dialogs ---------------- */
const dlg = $("dlg"), dlgBody = $("dlgBody");
function openDlg(html) { dlgBody.innerHTML = `<button class="close" data-act="closeDlg" aria-label="Close">×</button>` + html; if (!dlg.open) dlg.showModal(); }
function closeDlg() { if (dlg.open) dlg.close(); }
const notifySelect = (id, val, keys, defaultLabel) => `<select id="${id}">${keys.map((k) => `<option value="${k}"${val === k ? " selected" : ""}>${k === "inherit" ? defaultLabel : k === "off" ? "Off" : NOTIFY[k]}</option>`).join("")}</select>`;

function canAddTeam() { return !PLANS_ENABLED || S.plan === "pro" || S.teams.length < FREE_TEAMS; }
function upgradeDlg() {
  openDlg(`<h3>More teams with Pro</h3><p class="sub">Free accounts include ${FREE_TEAMS} team with every alert type. Pro adds unlimited teams, so you can cover every league you're in.</p>
    <div class="panel note">Pro is coming soon. For now you can rename your current team or delete it to start a different one in Team settings.</div>
    <div class="actions"><button class="btn" data-act="closeDlg">Got it</button></div>`);
}
function newTeamDlg() {
  if (!canAddTeam()) return upgradeDlg();
  openDlg(`<h3>Add a team</h3><p class="sub">Linked teams stay in sync automatically: trades, pickups, and lineup moves.</p>
    <div class="actions" style="flex-direction:column;align-items:stretch">
      <button class="btn" data-act="linkEspn">Link an ESPN league</button>
      <button class="btn" data-act="linkSleeper">Link a Sleeper league</button>
      <button class="btn ghost" data-act="joinManual">Join with an invite link</button>
      <button class="btn ghost" data-act="manualTeam">Enter a team by hand</button>
    </div>`);
}
function manualTeamDlg() {
  openDlg(`<h3>New team</h3><p class="sub">Name it after the league so alerts are easy to tell apart.</p>
    <label class="f" for="tn">Team name</label><input type="text" id="tn" placeholder="Work league" maxlength="40">
    <div class="actions"><button class="btn" data-act="saveTeam">Create team</button></div><div id="dlgErr" class="err"></div>`);
  setTimeout(() => $("tn")?.focus(), 50);
}
function teamSettingsDlg() {
  const t = team();
  if (synced(t)) return syncedSettingsDlg(t);
  openDlg(`<h3>Team settings</h3>
    <label class="f" for="tn">Team name</label><input type="text" id="tn" value="${esc(t.name)}" maxlength="40">
    <label class="f" for="tnot">Alerts for this team</label>${notifySelect("tnot", t.notify, ["inherit", "all", "impact", "off"], `Use default (${MODES[S.settings.mode]})`)}
    <div class="actions"><button class="btn" data-act="saveTeamSettings">Save changes</button><button class="btn danger" data-act="deleteTeam">Delete team</button></div><div id="dlgErr" class="err"></div>`);
}

async function syncedSettingsDlg(t) {
  openDlg(`<h3>Team settings</h3><p class="sub">Loading league…</p>`);
  await loadLeagueMeta(t, true);
  const m = S.leagueMeta[t.id] || {};
  openDlg(`<h3>Team settings</h3>
    <label class="f" for="tn">Team name in this app</label><input type="text" id="tn" value="${esc(t.name)}" maxlength="40">
    <label class="f" for="tnot">Alerts for this team</label>${notifySelect("tnot", t.notify, ["inherit", "all", "impact", "off"], `Use default (${MODES[S.settings.mode]})`)}
    <div class="actions"><button class="btn" data-act="saveTeamSettings">Save changes</button></div>
    <h2>League sync</h2>
    <div class="panel note">${esc(PLATFORM[m.platform] || "")} · ${esc(m.leagueName || "")} · your team: ${esc(m.teamName || "")}<br>
      ${m.status === "reconnect" ? `<span class="warn">${esc(m.lastError || "Needs reconnecting.")}</span>` : m.status === "error" ? `<span class="warn">Last sync failed: ${esc(m.lastError || "")}</span>` : `Last synced ${m.syncedAt ? esc(ago(m.syncedAt)) : "never"}.`}</div>
    <div class="actions"><button class="btn ghost small" data-act="syncNow">Sync now</button>
      ${m.isLinker && m.platform === "espn" ? `<button class="btn ghost small" data-act="reconnectEspn" data-ext="${esc(m.externalId)}">Update ESPN cookies</button>` : ""}</div>
    ${m.isLinker ? `<h2>Invite your league</h2><p class="sub">Anyone in ${esc(m.leagueName)} can open this link, sign in, and claim their team. No ESPN cookies needed on their end.</p>
      <div class="actions"><button class="btn small" data-act="shareInvite" data-code="${esc(m.inviteCode)}">Share invite link</button><button class="btn ghost small" data-act="copyInvite" data-code="${esc(m.inviteCode)}">Copy</button></div>
      <div class="panel">${(m.claims || []).map((c) => `<div class="row"><span class="who"><span class="name">${esc(c.name)}</span><br><span class="meta">${esc(c.manager || "")}</span></span>${c.mine ? `<span class="tag">You</span>` : c.claimed ? `<button class="btn ghost small" data-act="release" data-lt="${esc(c.id)}">Release</button>` : `<span class="tag">Open</span>`}</div>`).join("")}</div>` : ""}
    <div class="actions"><button class="btn ghost small" data-act="unlinkTeam">Stop syncing (keep as manual team)</button><button class="btn danger small" data-act="deleteTeam">Delete team</button></div>
    <div id="dlgErr" class="err"></div>`);
}

/* ---------- league linking ---------- */
function espnDlg(prefill = {}) {
  openDlg(`<h3>${prefill.reconnect ? "Reconnect ESPN" : "Link an ESPN league"}</h3>
    <label class="f" for="elg">League URL</label><input type="text" id="elg" placeholder="https://fantasy.espn.com/football/league?leagueId=…" value="${esc(prefill.league || "")}" ${prefill.reconnect ? "readonly" : ""}>
    <div class="hint">Open your league on ESPN and copy the address. It contains <b>leagueId=</b>.</div>
    <label class="f" for="es2">espn_s2 <span class="meta">(private leagues)</span></label><input type="text" id="es2" autocomplete="off" autocapitalize="off" spellcheck="false">
    <label class="f" for="esw">SWID <span class="meta">(private leagues)</span></label><input type="text" id="esw" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="{XXXXXXXX-XXXX-…}">
    <details class="howto"><summary>How to find espn_s2 and SWID (2 minutes, on a computer)</summary>
      <ol><li>On a computer, open <b>fantasy.espn.com</b> in Chrome and sign in.</li>
      <li>Press <b>F12</b> (or right-click → Inspect), open the <b>Application</b> tab.</li>
      <li>On the left: <b>Cookies → https://fantasy.espn.com</b>.</li>
      <li>Find <b>espn_s2</b> and <b>SWID</b>. Double-click each Value, copy it, paste it here.</li></ol>
      <p class="sub">These work like a login to your ESPN fantasy account. They're stored encrypted and only used to read rosters. Leave both blank for a public league.</p></details>
    <div class="actions"><button class="btn" data-act="espnGo">${prefill.reconnect ? "Reconnect" : "Link league"}</button></div><div id="dlgErr" class="err"></div>`);
}
function sleeperDlg() {
  openDlg(`<h3>Link a Sleeper league</h3>
    <label class="f" for="su">Sleeper username</label><input type="text" id="su" autocomplete="off" autocapitalize="off">
    <div class="actions"><button class="btn" data-act="sleeperFind">Find my leagues</button></div><div id="sleeperOut"></div><div id="dlgErr" class="err"></div>`);
  setTimeout(() => $("su")?.focus(), 50);
}
async function afterLink(r, label) {
  await refresh(true);
  if (r.teamId) {
    S.activeTeam = r.teamId; localStorage.setItem("fit-team", r.teamId);
    closeDlg(); location.hash = "teams"; render();
    toast(`${label} linked`, "Your roster is in, with QB and teammate links added. It stays in sync automatically.");
  } else {
    S.pendingJoin = r.inviteCode; joinDlg("We couldn't tell which team is yours. Pick it below.");
  }
}
async function joinDlg(msg) {
  const code = S.pendingJoin;
  if (!code) return;
  openDlg(`<h3>Join a league</h3><p class="sub">Loading…</p>`);
  try {
    const r = await api("leagueForInvite", { code });
    openDlg(`<h3>${esc(r.league.name)}</h3><p class="sub">${esc(msg || `Tap your team to add it. It stays in sync with ${PLATFORM[r.league.platform]} automatically.`)}</p>
      <div class="panel">${r.teams.map((t) => `<div class="row"><span class="who"><span class="name">${esc(t.name)}</span><br><span class="meta">${esc(t.manager || "")}</span></span>
        ${t.mine ? `<span class="tag">Yours</span>` : t.claimed ? `<span class="tag">Claimed</span>` : `<button class="btn small" data-act="claim" data-lt="${esc(t.id)}">This is me</button>`}</div>`).join("")}</div>
      <div id="dlgErr" class="err"></div>`);
  } catch (e) { openDlg(`<h3>Join a league</h3><p class="err">${esc(e.message)}</p>`); S.pendingJoin = null; }
}
function joinManualDlg() {
  openDlg(`<h3>Join with an invite</h3><p class="sub">Paste the invite link someone in your league sent you.</p>
    <label class="f" for="inv">Invite link or code</label><input type="text" id="inv" autocomplete="off" autocapitalize="off">
    <div class="actions"><button class="btn" data-act="joinGo">Continue</button></div><div id="dlgErr" class="err"></div>`);
  setTimeout(() => $("inv")?.focus(), 50);
}
function inviteUrl(code) { return `${location.origin}${location.pathname}#join=${code}`; }

/* player search used by add-player and add-link */
let searchTimer = null, searchPick = null;
function searchBox(placeholder, onPick) {
  searchPick = onPick;
  return `<input type="search" id="q" placeholder="${esc(placeholder)}" autocomplete="off" aria-label="Search players"><div class="results panel" id="qres" hidden></div>`;
}
async function runSearch(q) {
  const box = $("qres"); if (!box) return;
  const n = norm(q);
  if (n.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
  const { data, error } = await sb.from("nfl_players").select("id,full_name,pos,team,depth_order").ilike("search_name", `%${n}%`).not("team", "is", null).order("depth_order", { nullsFirst: false }).limit(15);
  if ($("q")?.value !== q) return;
  box.hidden = false;
  if (error) { box.innerHTML = `<div class="note">${esc(error.message)}</div>`; return; }
  box.innerHTML = data.length ? data.map((p) => `<button class="row" data-pick="${esc(p.id)}" data-name="${esc(p.full_name)}" data-pos="${esc(p.pos)}" data-nflteam="${esc(p.team || "")}">${badge(S.statuses.get(p.id)?.status || "ACT", 1)}<span class="who"><span class="name">${esc(p.full_name)}</span><br><span class="meta">${esc(p.pos)}, ${esc(p.team || "FA")}</span></span></button>`).join("")
    : `<div class="note">No players found. If the player database is empty, the backend hasn't run its first sync yet.</div>`;
}

function addPlayerDlg() {
  openDlg(`<h3>Add player</h3><p class="sub">Search by name. QB and handcuff links are added automatically, and you can change them after.</p>
    ${searchBox("Tee Higgins")}<div id="pickArea"></div><div id="dlgErr" class="err"></div>`);
  searchPick = (p) => {
    $("qres").hidden = true;
    $("pickArea").innerHTML = `<div class="panel setting" style="margin-top:10px"><div class="name">${esc(p.name)}</div><div class="meta">${esc(p.pos)}, ${esc(p.team)}</div>
      <div class="actions"><button class="btn" data-act="addAs" data-slot="start" data-pid="${esc(p.id)}">Add as starter</button><button class="btn ghost" data-act="addAs" data-slot="bench" data-pid="${esc(p.id)}">Add to bench</button></div></div>`;
  };
  setTimeout(() => $("q")?.focus(), 50);
}

function playerDlg(rosterId) {
  const r = S.roster.find((x) => x.id === rosterId); if (!r) return closeDlg();
  const p = P(r.player_id), st = S.statuses.get(p.id);
  const links = S.links.filter((l) => l.roster_id === r.id);
  openDlg(`<h3>${esc(p.full_name)}</h3><p class="sub">${esc(p.pos)}, ${esc(p.team || "FA")} · ${badge(st?.status || "ACT", 1)} ${esc(stLabel(st?.status || "ACT"))}</p>
    ${noteBlock(p.id)}
    <div><div><label class="f" for="pnot">Alerts for him</label>${notifySelect("pnot", r.notify, ["inherit", "all", "impact", "mute"], "Use team setting")}</div></div>
    ${r.slot === "bench" && ["Q", "D"].includes(st?.status) ? `<div class="bannerbox" style="margin-top:12px"><span>He's ${esc(stLabel(st.status))} on your bench. Get told who to swap if he's cleared?</span><button class="btn small" data-act="addRule" data-trigger="${esc(p.id)}">Set rule</button></div>`
      : `<div class="actions"><button class="btn ghost small" data-act="addRule" data-trigger="${esc(p.id)}">Add if/then rule</button></div>`}
    <h2>Why you're watching</h2>
    ${links.length ? `<div class="panel">${links.map((l) => { const lp = P(l.player_id); return `<div class="row linkrow"><span class="who"><span class="name">${badge(statusOf(lp.id), 1)} ${esc(lp.full_name)}</span><br><span class="meta">${esc(lp.pos)}, ${esc(lp.team || "FA")}, ${esc(LINK_KINDS[l.kind].toLowerCase())}</span>${noteBlock(lp.id)}
      </span><select data-linknotify="${l.id}" aria-label="Alerts for ${esc(lp.full_name)}" style="width:auto">${["inherit", "all", "impact", "mute"].map((v) => `<option value="${v}"${l.notify === v ? " selected" : ""}>${v === "inherit" ? "Default" : v === "impact" ? "Out/cleared" : NOTIFY[v]}</option>`).join("")}</select>
      <button class="btn ghost small" data-unlink="${l.id}" data-roster="${r.id}" aria-label="Remove link to ${esc(lp.full_name)}">Remove</button></div>`; }).join("")}</div>` : `<p class="sub">No linked players yet. Add the QB, the back ahead of him, or anyone whose status changes his value.</p>`}
    <label class="f">Add a link</label>
    <select id="lk" aria-label="Link type" style="margin-bottom:8px">${Object.entries(LINK_KINDS).map(([k, v]) => `<option value="${k}"${(p.pos === "RB" ? "teammate" : "qb") === k ? " selected" : ""}>${v}</option>`).join("")}</select>
    <div class="hint" style="margin-top:-4px">"Ahead of him" = if that player is out, yours gets more work. "Handcuff" = the player behind yours.</div>
    ${searchBox("Search a player to link")}
    <div class="actions"><button class="btn" data-act="savePlayer" data-roster="${r.id}">Save changes</button><button class="btn danger" data-act="dropPlayer" data-roster="${r.id}">Drop player</button></div><div id="dlgErr" class="err"></div>`);
  searchPick = async (lp) => {
    if (!S.players.has(lp.id)) S.players.set(lp.id, { id: lp.id, full_name: lp.name, pos: lp.pos, team: lp.team || null, depth_order: null });
    const [ins] = await Promise.all([sb.from("links").insert({ team_id: r.team_id, roster_id: r.id, player_id: lp.id, kind: $("lk").value }).select().single(), ensurePlayers([lp.id])]);
    if (ins.error && !String(ins.error.message).includes("duplicate")) return setErr(ins.error.message);
    if (ins.data) S.links.push(ins.data);
    render(); playerDlg(r.id);
  };
}

async function pickIntoRow(i, pick) {
  const t = team();
  const slot = document.querySelector(`.slotsel[data-slotrow="${i}"]`)?.value || "BN";
  if (!S.players.has(pick.id)) S.players.set(pick.id, { id: pick.id, full_name: pick.name, pos: pick.pos, team: pick.team || null, depth_order: null });
  const temp = { id: "tmp-" + Date.now(), team_id: t.id, player_id: pick.id, lineup_slot: slot, slot: slot === "BN" ? "bench" : "start", sort: i, notify: "inherit", created_at: new Date().toISOString() };
  S.roster.push(temp);
  if (S.emptySlots[t.id]) { delete S.emptySlots[t.id][i]; localStorage.setItem("fit-empty", JSON.stringify(S.emptySlots)); }
  render();
  const [ins] = await Promise.all([
    sb.from("roster").insert({ team_id: t.id, player_id: pick.id, lineup_slot: slot, sort: i }).select().single(),
    ensurePlayers([pick.id]),
  ]);
  if (ins.error) { S.roster = S.roster.filter((x) => x !== temp); render(); return showError(ins.error); }
  Object.assign(temp, ins.data);
  render();
  autoLink(ins.data, S.players.get(pick.id)).catch((e) => console.warn("auto-link", e));
}
/** Auto-links: WR/TE get their QB, and RB/WR/TE get the same-position player directly
 *  ahead of them on the depth chart (or their handcuff, if yours is the starter). */
async function autoLink(r, p) {
  if (!p?.team || !["WR", "TE", "RB"].includes(p.pos)) return;
  const positions = p.pos === "RB" ? ["RB"] : ["QB", p.pos];
  const { data: depth } = await sb.from("nfl_players").select("id,full_name,pos,team,depth_order")
    .eq("team", p.team).in("pos", positions).not("depth_order", "is", null).order("depth_order").limit(12);
  if (!depth?.length) return;
  const targets = [];
  if (p.pos !== "RB") { const qb = depth.find((d) => d.pos === "QB"); if (qb) targets.push([qb, "qb"]); }
  const mates = depth.filter((d) => d.pos === p.pos && d.id !== p.id);
  const mine = depth.find((d) => d.id === p.id)?.depth_order ?? p.depth_order ?? 99;
  const ahead = mates.filter((d) => d.depth_order < mine).pop();
  const behind = mates.find((d) => d.depth_order > mine);
  if (ahead) targets.push([ahead, "teammate"]);
  else if (behind) targets.push([behind, "handcuff"]);
  for (const [target, kind] of targets) {
    S.players.set(target.id, target);
    const [ins] = await Promise.all([
      sb.from("links").insert({ team_id: r.team_id, roster_id: r.id, player_id: target.id, kind }).select().single(),
      ensurePlayers([target.id]),
    ]);
    if (!ins.error) { S.links.push(ins.data); render(); }
  }
}

/* if/then rules */
let ruleOn = "active";
function nextTuesday() {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  do d.setDate(d.getDate() + 1); while (d.getDay() !== 2);
  return d;
}
function ruleDlg(triggerId) {
  const t = team();
  const mine = S.roster.filter((r) => r.team_id === t.id);
  if (mine.length < 2) return openDlg(`<h3>Add rule</h3><p class="sub">Add at least two players to this team first.</p>`);
  const tracked = [...new Set([...mine.map((r) => r.player_id), ...S.links.filter((l) => l.team_id === t.id).map((l) => l.player_id)])].map(P).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const trig = triggerId ? P(triggerId) : (mine.map((r) => P(r.player_id)).find((p) => ["Q", "D"].includes(statusOf(p.id))) || P(mine[0].player_id));
  const trigRow = mine.find((r) => r.player_id === trig.id);
  const onStatus = trigRow && trigRow.slot === "start" ? "out" : "active";
  const starters = mine.filter((r) => r.slot === "start").map((r) => P(r.player_id));
  const bench = mine.filter((r) => r.slot === "bench").map((r) => P(r.player_id));
  const samePos = (list) => list.find((p) => p.pos === trig.pos && p.id !== trig.id) || list.find((p) => p.id !== trig.id) || list[0];
  const start = onStatus === "active" ? trig : samePos(bench.length ? bench : mine.map((r) => P(r.player_id)));
  const over = onStatus === "active" ? samePos(starters.length ? starters : mine.map((r) => P(r.player_id))) : trig;
  const opt = (list, sel) => list.map((p) => `<option value="${esc(p.id)}"${sel && p.id === sel.id ? " selected" : ""}>${esc(p.full_name)} (${esc(p.pos)}${S.statuses.get(p.id) ? ", " + esc(WORD[statusOf(p.id)]) : ""})</option>`).join("");
  const rosterP = mine.map((r) => P(r.player_id));
  openDlg(`<h3>If/then rule</h3><p class="sub">Get told exactly what to swap. Rules last through this week's games and send once.</p>
    <label class="f" for="ruT">If</label><select id="ruT">${opt(tracked, trig)}</select>
    <label class="f">is ruled</label><div class="seg" role="group"><button data-ruon="active" aria-pressed="${onStatus === "active"}">Active</button><button data-ruon="out" aria-pressed="${onStatus === "out"}">Out</button></div>
    <label class="f" for="ruA">then start</label><select id="ruA">${opt(rosterP, start)}</select>
    <label class="f" for="ruB">over</label><select id="ruB">${opt(rosterP, over)}</select>
    <div class="hint" id="ruPrev"></div>
    <div class="actions"><button class="btn" data-act="saveRule">Save rule</button></div><div id="dlgErr" class="err"></div>`);
  ruleOn = onStatus;
  rulePreview();
}
function rulePreview() {
  const el = $("ruPrev"); if (!el) return;
  const t = P($("ruT").value), a = P($("ruA").value), b = P($("ruB").value);
  el.textContent = `You'll get: "${short(t)} ${ruleOn === "active" ? "ACTIVE" : "OUT"} · RULE → start ${short(a)} over ${short(b)}"`;
}

/* ---------------- push ---------------- */
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    const watch = (w) => w && w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) { S.waitingSW = w; renderBanner(); } });
    if (reg.waiting && navigator.serviceWorker.controller) { S.waitingSW = reg.waiting; renderBanner(); }
    reg.addEventListener("updatefound", () => watch(reg.installing));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; location.reload(); } });
  } catch (e) { console.warn("service worker", e); }
}
async function checkPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { S.pushState = "unsupported"; return; }
  if (Notification.permission === "denied") { S.pushState = "denied"; return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  S.pushState = sub && Notification.permission === "granted" ? "on" : "off";
  if (sub && S.pushState === "on") await saveSub(sub); // keeps the server copy fresh
}
function urlB64(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function saveSub(sub) {
  const j = sub.toJSON();
  await sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) }, { onConflict: "endpoint" });
}
async function enablePush() {
  try {
    if (!CFG.VAPID_PUBLIC_KEY || CFG.VAPID_PUBLIC_KEY.includes("YOUR-")) throw new Error("Add your VAPID public key to config.js first.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { S.pushState = perm === "denied" ? "denied" : "off"; render(); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(CFG.VAPID_PUBLIC_KEY) });
    await saveSub(sub);
    S.pushState = "on"; render();
    toast("Notifications are on", "Tap Send test notification on the Alerts tab to check.");
  } catch (e) { showError(e); }
}

/* ---------------- events ---------------- */
document.addEventListener("click", async (e) => {
  const nav = e.target.closest("[data-nav]"); if (nav) { location.hash = nav.dataset.nav; window.scrollTo(0, 0); return; }
  const tb = e.target.closest("[data-team]"); if (tb) { S.activeTeam = tb.dataset.team; localStorage.setItem("fit-team", S.activeTeam); render(); return; }
  const pick = e.target.closest("[data-pick]"); if (pick && searchPick) { searchPick({ id: pick.dataset.pick, name: pick.dataset.name, pos: pick.dataset.pos, team: pick.dataset.nflteam }); return; }
  const ro = e.target.closest("button[data-ruon]"); if (ro) { ruleOn = ro.dataset.ruon; dlgBody.querySelectorAll("button[data-ruon]").forEach((b) => b.setAttribute("aria-pressed", b === ro)); rulePreview(); return; }
  const dr = e.target.closest("[data-delrule]"); if (dr) { S.rules = S.rules.filter((x) => x.id !== dr.dataset.delrule); render(); bg(sb.from("rules").delete().eq("id", dr.dataset.delrule)); return; }
  const gp = e.target.closest("[data-gpick]"); if (gp) { pickIntoRow(+gp.dataset.row, { id: gp.dataset.gpick, name: gp.dataset.gname, pos: gp.dataset.gpos, team: gp.dataset.gteam }); return; }
  const sg = e.target.closest("[data-seg]"); if (sg) { saveSetting({ [sg.dataset.seg]: sg.dataset.val }); return; }
  const ul = e.target.closest("[data-unlink]"); if (ul) { S.links = S.links.filter((x) => x.id !== ul.dataset.unlink); render(); playerDlg(ul.dataset.roster); bg(sb.from("links").delete().eq("id", ul.dataset.unlink)); return; }
  const pr = e.target.closest("button[data-roster]:not([data-act])"); if (pr) { playerDlg(pr.dataset.roster); return; }
  const a = e.target.closest("[data-act]"); if (!a) return;
  const t = team();
  const busyTimer = setTimeout(() => a.classList.add("busy"), 120); // only show a spinner if it's actually slow
  try {
    switch (a.dataset.act) {
      case "sendLink": return sendLink();
      case "resendLink": return sendLink(a.dataset.email);
      case "changeEmail": return renderSignIn();
      case "closeDlg": return closeDlg();
      case "applyUpdate": S.waitingSW?.postMessage("skipWaiting"); return;
      case "enablePush": return enablePush();
      case "newTeam": return newTeamDlg();
      case "manualTeam": return manualTeamDlg();
      case "linkEspn": return espnDlg();
      case "linkSleeper": return sleeperDlg();
      case "joinManual": return joinManualDlg();
      case "joinGo": {
        const v = $("inv").value.trim(), code = (v.match(/join=([A-Za-z0-9]+)/) || [])[1] || (/^[A-Za-z0-9]{6,20}$/.test(v) ? v : "");
        if (!code) return setErr("Paste the full invite link.");
        S.pendingJoin = code; return joinDlg();
      }
      case "espnGo": {
        a.disabled = true; a.textContent = "Linking…";
        try {
          const r = await api("linkLeague", { platform: "espn", league: $("elg").value, espn_s2: $("es2").value, swid: $("esw").value });
          S.leagueMeta = {}; return afterLink(r, "ESPN league");
        } finally { if ($("elg")) { a.disabled = false; a.textContent = "Link league"; } }
      }
      case "reconnectEspn": return espnDlg({ reconnect: true, league: a.dataset.ext });
      case "sleeperFind": {
        a.disabled = true;
        try {
          const r = await api("sleeperLeagues", { username: $("su").value.trim() });
          S.sleeperCtx = r;
          $("sleeperOut").innerHTML = r.leagues.length ? `<h2>Your ${r.season} leagues</h2><div class="panel">${r.leagues.map((l) => `<div class="row"><span class="who"><span class="name">${esc(l.name)}</span><br><span class="meta">${esc(l.teams)} teams${r.alreadyLinked.includes(l.id) ? " · already linked by someone" : ""}</span></span><button class="btn small" data-act="sleeperLink" data-id="${esc(l.id)}" data-name="${esc(l.name)}">Link</button></div>`).join("")}</div>` : `<p class="sub">No ${r.season} leagues found for that username.</p>`;
        } finally { a.disabled = false; }
        return;
      }
      case "sleeperLink": {
        a.disabled = true; a.textContent = "Linking…";
        const r = await api("linkLeague", { platform: "sleeper", league: a.dataset.id, sleeperUserId: S.sleeperCtx?.sleeperUserId });
        return afterLink(r, a.dataset.name);
      }
      case "claim": {
        a.disabled = true;
        const r = await api("claimTeam", { leagueTeamId: a.dataset.lt, code: S.pendingJoin });
        S.pendingJoin = null; return afterLink({ teamId: r.teamId }, "Team");
      }
      case "syncNow": {
        a.disabled = true;
        await api("syncLeagueNow", { teamId: t.id });
        S.leagueMeta[t.id] = null; await refresh(true); closeDlg(); render();
        return toast("Synced", "Your roster matches the league.");
      }
      case "shareInvite": {
        const url = inviteUrl(a.dataset.code);
        if (navigator.share) { try { await navigator.share({ title: "Join my league on Fantasy Injury Tracker", text: "Tap to claim your team:", url }); } catch { /* cancelled */ } return; }
        await navigator.clipboard?.writeText(url); return toast("Invite link copied", url);
      }
      case "copyInvite": { const url = inviteUrl(a.dataset.code); await navigator.clipboard?.writeText(url); return toast("Invite link copied", url); }
      case "release": {
        if (!confirm("Release this team so someone else can claim it?")) return;
        await api("releaseClaim", { leagueTeamId: a.dataset.lt }); return syncedSettingsDlg(t);
      }
      case "unlinkTeam": {
        if (!confirm("Stop syncing this team? It stays in the app as a manual team, and someone else can claim it in the league.")) return;
        await api("unlinkTeam", { teamId: t.id }); t.league_team_id = null; closeDlg(); render(); return;
      }
      case "upgrade": return upgradeDlg();
      case "saveTeam": {
        const name = $("tn").value.trim(); if (!name) return $("tn").focus();
        const { data, error } = await sb.from("user_teams").insert({ name, sort: S.teams.length }).select().single();
        if (error) { if (String(error.message).includes("FREE_TEAM_LIMIT")) { await refresh(true); return upgradeDlg(); } return setErr(error.message); }
        S.teams.push(data); S.activeTeam = data.id; localStorage.setItem("fit-team", data.id);
        closeDlg(); location.hash = "teams"; render(); return;
      }
      case "teamSettings": return teamSettingsDlg();
      case "saveTeamSettings": {
        const name = $("tn").value.trim() || t.name;
        const notify = $("tnot").value;
        Object.assign(t, { name, notify }); closeDlg(); render();
        bg(sb.from("user_teams").update({ name, notify }).eq("id", t.id)); return;
      }
      case "deleteTeam":
        if (!confirm(`Delete ${t.name}? Its players and links will be removed.`)) return;
        S.teams = S.teams.filter((x) => x.id !== t.id); S.roster = S.roster.filter((x) => x.team_id !== t.id);
        S.links = S.links.filter((x) => x.team_id !== t.id); S.rules = S.rules.filter((x) => x.team_id !== t.id);
        S.activeTeam = S.teams[0]?.id || null; closeDlg(); render();
        bg(sb.from("user_teams").delete().eq("id", t.id)); return;
      case "addPlayer": return addPlayerDlg();
      case "addRule": return ruleDlg(a.dataset.trigger);
      case "addRow": { S.extraRows[t.id] = (S.extraRows[t.id] || 0) + 1; localStorage.setItem("fit-extra", JSON.stringify(S.extraRows)); render(); document.querySelector(".lrow:last-of-type .gq")?.focus(); return; }
      case "saveRule": {
        const row = { team_id: t.id, trigger_player_id: $("ruT").value, on_status: ruleOn, start_player_id: $("ruA").value, over_player_id: $("ruB").value, expires_at: nextTuesday().toISOString() };
        if (row.start_player_id === row.over_player_id) return setErr("Pick two different players.");
        const { data, error } = await sb.from("rules").insert(row).select().single();
        if (error) return setErr(error.message);
        S.rules.push(data); closeDlg(); render();
        return toast("Rule saved", "You'll get one alert when it triggers.");
      }
      case "addAs": {
        a.disabled = true;
        const r = await api("addPlayers", { teamId: t.id, players: [{ playerId: a.dataset.pid, slot: a.dataset.slot }] });
        await refresh(true); render();
        const row = r.roster?.[0] ? S.roster.find((x) => x.id === r.roster[0].id) : S.roster.find((x) => x.team_id === t.id && x.player_id === a.dataset.pid);
        return row ? playerDlg(row.id) : closeDlg();
      }
      case "savePlayer": {
        const notify = $("pnot").value, r = S.roster.find((x) => x.id === a.dataset.roster);
        if (r) r.notify = notify; closeDlg(); render();
        bg(sb.from("roster").update({ notify }).eq("id", a.dataset.roster)); return;
      }
      case "dropPlayer": {
        const r = S.roster.find((x) => x.id === a.dataset.roster);
        if (!confirm(`Drop ${P(r.player_id).full_name} from ${t.name}?`)) return;
        S.roster = S.roster.filter((x) => x.id !== r.id); S.links = S.links.filter((x) => x.roster_id !== r.id);
        closeDlg(); render(); bg(sb.from("roster").delete().eq("id", r.id)); return;
      }
      case "testPush": {
        const r = await api("testPush");
        return toast(r.devices ? "Test sent" : "No devices", r.devices ? `Sent to ${r.devices} device${r.devices === 1 ? "" : "s"}.` : "Turn on notifications on this device first.");
      }
      case "pregameNow": { const r = await api("pregameNow"); await refresh(); return r.note ? toast("Nothing to check", r.note) : toast("Pre-game check sent", ""); }
      case "simulate": {
        a.disabled = true;
        const r = await api("simulate", { playerId: $("simP").value, status: $("simS").value });
        a.disabled = false; await refresh();
        return r.note ? toast("No alert", r.note) : toast("Test alert sent", "Check your notifications.");
      }
      case "clearAlerts":
        if (!confirm("Clear your alert history?")) return;
        await sb.from("alerts").delete().eq("user_id", S.session.user.id); await refresh(); return;
      case "signOut": await sb.auth.signOut(); return;
    }
  } catch (err) { if (a) a.disabled = false; dlg.open && $("dlgErr") ? setErr(err.message) : showError(err); }
  finally { clearTimeout(busyTimer); a.classList.remove("busy"); }
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.classList.contains("gq")) { clearTimeout(searchTimer); const i = +el.dataset.row, v = el.value; const slot = document.querySelector(`.slotsel[data-slotrow="${i}"]`).value; searchTimer = setTimeout(() => runGridSearch(i, v, slot), 180); return; }
  if (el.id === "q") { clearTimeout(searchTimer); const v = el.value; searchTimer = setTimeout(() => runSearch(v), 250); }
  else if (el.dataset.range) { const o = $("txOut"); if (o) o.textContent = "T-" + el.value; }
});
document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.classList.contains("slotsel")) {
    const i = +el.dataset.slotrow, t = team();
    if (el.dataset.rid) { const r = S.roster.find((x) => x.id === el.dataset.rid); if (r) { r.lineup_slot = el.value; r.slot = el.value === "BN" ? "bench" : "start"; } bg(sb.from("roster").update({ lineup_slot: el.value }).eq("id", el.dataset.rid)); }
    else { (S.emptySlots[t.id] ||= {})[i] = el.value; localStorage.setItem("fit-empty", JSON.stringify(S.emptySlots)); const q = document.querySelector(`.gq[data-row="${i}"]`); if (q?.value) runGridSearch(i, q.value, el.value); }
    return;
  }
  if (el.dataset.toggle) saveSetting({ [el.dataset.toggle]: el.checked });
  else if (el.dataset.range) saveSetting({ [el.dataset.range]: +el.value });
  else if (el.dataset.time && el.value) saveSetting({ [el.dataset.time]: el.value });
  else if (["ruT", "ruA", "ruB"].includes(el.id)) rulePreview();
  else if (el.dataset.linknotify) { const l = S.links.find((x) => x.id === el.dataset.linknotify); if (l) l.notify = el.value; render(); bg(sb.from("links").update({ notify: el.value }).eq("id", el.dataset.linknotify)); }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "em") sendLink();
  else if (e.target.id === "su") document.querySelector('[data-act="sleeperFind"]')?.click();
  else if (e.target.id === "tn") document.querySelector('[data-act="saveTeam"],[data-act="saveTeamSettings"]')?.click();
});

async function saveSetting(patch) {
  Object.assign(S.settings, patch);
  render();
  const { error } = await sb.from("user_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("user_id", S.settings.user_id);
  if (error) showError(error);
}

/* ---------------- small ui helpers ---------------- */
function setErr(msg) { const el = $("dlgErr"); if (el) el.textContent = msg || ""; }
let toastTimer;
function toast(title, body) {
  const el = $("toast");
  el.innerHTML = `<div class="ttl">${esc(title)}</div>${body ? `<div class="body">${esc(body)}</div>` : ""}`;
  el.classList.add("show"); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 5000);
}
$("toast").addEventListener("click", () => $("toast").classList.remove("show"));
function showError(e) { console.error(e); toast("Something went wrong", e?.message || String(e)); }
function when(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}
