// Service worker : garde une copie de l'app sur le téléphone pour qu'elle marche sans réseau.
// Stratégie : on sert la copie en cache tout de suite, et on la met à jour en arrière-plan
// quand le réseau est dispo. Si une nouvelle version s'installe, la page se recharge toute seule (voir app.js).
// Pense à changer le numéro de CACHE à chaque mise à jour de l'app.
const CACHE = 'muscu-v16';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './exercises.js',
  './muscles.js',
  './app.js',
  './manifest.json',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' : on va chercher les fichiers frais sur le serveur, pas une vieille copie du navigateur
  const fresh = ASSETS.map((url) => new Request(url, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== location.origin) return;

  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = (await cache.match(req, { ignoreSearch: true }))
      || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    const network = fetch(req)
      .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => undefined);
    if (cached) { e.waitUntil(network); return cached; }
    return (await network) || new Response('Hors ligne', { status: 503 });
  }));
});
