const CACHE = "norte-padel-v70";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./config.js",
  "./app.js",
  "./matching.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./hero-cancha.jpg",
  "./brasil-tour.jpg",
  "./destacados-fondo.jpg",
  "./pelotas.jpg",
  "./hero-torneos.jpg",
  "./hero-ranking.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL))
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

// Cache-first para el shell, red primero para todo lo demás (datos de Supabase siempre frescos)
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
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
      badge: "icon-192.png"
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow("./index.html");
    })
  );
});
