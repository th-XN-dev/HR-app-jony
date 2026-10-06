// JONY KIDS Service Worker — network-first (yangilanish darhol ko'rinadi)
const CACHE = 'jony-kids-v11';
const ASSETS = ['./', './index.html', './app.js', './styles.css', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting(); // yangi SW darhol faollashsin
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Xabar orqali darhol yangilash (index.html so'rasa)
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (!url.startsWith('http')) return;

  // Supabase / API — har doim tarmoqdan, keshlanmaydi (ma'lumot va tokenlar keshga tushmasin)
  if (url.includes('supabase.co') || url.includes('/rest/') || url.includes('/auth/') || url.includes('/storage/') || url.includes('/functions/')) {
    return; // brauzer o'zi hal qiladi
  }
  if (e.request.method !== 'GET') return;

  // HTML va asosiy fayllar — NETWORK-FIRST (avval yangi versiya, kesh faqat zaxira)
  const isHTML = e.request.mode === 'navigate' || url.endsWith('.html') || url.endsWith('/');
  const path = new URL(url).pathname;
  const isCore = /\/(index\.html|sw\.js|manifest\.json|app\.js|styles\.css)$/.test(path);

  if (isHTML || isCore) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Boshqa statik (rasm, ikonka) — cache-first (tezlik uchun)
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res && res.status === 200 && res.type !== 'opaque') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => r))
  );
});

self.addEventListener('push', e => {
  let data = { title: 'JONY KIDS', body: 'Yangi bildirishnoma' };
  try { if (e.data) data = e.data.json(); } catch (_) {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: './icon-192.png', badge: './icon-192.png', vibrate: [100, 50, 100]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow('./');
  }));
});
