/**
 * Remote scanner pairing over Server-Sent Events.
 *
 * The problem this solves: a check-in desk has a browser but no scanner, and
 * the tech has a phone in their pocket. Pairing lets the phone act as the
 * scanner for that desk — the desktop opens a channel, shows a short code and
 * a QR of the join URL, the phone joins and pushes every decoded barcode to
 * the desktop in real time.
 *
 * SSE rather than WebSockets: it is one-directional (server → desktop), it
 * survives shared-hosting proxies that refuse WebSocket upgrades, and it
 * reconnects on its own. Phones POST their scans over ordinary HTTP.
 *
 * Subscribers live in process memory; the channel itself lives in MySQL so the
 * pairing code survives a restart even though the open connection does not.
 */

import { execute, query, queryOne } from '../db.js';
import { randomCode, notFound, forbidden, HttpError } from './util.js';

/** channelId -> Set of { res, userId } */
const subscribers = new Map();

const HEARTBEAT_MS = 25000;

/**
 * Open a channel for a desktop station.
 * The pairing code is short because someone has to read it off one screen and
 * type it into another.
 */
export async function createChannel(organizationId, userId, { label = null, ttlMinutes = 240 } = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pairCode = randomCode(6);
    try {
      const result = await execute(
        `INSERT INTO scan_channels (organization_id, pair_code, label, owner_id, expires_at)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
        [organizationId, pairCode, label, userId, Number(ttlMinutes) || 240],
      );
      return {
        id: result.insertId,
        pair_code: pairCode,
        label,
        expires_in_minutes: Number(ttlMinutes) || 240,
      };
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY') continue; // Code already in use; try another.
      throw err;
    }
  }
  throw new Error('Could not allocate a unique pairing code.');
}

export async function getChannelByCode(organizationId, pairCode) {
  return queryOne(
    `SELECT * FROM scan_channels
      WHERE pair_code = ? AND organization_id = ? AND expires_at > NOW()`,
    [String(pairCode || '').toUpperCase(), organizationId],
  );
}

export async function getChannel(organizationId, channelId) {
  return queryOne(
    'SELECT * FROM scan_channels WHERE id = ? AND organization_id = ? AND expires_at > NOW()',
    [channelId, organizationId],
  );
}

export async function closeChannel(organizationId, channelId, userId) {
  const channel = await getChannel(organizationId, channelId);
  if (!channel) throw notFound('That scan channel does not exist or has already expired.');
  if (channel.owner_id !== userId) {
    throw forbidden('Only the station that opened a scan channel can close it.');
  }

  broadcast(channelId, { type: 'closed', reason: 'The station closed this channel.' });
  disconnectAll(channelId);
  await execute('DELETE FROM scan_channels WHERE id = ?', [channelId]);
  return { closed: true };
}

/**
 * Attach an SSE response to a channel.
 * Returns a cleanup function the route registers on the request's close event.
 */
export function subscribe(channelId, res, { userId = null } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Passenger and nginx buffer responses by default, which holds SSE frames
    // until the buffer fills — this header disables that.
    'X-Accel-Buffering': 'no',
  });

  // Tell the browser to wait 3s before reconnecting, and send an initial
  // comment so the connection is not considered idle.
  res.write('retry: 3000\n');
  res.write(': connected\n\n');

  if (!subscribers.has(channelId)) subscribers.set(channelId, new Set());
  const entry = { res, userId };
  subscribers.get(channelId).add(entry);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    const set = subscribers.get(channelId);
    if (set) {
      set.delete(entry);
      if (set.size === 0) subscribers.delete(channelId);
    }
    try { res.end(); } catch { /* already closed */ }
  };

  return cleanup;
}

/** Push an event to every listener on a channel. */
export function broadcast(channelId, payload) {
  const set = subscribers.get(channelId);
  if (!set || set.size === 0) return 0;

  const frame = `event: ${payload.type || 'message'}\ndata: ${JSON.stringify(payload)}\n\n`;
  let delivered = 0;

  for (const entry of [...set]) {
    try {
      entry.res.write(frame);
      delivered += 1;
    } catch {
      // Listener has gone away; drop it rather than retrying forever.
      set.delete(entry);
    }
  }

  return delivered;
}

function disconnectAll(channelId) {
  const set = subscribers.get(channelId);
  if (!set) return;
  for (const entry of [...set]) {
    try { entry.res.end(); } catch { /* already closed */ }
  }
  subscribers.delete(channelId);
}

/** How many stations are currently listening — shown on the phone's screen. */
export function listenerCount(channelId) {
  return subscribers.get(channelId)?.size ?? 0;
}

/**
 * Push a scan from a phone to the paired station.
 *
 * Returns delivered:0 when nobody is listening, which the phone shows as
 * "station disconnected" rather than silently accepting the scan.
 */
export async function pushScan(organizationId, pairCode, barcode, { source = 'camera', userId = null } = {}) {
  const channel = await getChannelByCode(organizationId, pairCode);
  if (!channel) {
    throw notFound('That pairing code is not valid, or the channel has expired. Ask the station for a new code.');
  }

  const delivered = broadcast(channel.id, {
    type: 'scan',
    barcode,
    source,
    scanned_by: userId,
    at: new Date().toISOString(),
  });

  await execute(
    'UPDATE scan_channels SET last_scan_at = NOW(), scan_count = scan_count + 1 WHERE id = ?',
    [channel.id],
  );

  return { delivered, channel_id: channel.id, listeners: listenerCount(channel.id) };
}

/** Remove expired channels and drop any sockets still attached to them. */
export async function pruneExpiredChannels() {
  const expired = await query('SELECT id FROM scan_channels WHERE expires_at < NOW()');
  for (const row of expired) {
    broadcast(row.id, { type: 'closed', reason: 'This channel expired.' });
    disconnectAll(row.id);
  }
  const result = await execute('DELETE FROM scan_channels WHERE expires_at < NOW()');
  return result.affectedRows;
}

/** Close every stream — used during shutdown so the process can exit. */
export function shutdown() {
  for (const channelId of [...subscribers.keys()]) {
    broadcast(channelId, { type: 'closed', reason: 'The server is restarting.' });
    disconnectAll(channelId);
  }
}
