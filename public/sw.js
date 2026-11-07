/**
 * Service worker for the scan station.
 *
 * Two jobs, and deliberately no more:
 *
 * 1. **Keep the shell available offline.** The HTML, CSS and JavaScript are
 *    cached so a network drop mid-clinic does not leave a blank page.
 *
 * 2. **Stay out of the way of the API.** Every /api/ request goes straight to
 *    the network, never to a cache. Serving a stale device list at a check-out
 *    desk would be worse than an error — someone would lend out a device that
 *    is already gone.
 *
 * The offline *queue* is not here. It lives in IndexedDB, driven by the page,
 * because replaying a check-in needs to report its result into the UI and to
 * stop on a genuine conflict — a background sync that silently retried
 * check-outs could double-issue equipment.
 */

const CACHE = 'loaner-shell-v1';

/**
 * The shell only. Deliberately excludes anything under /api/ and any
 * user-specific page.
 */
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/capture.js',
  '/js/offline.js',
  '/js/views/dashboard.js',
  '/js/views/devices.js',
  '/js/views/loans.js',
  '/js/views/requests.js',
  '/js/views/directory.js',
  '/js/views/admin.js',
  '/js/views/insights.js',
  '/js/views/scan.js',
  '/js/views/workshop.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll fails atomically if any single file 404s, which would leave no
      // cache at all. Fetch individually and keep whatever succeeds.
      .then((cache) => Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => null)),
      ))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the API, the installer, or stored attachments.
  if (url.pathname.startsWith('/api/')
      || url.pathname.startsWith('/health')
      || url.pathname.startsWith('/install')) {
    return;
  }

  // Network first, falling back to the cached shell. This keeps a deployed
  // update arriving immediately when online, which matters because the app
  // has no build step and therefore no cache-busting filenames.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;

        // A navigation with nothing cached still gets the shell, so the app
        // can boot and show its own offline state rather than the browser's.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }

        return new Response('Offline and not cached.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      }),
  );
});
