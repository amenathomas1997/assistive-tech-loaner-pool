/**
 * Offline queue for the scan station.
 *
 * A returns desk at a clinic loses its network more often than anyone plans
 * for. This queues check-ins taken while offline in IndexedDB and replays them
 * in order when the connection comes back.
 *
 * Two deliberate limits:
 *
 * - **Only check-ins are queued, never check-outs.** A check-out needs to know
 *   the device is free *now*; replaying one an hour later could issue equipment
 *   that someone else has already taken. Offline check-out is refused with an
 *   explanation rather than silently deferred.
 *
 * - **A conflict on replay stops that item, not the queue.** If a device was
 *   already checked in by someone else, that entry is marked failed and left
 *   for a human to look at — retrying forever would never succeed, and dropping
 *   it silently would lose the record that it was scanned at all.
 */

const DB_NAME = 'loaner-offline';
const DB_VERSION = 1;
const STORE = 'queue';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('status', 'status');
        store.createIndex('queued_at', 'queued_at');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function transact(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;

    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }

    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

/** Add a check-in to the queue. */
export async function enqueueCheckin(payload) {
  await transact('readwrite', (store) => store.add({
    kind: 'checkin',
    payload,
    status: 'pending',
    queued_at: new Date().toISOString(),
    attempts: 0,
    error: null,
  }));

  return countPending();
}

export async function listQueue() {
  return transact('readonly', (store) => store.getAll());
}

export async function countPending() {
  const all = await listQueue();
  return all.filter((entry) => entry.status === 'pending').length;
}

export async function clearFailed() {
  const all = await listQueue();
  await transact('readwrite', (store) => {
    for (const entry of all) {
      if (entry.status === 'failed') store.delete(entry.id);
    }
  });
}

async function updateEntry(entry) {
  await transact('readwrite', (store) => store.put(entry));
}

async function removeEntry(id) {
  await transact('readwrite', (store) => store.delete(id));
}

/**
 * Replay everything pending, oldest first.
 *
 * `send` is injected rather than imported so this module has no dependency on
 * the API client, and so tests can drive it.
 */
export async function flushQueue(send, options = {}) {
  // One at a time. Coming back online, pressing "Send now" and a second
  // listener left behind by an earlier visit to the scan station could all
  // start a flush in the same moment, each reading the same pending entries
  // and each sending them: the same return posted two or three times, with
  // all but the first coming back as "that loan is already closed".
  if (flushing) {
    return { sent: 0, failed: 0, remaining: await countPending(), failures: [], busy: true };
  }

  flushing = true;

  try {
    return await runFlush(send, options);
  } finally {
    flushing = false;
  }
}

let flushing = false;

async function runFlush(send, { onProgress = null } = {}) {
  const all = await listQueue();
  const pending = all
    .filter((entry) => entry.status === 'pending')
    .sort((a, b) => a.queued_at.localeCompare(b.queued_at));

  const result = { sent: 0, failed: 0, remaining: 0, failures: [] };

  for (const entry of pending) {
    if (!navigator.onLine) break;

    try {
      await send(entry.payload);
      await removeEntry(entry.id);
      result.sent += 1;
    } catch (err) {
      entry.attempts += 1;
      entry.error = err.message;

      // A 4xx will never succeed on retry — the state it assumed has changed.
      // A network error will, so leave it pending.
      // 401 is the session, not the scan. It comes right once somebody signs
      // back in, and treating it as final threw away every queued return.
      // 408 and 429 are "not now" rather than "no": a long queue sent in one
      // burst can trip the rate limit, and that must not discard the rest.
      const permanent = err.status && err.status >= 400 && err.status < 500
        && ![401, 408, 429].includes(err.status);

      if (permanent || entry.attempts >= 5) {
        entry.status = 'failed';
        result.failed += 1;
        result.failures.push({
          barcode: entry.payload?.device || entry.payload?.loan_id,
          reason: err.message,
        });
      }

      await updateEntry(entry);
      if (!permanent) break; // Offline again; stop and try later.
    }

    onProgress?.(result);
  }

  result.remaining = await countPending();
  return result;
}

/** Register the service worker. Failure is not fatal — the app works without it. */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  if (!window.isSecureContext) return null; // Service workers need HTTPS.

  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (err) {
    console.warn('[offline] service worker registration failed:', err.message);
    return null;
  }
}

/** Call `handler(isOnline)` whenever connectivity changes, and once now. */
export function watchConnectivity(handler) {
  const notify = () => handler(navigator.onLine);
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  notify();

  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
}
