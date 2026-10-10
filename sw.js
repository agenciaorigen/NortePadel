const CACHE = "norte-padel-v203";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./config.js",
  "./app.js",
  "./vendor/supabase.js",
  "./privacidad.html",
  "./matching.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./foto-portada-movil.jpg",
  "./foto-portada.jpg",
  "./foto-cancha.jpg",
  "./brasil-tour.jpg",
  "./destacados-fondo.jpg",
  "./pelotas.jpg",
  "./foto-torneos.jpg",
  "./foto-ranking.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    // "reload": cada archivo se pide a la red y no a la caché del navegador; si no,
    // puede quedar guardado un index.html viejo junto a un app.js nuevo (y se rompe)
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL.map((u) => new Request(u, { cache: "reload" }))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Páginas, código y estilos: red primero (así nadie queda con una versión vieja, por
// ejemplo la que pedía iniciar sesión para ver fotos); sin conexión, lo guardado.
// Imágenes del shell: caché primero. Datos de Supabase (otro origen): no se tocan.
const FRESCO = ["document", "script", "style", "manifest"];
self.addEventListener("fetch", (event) => {
  const req = event.request, url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== "GET") return;
  if (FRESCO.includes(req.destination)) {
    event.respondWith(
      fetch(req, { cache: "no-cache" }).then((r) => {
        if (r.ok && !url.search) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
        return r;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((c) => c || caches.match("./index.html")))
    );
    return;
  }
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});

// Notificaciones push reales (cuando el organizador configure el envío server-side con VAPID)
self.addEventListener("push", (event) => {
  let data = { title: "Norte Padel", body: "Tenés una novedad en tu torneo." };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    data.body = event.data ? event.data.text() : data.body;
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Norte Padel", {
      body: data.body,
      icon: "icon-192.png",
      badge: "icon-192.png",
      data: { url: data.url || "./" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    // abre (o lleva) la app a la pantalla del aviso, ej. el torneo del partido
    self.clients.matchAll({ type: "window" }).then((clients) => {
      const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
      if (clients.length > 0) return clients[0].navigate(url).then((c) => (c || clients[0]).focus());
      return self.clients.openWindow(url);
    })
  );
});
