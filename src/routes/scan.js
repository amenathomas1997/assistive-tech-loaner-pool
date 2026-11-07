/**
 * Scanner endpoints.
 *
 * Three input paths, all landing on the same lookup and the same loan rules:
 *
 *   1. HID keyboard-wedge — the scanner types the barcode and presses Enter.
 *      Entirely client-side; no endpoint needed beyond the device lookup.
 *   2. In-browser camera — decoded in the page, then looked up the same way.
 *   3. Remote phone — a phone joins a paired channel and pushes scans here,
 *      which are relayed over SSE to whichever desktop opened the channel.
 */

import express from 'express';
import {
  asyncRoute, str, int, notFound, badRequest, forbidden,
} from '../lib/util.js';
import { requireCapability } from '../lib/auth.js';
import {
  createChannel, getChannel, getChannelByCode, closeChannel,
  subscribe, pushScan, listenerCount,
} from '../lib/scanhub.js';
import { getSettings } from '../lib/settings.js';
import { normaliseScan, qrSvg } from '../lib/barcode.js';
import { resolveDevice, getActiveLoanForDevice, decorateLoan } from '../lib/loans.js';
import { getDevice } from '../lib/devices.js';
import { getConfig } from '../config.js';

const router = express.Router();

/**
 * Resolve a scan to a device and say what should happen next.
 *
 * POST rather than GET so barcodes never land in access logs or browser
 * history — a device barcode is not secret, but a URL full of them is a
 * needless inventory leak.
 */
router.post('/lookup', requireCapability('scan.use'), asyncRoute(async (req, res) => {
  const raw = str(req.body?.barcode) ?? str(req.body?.code);
  const barcode = normaliseScan(raw);

  if (!barcode) throw badRequest('No barcode was received. Try scanning again.');

  const device = await resolveDevice(req.auth.organizationId, barcode);

  if (!device) {
    return res.status(404).json({
      error: {
        code: 'device_not_found',
        message: `Nothing in this pool matches "${barcode}".`,
        details: {
          scanned: barcode,
          hint:
            'Check the label belongs to this system. If the device is real but unlabelled, ' +
            'find it by name and use manual check-in or check-out.',
        },
      },
    });
  }

  const full = await getDevice(req.auth.organizationId, device.id);
  const activeLoan = await getActiveLoanForDevice(device.id);

  res.json({
    scanned: barcode,
    device: full,
    active_loan: activeLoan ? decorateLoan(activeLoan) : null,
    suggested_action: activeLoan
      ? 'check_in'
      : ['available', 'reserved'].includes(device.status)
        ? 'check_out'
        : 'blocked',
    blocked_reason: !activeLoan && !['available', 'reserved'].includes(device.status)
      ? `This device is marked "${device.status.replace('_', ' ')}".`
      : null,
  });
}));

// ---------------------------------------------------------------------------
// Remote scanner pairing
// ---------------------------------------------------------------------------

/** Open a channel. The desktop shows the returned code and join URL as a QR. */
router.post('/channels', requireCapability('scan.use'), asyncRoute(async (req, res) => {
  const settings = await getSettings(req.auth.organizationId);
  if (!settings['scan.remote_enabled']) {
    throw forbidden('Remote scanner pairing is switched off in settings.');
  }

  const channel = await createChannel(req.auth.organizationId, req.auth.userId, {
    label: str(req.body?.label, { max: 120 }),
    ttlMinutes: Number(settings['scan.channel_ttl_minutes']) || 240,
  });

  const base = getConfig()?.baseUrl
    || `${req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http'}://${req.get('host')}`;
  const joinUrl = `${String(base).replace(/\/$/, '')}/scanner.html?code=${channel.pair_code}`;

  res.status(201).json({
    channel,
    join_url: joinUrl,
    join_qr_svg: await qrSvg(joinUrl, { size: 220 }),
    // Camera access is gated on a secure context by every current browser.
    https_warning: joinUrl.startsWith('https://') || joinUrl.includes('localhost')
      ? null
      : 'Phone cameras only work over HTTPS. This link is plain HTTP, so the camera scanner will not start ' +
        'on the phone — serve the app over HTTPS to use remote scanning.',
  });
}));

/**
 * Server-Sent Events stream for a station.
 *
 * EventSource cannot send an Authorization header, so this relies on the
 * session cookie — which is why remote scanning is available to signed-in
 * users only and not to API keys.
 */
router.get('/channels/:id/stream', requireCapability('scan.use'), asyncRoute(async (req, res) => {
  const channel = await getChannel(req.auth.organizationId, Number(req.params.id));
  if (!channel) throw notFound('That scan channel does not exist or has expired.');

  if (channel.owner_id !== req.auth.userId) {
    throw forbidden('Only the station that opened this channel can listen to it.');
  }

  const cleanup = subscribe(channel.id, res, { userId: req.auth.userId });
  req.on('close', cleanup);
}));

router.get('/channels/:id', requireCapability('scan.use'), asyncRoute(async (req, res) => {
  const channel = await getChannel(req.auth.organizationId, Number(req.params.id));
  if (!channel) throw notFound('That scan channel does not exist or has expired.');

  res.json({
    channel: {
      ...channel,
      listeners: listenerCount(channel.id),
    },
  });
}));

router.delete('/channels/:id', requireCapability('scan.use'), asyncRoute(async (req, res) => {
  res.json(await closeChannel(req.auth.organizationId, Number(req.params.id), req.auth.userId));
}));

/**
 * The phone's view of a channel: confirms the code is live before the camera
 * is started, so a mistyped code fails immediately rather than after a scan.
 */
router.get('/join/:code', requireCapability('scan.use'), asyncRoute(async (req, res) => {
  const channel = await getChannelByCode(req.auth.organizationId, req.params.code);
  if (!channel) {
    throw notFound('That pairing code is not valid or has expired. Ask the station to show a new one.');
  }

  res.json({
    channel: {
      id: channel.id,
      pair_code: channel.pair_code,
      label: channel.label,
      expires_at: channel.expires_at,
      scan_count: channel.scan_count,
    },
    station_connected: listenerCount(channel.id) > 0,
  });
}));

/** Push a scan from the phone to the station. */
router.post('/join/:code', requireCapability('scan.use'), asyncRoute(async (req, res) => {
  const barcode = normaliseScan(str(req.body?.barcode));
  if (!barcode) throw badRequest('No barcode was received.');

  const result = await pushScan(req.auth.organizationId, req.params.code, barcode, {
    source: str(req.body?.source) || 'camera',
    userId: req.auth.userId,
  });

  // Also resolve it here, so the phone can show what was scanned rather than
  // just a code — useful confirmation when the station is in another room.
  const device = await resolveDevice(req.auth.organizationId, barcode);

  res.json({
    ...result,
    barcode,
    device: device ? { id: device.id, name: device.name, barcode: device.barcode, status: device.status } : null,
    delivered_to_station: result.delivered > 0,
    message: result.delivered > 0
      ? 'Sent to the station.'
      : 'Scanned, but no station is listening right now. Check the desktop still has the scan page open.',
  });
}));

export default router;
