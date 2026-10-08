/* Fantasy Injury Assist: NFL injury report, shared by two places.
   - injuries.html: the public page (no sign-in). Sort/filter choices live in the URL so a view can be shared.
   - the app's "Injuries" tab (index.html / app.js): same report, plus a "My players" filter and YOURS tags.
   Data comes from one read-only database function (migration 013) and refreshes every 2 minutes,
   only while the report is on screen and the tab is visible.

   Usage: const r = InjuryReport.create({ urlState: true })      -> r.el is the report's DOM node
          r.attach(parentEl)   put it on screen (reuses the same node, so filters and sort survive tab switches)
          r.setMine(map)       Map of player id -> "Team A, Team B" for the signed-in user's rostered players */
(() => {
  "use strict";
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
  const DIR = { team: 1, name: 1, status: -1, pos: 1, since: -1, game: 1 }; // first-click direction per sort
  const PRAC = { DNP: "did not practice", LP: "limited", FP: "full" };

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
  function gameText(p) {
    if (!p.opp) return "No game scheduled";
    const vs = p.opp.startsWith("@") ? p.opp : "vs " + p.opp;
    if (p.live) return `${vs} · in progress`;
    const k = new Date(p.kickoff);
    return `${vs} · ${k.toLocaleDateString([], { weekday: "short" })} ${k.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  const dayLetter = (iso) => ["Su", "M", "Tu", "W", "Th", "F", "Sa"][new Date(iso + "T12:00:00Z").getUTCDay()];
  const dayName = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString([], { weekday: "long", timeZone: "UTC" });

  function create(opts = {}) {
    const CFG = window.FIT_CONFIG || {};
    const urlState = !!opts.urlState;
    const S = { players: [], prev: null, fresh: new Set(), fetchedAt: 0, lastChange: null, err: false, loading: false,
      mine: null, onlyMine: false, q: "", team: "", pos: "", status: "", sort: "team", dir: 1 };

    const el = document.createElement("div");
    el.className = "irep";
    el.innerHTML = `
      <div class="live"><span class="dot"></span><span class="liveText">Loading the latest report…</span></div>
      <div class="counts" aria-label="Players by designation"></div>
      <div class="controls" role="search">
        <input class="full" data-f="q" type="search" placeholder="Search a player" aria-label="Search a player" autocomplete="off">
        <select data-f="team" aria-label="Team"><option value="">All teams</option></select>
        <select data-f="pos" aria-label="Position"><option value="">All positions</option><option>QB</option><option>RB</option><option>WR</option><option>TE</option><option>K</option></select>
        <select data-f="status" aria-label="Designation"><option value="">All designations</option><option value="GAME">Game-time (Q / D / O)</option>
          <option value="Q">Questionable</option><option value="D">Doubtful</option><option value="O">Out</option><option value="IR">Injured reserve</option><option value="SUS">Suspended</option></select>
      </div>
      <div class="sortbar" role="group" aria-label="Sort by">
        <button class="minechip" data-mine hidden aria-pressed="false">My players</button>
        <span class="lbl">Sort</span>
        <button data-sort="team">Team</button><button data-sort="name">Player</button><button data-sort="status">Status</button>
        <button data-sort="pos">Position</button><button data-sort="since">Latest change</button><button data-sort="game">Next game</button>
      </div>
      <div class="panel list" aria-live="polite"><div class="empty">Loading…</div></div>
      <p class="hint shown"></p>`;
    const q = (sel) => el.querySelector(sel);
    const f = (name) => q(`[data-f="${name}"]`);

    /* ---------- saved view ---------- */
    function restore() {
      let p;
      if (urlState) p = new URLSearchParams(location.search);
      else { try { p = new URLSearchParams(localStorage.getItem("fit-report") || ""); } catch { p = new URLSearchParams(); } }
      S.q = p.get("q") || ""; S.team = (p.get("team") || "").toUpperCase(); S.pos = (p.get("pos") || "").toUpperCase();
      S.status = (p.get("status") || "").toUpperCase(); S.onlyMine = p.get("mine") === "1";
      S.sort = DIR[p.get("sort")] ? p.get("sort") : "team";
      S.dir = p.get("dir") === "desc" ? -1 : p.get("dir") === "asc" ? 1 : DIR[S.sort];
      f("q").value = S.q; f("pos").value = S.pos; f("status").value = S.status;
    }
    function save() {
      const p = new URLSearchParams();
      if (S.q) p.set("q", S.q); if (S.team) p.set("team", S.team); if (S.pos) p.set("pos", S.pos);
      if (S.status) p.set("status", S.status); if (S.onlyMine) p.set("mine", "1");
      if (S.sort !== "team") p.set("sort", S.sort);
      if (S.dir !== DIR[S.sort]) p.set("dir", S.dir === 1 ? "asc" : "desc");
      const qs = p.toString();
      if (urlState) history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
      else { try { localStorage.setItem("fit-report", qs); } catch { /* ignore */ } }
    }

    /* ---------- data ---------- */
    async function load() {
      if (S.loading) return;
      if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) { S.err = true; renderLive(); return; }
      S.loading = true;
      try {
        const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/rpc/injury_report`, {
          method: "POST", headers: { apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: "{}", cache: "no-store",
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const players = Array.isArray(data?.players) ? data.players : [];
        // highlight anyone whose designation changed since the last refresh (not on the first load)
        const now = new Map(players.map((p) => [p.id, p.status]));
        S.fresh = new Set();
        if (S.prev) for (const [id, st] of now) if (S.prev.get(id) !== st) S.fresh.add(id);
        S.prev = now; S.players = players;
        S.lastChange = data?.last_change ? new Date(data.last_change) : null;
        S.fetchedAt = Date.now(); S.err = false;
        fillTeams(); render();
      } catch (e) {
        console.error("injury report", e);
        S.err = true;
        if (!S.players.length) q(".list").innerHTML = `<div class="empty">Couldn't load the report. It will try again in a couple of minutes.</div>`;
      } finally { S.loading = false; }
      renderLive();
    }

    /* ---------- filter + sort ---------- */
    function visible() {
      const term = S.q.trim().toLowerCase();
      const list = S.players.filter((p) =>
        (!term || p.name.toLowerCase().includes(term)) &&
        (!S.team || p.team === S.team) && (!S.pos || p.pos === S.pos) &&
        (!S.status || (S.status === "GAME" ? ["Q", "D", "O"].includes(p.status) : p.status === S.status)) &&
        (!S.onlyMine || !S.mine || S.mine.has(p.id)));
      const by = {
        team: (a, b) => (TEAMS[a.team] || a.team).localeCompare(TEAMS[b.team] || b.team),
        name: (a, b) => lastName(a.name).localeCompare(lastName(b.name)),
        status: (a, b) => (SEV[a.status] || 9) - (SEV[b.status] || 9),
        pos: (a, b) => (POS[a.pos] || 9) - (POS[b.pos] || 9),
        since: (a, b) => new Date(a.since) - new Date(b.since),
        game: (a, b) => new Date(a.kickoff) - new Date(b.kickoff),
      };
      const tie = (a, b) => ((SEV[a.status] || 9) - (SEV[b.status] || 9)) || ((POS[a.pos] || 9) - (POS[b.pos] || 9)) || lastName(a.name).localeCompare(lastName(b.name));
      return list.sort((a, b) => {
        if (S.sort === "game" && !a.kickoff !== !b.kickoff) return a.kickoff ? -1 : 1; // no game: always last
        return (by[S.sort](a, b) * S.dir) || tie(a, b);
      });
    }

    /* ---------- render ---------- */
    function fillTeams() {
      const sel = f("team");
      if (sel.options.length > 1) return;
      const have = new Set(S.players.map((p) => p.team));
      const codes = Object.keys(TEAMS).concat([...have].filter((t) => !TEAMS[t]));
      codes.sort((a, b) => (TEAMS[a] || a).localeCompare(TEAMS[b] || b));
      for (const c of codes) sel.add(new Option(TEAMS[c] || c, c));
      sel.value = S.team;
    }
    function row(p) {
      const fresh = S.fresh.has(p.id);
      const mine = S.mine?.get(p.id);
      const prac = Array.isArray(p.practice) && p.practice.length
        ? `<span class="pc" title="Practice this week">${p.practice.map((d) => `<span class="${esc(d.p)}" title="${esc(dayName(d.d))}: ${esc(PRAC[d.p] || d.p)}">${esc(dayLetter(d.d))} ${esc(d.p)}</span>`).join("")}</span>` : "";
      const from = p.from && p.from !== p.status ? `from ${p.from === "ACT" ? "active" : esc(p.from)}` : "";
      return `<div class="pr${fresh ? " fresh" : ""}${mine ? " mine" : ""}">
        <span class="st ${esc(p.status)}" title="${esc(STATUS[p.status] || p.status)}">${esc(p.status)}</span>
        <div class="nm">${esc(p.name)}<small>${esc(p.pos)} · ${esc(p.team)}</small>${fresh ? `<span class="tag newtag">NEW</span>` : ""}${mine ? `<span class="tag yourtag" title="On your team: ${esc(mine)}">YOURS</span>` : ""}</div>
        <div class="when" title="${esc(new Date(p.since).toLocaleString())}">${esc(ago(p.since))}${from ? `<br><span>${from}</span>` : ""}</div>
        <div class="meta">${prac}<span>${esc(gameText(p))}</span>${mine ? `<span class="myteams">${esc(mine)}</span>` : ""}</div>
      </div>`;
    }
    function render() {
      const mineBtn = q("[data-mine]");
      mineBtn.hidden = !S.mine;
      mineBtn.setAttribute("aria-pressed", !!(S.mine && S.onlyMine));
      for (const b of el.querySelectorAll("button[data-sort]")) {
        const on = b.dataset.sort === S.sort;
        b.setAttribute("aria-pressed", on);
        b.innerHTML = esc(b.textContent.replace(/[↑↓]/g, "").trim()) + (on ? `<span class="ar">${S.dir === 1 ? "↑" : "↓"}</span>` : "");
      }
      const c = {}; for (const p of S.players) c[p.status] = (c[p.status] || 0) + 1;
      q(".counts").innerHTML = Object.keys(STATUS).filter((k) => c[k]).map((k) =>
        `<span class="count"><span class="st ${k} sm">${k}</span>${c[k]} ${esc(STATUS[k].toLowerCase())}</span>`).join("");

      const list = visible();
      q(".shown").textContent = S.players.length ? `Showing ${list.length} of ${S.players.length} players.` : "";
      if (!S.fetchedAt) return;
      if (!list.length) {
        const msg = !S.players.length ? "No fantasy players are on the injury report right now."
          : S.onlyMine && S.mine ? (S.mine.size ? "None of your players are on the injury report. Nice." : "Add players to a team and they'll show up here when they're hurt.")
          : "No players match those filters.";
        q(".list").innerHTML = `<div class="empty">${msg}</div>`;
        return;
      }
      let html = "", group = null;
      const key = (x) => (S.sort === "team" ? x.team : S.sort === "status" ? x.status : null);
      for (const p of list) {
        const g = key(p);
        if (g !== null && g !== group) {
          group = g;
          const n = list.filter((x) => key(x) === g).length;
          html += `<div class="grp">${esc(S.sort === "team" ? (TEAMS[g] || g) : (STATUS[g] || g))}<small>${n} player${n === 1 ? "" : "s"}</small></div>`;
        }
        html += row(p);
      }
      q(".list").innerHTML = html;
    }
    function renderLive() {
      const stale = S.fetchedAt && Date.now() - S.fetchedAt > REFRESH_MS * 2.5;
      q(".dot").className = "dot" + (S.err ? " err" : stale ? " stale" : "");
      q(".liveText").textContent = !S.fetchedAt
        ? (S.err ? "Couldn't reach the report. Retrying shortly." : "Loading the latest report…")
        : `Refreshed ${ago(S.fetchedAt)}${S.lastChange ? ` · last status change ${ago(S.lastChange)}` : ""} · updates every 2 minutes${S.err ? " (last try failed, retrying)" : ""}`;
    }

    /* ---------- auto refresh: only while on screen and the browser tab is visible ---------- */
    const onScreen = () => el.isConnected && !document.hidden;
    setInterval(() => { if (onScreen() && Date.now() - S.fetchedAt >= REFRESH_MS - 1000) load(); }, 15 * 1000);
    setInterval(() => { if (el.isConnected) renderLive(); }, 30 * 1000);
    document.addEventListener("visibilitychange", () => { if (onScreen() && Date.now() - S.fetchedAt > REFRESH_MS) load(); });

    /* ---------- controls ---------- */
    let qTimer = null;
    f("q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = f("q").value; save(); render(); }, 150); });
    // Enter in the search box closes the phone keyboard
    f("q").addEventListener("keydown", (e) => { if (e.key === "Enter") f("q").blur(); });
    for (const k of ["team", "pos", "status"]) f(k).addEventListener("change", () => { S[k] = f(k).value; save(); render(); f(k).blur(); });
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-mine]")) { S.onlyMine = !S.onlyMine; save(); render(); return; }
      const b = e.target.closest("button[data-sort]"); if (!b) return;
      const k = b.dataset.sort;
      if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = DIR[k]; }
      save(); render();
    });

    restore();
    render();

    return {
      el,
      attach(parent) {
        if (el.parentNode !== parent) parent.appendChild(el);
        if (!S.fetchedAt || Date.now() - S.fetchedAt > REFRESH_MS) load(); else renderLive();
      },
      setMine(map) {
        const same = S.mine && map && S.mine.size === map.size && [...map].every(([k, v]) => S.mine.get(k) === v);
        if (same) return;
        S.mine = map; if (S.fetchedAt) render(); else q("[data-mine]").hidden = !S.mine;
      },
      refresh: load,
    };
  }

  window.InjuryReport = { create };
})();
