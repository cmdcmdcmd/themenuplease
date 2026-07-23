const CACHE_NAME = "menu-stp-v1";
const SHELL_ASSETS = [
  "/",
  "/css/style.css",
  "/js/app.js",
  "/manifest.webmanifest",
  "/fonts/fredoka-500.ttf",
  "/fonts/fredoka-600.ttf",
  "/fonts/fredoka-700.ttf",
  "/fonts/quicksand-400.ttf",
  "/fonts/quicksand-500.ttf",
  "/fonts/quicksand-600.ttf",
  "/fonts/quicksand-700.ttf",
  "/fonts/caveat-600.ttf",
  "/fonts/caveat-700.ttf",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API : toujours le réseau (données vivantes), jamais de cache.
  if (url.pathname.startsWith("/api/")) return;

  // App shell : cache d'abord, réseau en secours.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            return res;
          })
          .catch(() => cached)
      );
    })
  );
});
