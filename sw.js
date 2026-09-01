// 출퇴근 기록부 서비스 워커
// 전략: 캐시 즉시 표시(빠른 실행) + 백그라운드 갱신(stale-while-revalidate)
// → 앱이 네트워크를 기다리지 않고 바로 뜨고, 새 버전은 다음 실행에 반영된다.

const CACHE = 'checkin-v18';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(cached => {
      const fetched = fetch(e.request)
        .then(r => {
          if (r.ok && new URL(e.request.url).origin === location.origin) {
            const copy = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return r;
        })
        .catch(() => cached || caches.match('./index.html'));
      // 캐시가 있으면 즉시 반환하고 네트워크 갱신은 백그라운드에서
      return cached || fetched;
    })
  );
});
