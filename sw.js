// StudyFlow service worker: lets the installed app open offline.
// Pages load from the network first so updates show right away; the saved copy is used only when offline.
// Bump VERSION when the list of app files changes.
const VERSION = 'studyflow-v2';
const APP_FILES = ['./', 'index.html', 'manifest.webmanifest', 'wordle-words.txt', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('studyflow-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // Only this site's own files. Google sign-in, Classroom, and the Schoology relay always go straight to the network.
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./', copy)); }
      return res;
    }).catch(() => caches.match('./', { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok && APP_FILES.some(p => url.pathname.endsWith(p.replace('./', '/')))) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
