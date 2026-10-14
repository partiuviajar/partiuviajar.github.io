// Service worker: deixa o app abrir rápido/offline e recebe as notificações do robô.
const CACHE = "radar-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Arquivos do app: tenta a rede primeiro (pega atualizações), cai no cache sem internet.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data?.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || "✈️ Radar de Voos", {
      body: data.body || "Preço baixo encontrado!",
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { url: data.url || "./" },
      tag: data.url || "radar",
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.registration.scope)) { w.navigate(target); return w.focus(); }
      }
      return self.clients.openWindow(target);
    })
  );
});
