const CACHE = 'jony-kids-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith('http')) return;
  if (e.request.url.includes('supabase')) { e.respondWith(fetch(e.request)); return; }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
    if (!res || res.status !== 200) return res;
    const clone = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, clone));
    return res;
  })));
});

self.addEventListener('push', e => {
  const data = e.data?.json() || { title: 'JONY KIDS', body: 'Yangi bildirishnoma' };
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [100, 50, 100]
  }));
});
