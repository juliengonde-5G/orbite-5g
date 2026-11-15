/*
 * Service worker d'Orbite : garde l'interface en cache pour un démarrage
 * instantané et hors connexion. Les données (/api) ne sont jamais mises en
 * cache ici : elles restent sur le serveur, derrière le PIN.
 */
const CACHE = 'orbite-shell-v6';
const SHELL = ['/', '/style.css', '/client/app.js', '/favicon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Réseau d'abord (mises à jour immédiates), cache en secours hors connexion.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(event.request)
          // Hors connexion, le secours « accueil » n'est valable que pour la racine : une famille
          // ne doit jamais retomber sur la page d'une autre.
          .then((hit) => hit || (url.pathname === '/' ? caches.match('/') : Response.error())),
      ),
  );
});

// Notifications : le serveur envoie { title, body, url, tag }, chiffré de bout en bout.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Orbite';
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icons/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // La notification rouvre la fenêtre de sa propre famille (`/f/<nom>/`), jamais celle d'une autre.
      const family = /^\/f\/[a-z0-9-]+\//.exec(new URL(url).pathname)?.[0] ?? null;
      const open = list.find((c) => {
        const target = new URL(c.url);
        if (target.origin !== self.location.origin) return false;
        return family ? target.pathname.startsWith(family) : !target.pathname.startsWith('/f/');
      });
      if (open) return open.navigate(url).then((c) => (c || open).focus());
      return self.clients.openWindow(url);
    }),
  );
});
