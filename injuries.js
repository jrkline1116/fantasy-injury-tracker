/* Fantasy Injury Assist: public NFL injury report (injuries.html). No sign-in needed.
   Data comes from one read-only database function (migration 013) and refreshes every 2 minutes
   while the tab is visible. Sort/filter choices live in the URL so a filtered view can be shared. */
(() => {
  "use strict";
  const CFG = window.FIT_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const REFRESH_MS = 2 * 60 * 1000;

  const TEAMS = {
    ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills", CAR: "Carolina Panthers",
    CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns", DAL: "Dallas Cowboys", DEN: "Denver Broncos",
    DET: "Detroit Lions", GB: "Green Bay Packers", HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars",
    KC: "Kansas City Chiefs", LV: "Las Vegas Raiders", LAC: "Los Angeles Chargers", LAR: "Los Angeles Rams", MIA: "Miami Dolphins",
    MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants", NYJ: "New York Jets",
    PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SF: "San Francisco 49ers", SEA: "Seattle Seahawks",
    TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders",
  };
  const STATUS = { Q: "Questionable", D: "Doubtful", O: "Out", IR: "Injured reserve", SUS: "Suspended" };
  const SEV = { Q: 1, D: 2, O: 3, IR: 4, SUS: 5 };
  const POS = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5 };
  // default direction for each sort the first time it's picked
  const DIR = { team: 1, name: 1, status: -1, pos: 1, since: -1, game: 1 };

  const S = { players: [], prevKeys: null, fresh: new Set(), fetchedAt: 0, lastChange: null, err: false,
    q: "", team: "", pos: "", status: "", sort: "team", dir: 1 };

  /* ---------- URL state ---------- */
  function readUrl() {
    const p = new URLSearchParams(location.search);
    S.q = p.get("q") || ""; S.team = (p.get("team") || "").toUpperCase(); S.pos = (p.get("pos") || "").toUpperCase();
    S.status = (p.get("status") || "").toUpperCase();
    S.sort = DIR[p.get("sort")] ? p.get("sort") : "team";
    S.dir = p.get("dir") === "desc" ? -1 : p.get("dir") === "asc" ? 1 : DIR[S.sort];
  }
  function writeUrl() {
    const p = new URLSearchParams();
    if (S.q) p.set("q", S.q); if (S.team) p.set("team", S.team); if (S.pos) p.set("pos", S.pos);
    if (S.status) p.set("status", S.status);
    if (S.sort !== "team") p.set("sort", S.sort);
    if (S.dir !== DIR[S.sort]) p.set("dir", S.dir === 1 ? "asc" : "desc");
    const qs = p.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
  }

  /* ---------- data ---------- */
  async function load() {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) { S.err = true; renderLive(); return; }
    try {
      const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/rpc/injury_report`, {
        method: "POST",
        headers: { apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: "{}", cache: "no-store",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const players = Array.isArray(data?.players) ? data.players : [];
      // highlight anyone whose designation changed since the last refresh (not on first load)
      const keys = new Map(players.map((p) => [p.id, p.status]));
      S.fresh = new Set();
      if (S.prevKeys) for (const [id, st] of keys) if (S.prevKeys.get(id) !== st) S.fresh.add(id);
      S.prevKeys = keys;
      S.players = players;
      S.lastChange = data?.last_change ? new Date(data.last_change) : null;
      S.fetchedAt = Date.now(); S.err = false;
      fillTeams(); render();
    } catch (e) {
      console.error("injury report", e);
      S.err = true;
      if (!S.players.length) $("list").innerHTML = `<div class="empty">Couldn't load the report. It will try again in a couple of minutes.</div>`;
    }
    renderLive();
  }

  /* ---------- helpers ---------- */
  const lastName = (n) => { const parts = String(n).replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/i, "").trim().split(/\s+/); return parts[parts.length - 1] + " " + n; };
  function ago(d) {
    if (!d) return "";
    const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " hr ago";
    const days = Math.round(s / 86400);
    return days < 14 ? days + (days === 1 ? " day ago" : " days ago") : new Date(d).toLocaleDateString([], { month: "short", day: "numeric" });
  }
  const gameText = (p) => {
    if (!p.opp) return "";
    if (p.live) return `${p.opp.startsWith("@") ? p.opp : "vs " + p.opp} · in progress`;
    const k = new Date(p.kickoff);
    const day = k.toLocaleDateString([], { weekday: "short" });
    const time = k.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${p.opp.startsWith("@") ? p.opp : "vs " + p.opp} · ${day} ${time}`;
  };
  const dayLetter = (iso) => ["Su", "M", "Tu", "W", "Th", "F", "Sa"][new Date(iso + "T12:00:00Z").getUTCDay()];

  /* ---------- filtering and sorting ---------- */
  function visible() {
    const q = S.q.trim().toLowerCase();
    const list = S.players.filter((p) =>
      (!q || p.name.toLowerCase().includes(q)) &&
      (!S.team || p.team === S.team) &&
      (!S.pos || p.pos === S.pos) &&
      (!S.status || (S.status === "GAME" ? ["Q", "D", "O"].includes(p.status) : p.status === S.status)));
    const by = {
      team: (a, b) => (TEAMS[a.team] || a.team).localeCompare(TEAMS[b.team] || b.team),
      name: (a, b) => lastName(a.name).localeCompare(lastName(b.name)),
      status: (a, b) => (SEV[a.status] || 9) - (SEV[b.status] || 9),
      pos: (a, b) => (POS[a.pos] || 9) - (POS[b.pos] || 9),
      since: (a, b) => new Date(a.since) - new Date(b.since),
      game: (a, b) => (a.kickoff ? new Date(a.kickoff) : Infinity) - (b.kickoff ? new Date(b.kickoff) : Infinity),
    };
    // ties: most serious first, then position, then last name
    const tie = (a, b) => (SEV[a.status] - SEV[b.status]) || ((POS[a.pos] || 9) - (POS[b.pos] || 9)) || lastName(a.name).localeCompare(lastName(b.name));
    const main = by[S.sort];
    return list.sort((a, b) => {
      // players with no upcoming game always sink to the bottom of the game sort
      if (S.sort === "game" && !a.kickoff !== !b.kickoff) return a.kickoff ? -1 : 1;
      return (main(a, b) * S.dir) || tie(a, b);
    });
  }

  /* ---------- rendering ---------- */
  function fillTeams() {
    const sel = $("team");
    if (sel.options.length > 1) return;
    const have = new Set(S.players.map((p) => p.team));
    const codes = Object.keys(TEAMS).concat([...have].filter((t) => !TEAMS[t]));
    codes.sort((a, b) => (TEAMS[a] || a).localeCompare(TEAMS[b] || b));
    for (const c of codes) sel.add(new Option(TEAMS[c] || c, c));
    sel.value = S.team;
  }

  function row(p) {
    const fresh = S.fresh.has(p.id);
    const prac = Array.isArray(p.practice) && p.practice.length
      ? `<span class="pc" title="Practice this week">${p.practice.map((d) => `<span class="${esc(d.p)}" title="${esc(new Date(d.d + "T12:00:00Z").toLocaleDateString([], { weekday: "long", timeZone: "UTC" }))}: ${esc({ DNP: "did not practice", LP: "limited", FP: "full" }[d.p] || d.p)}">${esc(dayLetter(d.d))} ${esc(d.p)}</span>`).join("")}</span>`
      : "";
    const from = p.from && p.from !== p.status ? ` from ${p.from === "ACT" ? "active" : esc(p.from)}` : "";
    return `<div class="pr${fresh ? " fresh" : ""}">
      <span class="st ${esc(p.status)}" title="${esc(STATUS[p.status] || p.status)}">${esc(p.status)}</span>
      <div class="nm">${esc(p.name)}<small>${esc(p.pos)} · ${esc(p.team)}</small>${fresh ? `<span class="newtag">NEW</span>` : ""}</div>
      <div class="when" title="${esc(new Date(p.since).toLocaleString())}">${esc(ago(p.since))}${from ? `<br><span style="font-size:.9em">${from}</span>` : ""}</div>
      <div class="meta">${prac}${p.opp ? `<span>${esc(gameText(p))}</span>` : `<span>No game scheduled</span>`}</div>
    </div>`;
  }

  function render() {
    // sort buttons
    for (const b of $("sortbar").querySelectorAll("button")) {
      const on = b.dataset.sort === S.sort;
      b.setAttribute("aria-pressed", on);
      b.innerHTML = esc(b.textContent.replace(/[↑↓]/g, "").trim()) + (on ? `<span class="ar">${S.dir === 1 ? "↑" : "↓"}</span>` : "");
    }
    // counts
    const c = {}; for (const p of S.players) c[p.status] = (c[p.status] || 0) + 1;
    $("counts").innerHTML = Object.keys(STATUS).filter((k) => c[k]).map((k) =>
      `<span class="count"><span class="st ${k} sm">${k}</span>${c[k]} ${esc(STATUS[k].toLowerCase())}</span>`).join("");

    const list = visible();
    $("shown").textContent = S.players.length ? `Showing ${list.length} of ${S.players.length} players.` : "";
    if (!list.length) {
      $("list").innerHTML = `<div class="empty">${S.players.length ? "No players match those filters." : "No fantasy players are on the injury report right now."}</div>`;
      return;
    }
    // group headers when sorted by team or status, so long lists are easy to scan
    let html = "", group = null;
    for (const p of list) {
      const g = S.sort === "team" ? p.team : S.sort === "status" ? p.status : null;
      if (g !== null && g !== group) {
        group = g;
        const n = list.filter((x) => (S.sort === "team" ? x.team : x.status) === g).length;
        const label = S.sort === "team" ? (TEAMS[g] || g) : (STATUS[g] || g);
        html += `<div class="grp">${esc(label)}<small>${n} player${n === 1 ? "" : "s"}</small></div>`;
      }
      html += row(p);
    }
    $("list").innerHTML = html;
  }

  function renderLive() {
    const dot = $("dot"), t = $("liveText");
    const stale = S.fetchedAt && Date.now() - S.fetchedAt > REFRESH_MS * 2.5;
    dot.className = "dot" + (S.err ? " err" : stale ? " stale" : "");
    if (!S.fetchedAt) { t.textContent = S.err ? "Couldn't reach the report. Retrying shortly." : "Loading the latest report…"; return; }
    t.textContent = `Refreshed ${ago(S.fetchedAt)}${S.lastChange ? ` · last status change ${ago(S.lastChange)}` : ""} · updates automatically every 2 minutes${S.err ? " (last try failed, retrying)" : ""}`;
  }

  /* ---------- auto refresh (only while the tab is visible) ---------- */
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(async () => { await load(); schedule(); }, REFRESH_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(timer); return; }
    if (Date.now() - S.fetchedAt > REFRESH_MS) load().then(schedule); else schedule();
  });
  setInterval(renderLive, 30 * 1000); // keep "refreshed X min ago" honest

  /* ---------- controls ---------- */
  let qTimer = null;
  $("q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = $("q").value; writeUrl(); render(); }, 150); });
  for (const id of ["team", "pos", "status"]) $(id).addEventListener("change", () => { S[id] = $(id).value; writeUrl(); render(); });
  $("sortbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]"); if (!b) return;
    const k = b.dataset.sort;
    if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = DIR[k]; }
    writeUrl(); render();
  });

  /* ---------- one ad, created once, never in the Play app ---------- */
  function ads() {
    let play = false;
    try {
      if (document.referrer.startsWith("android-app://")) sessionStorage.setItem("fit-play", "1");
      play = sessionStorage.getItem("fit-play") === "1";
    } catch { /* ignore */ }
    if (!CFG.ADSENSE_CLIENT || !CFG.ADSENSE_SLOT || play) return;
    const box = $("adbox");
    box.innerHTML = `<div class="adlabel">Advertisement</div><ins class="adsbygoogle" style="display:block" data-ad-client="${esc(CFG.ADSENSE_CLIENT)}" data-ad-slot="${esc(CFG.ADSENSE_SLOT)}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
    box.hidden = false;
    const js = document.createElement("script");
    js.async = true; js.crossOrigin = "anonymous";
    js.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(CFG.ADSENSE_CLIENT)}`;
    document.head.appendChild(js);
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* ad blocker */ }
  }

  /* ---------- start ---------- */
  readUrl();
  $("q").value = S.q; $("pos").value = S.pos; $("status").value = S.status;
  render();
  load().then(schedule);
  ads();
})();
