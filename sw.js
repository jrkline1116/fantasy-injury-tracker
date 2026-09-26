// Bump VERSION on every release so phones pick up the new files.
const VERSION = "2.5.2";
const CACHE = "fit-" + VERSION;
const SHELL = ["./", "./index.html", "./app.css", "./app.js", "./config.js", "./manifest.json",
  "./icons/icon-96.png", "./icons/badge-96.png", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
  if (e.data === "version") e.source?.postMessage({ version: VERSION });
});

// App files: network first (so updates land fast), cache as offline fallback.
// Everything else (Supabase, CDNs) goes straight to the network.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request, { cache: "no-cache" });
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    } catch {
      return (await caches.match(e.request)) || (await caches.match("./index.html")) || Response.error();
    }
  })());
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Fantasy Injury Assist", body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Fantasy Injury Assist", {
    body: d.body || "",
    tag: d.tag,
    renotify: !!d.tag,
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png",
    data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) if (w.url.startsWith(self.registration.scope)) { await w.focus(); w.navigate?.(target); return; }
    await self.clients.openWindow(target);
  })());
});
