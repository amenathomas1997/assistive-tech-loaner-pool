/**
 * Phone scanner.
 *
 * Turns a phone into a barcode scanner for a paired desktop scan station.
 * The phone decodes locally and POSTs the value; the desktop picks it up by
 * short-polling, which is why there is no persistent connection here.
 *
 * The pairing code is the only credential, so this page can do exactly one
 * thing: hand a barcode to the desk.
 *
 * Deliberately a separate page from the main app: it is opened by scanning a
 * QR from the desktop, is used one-handed while holding equipment, and needs
 * nothing on screen but the camera and a confirmation of the last scan.
 */

import { api, ApiError } from './api.js';
import {
  el, clear, mount, field, alert as alertBox, announce, toastOk, toastError, withBusy,
} from './ui.js';

const root = document.getElementById('scanner-root');

const state = {
  code: new URLSearchParams(window.location.search).get('code') || '',
  channel: null,
  stream: null,
  loop: null,
  lastValue: null,
  lastAt: 0,
  sent: 0,
};

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

function renderJoin(message = null) {
  const codeField = field({
    name: 'code',
    label: 'Pairing code',
    value: state.code,
    required: true,
    help: 'The six-character code shown on the scan station screen.',
    autocomplete: 'off',
    inputmode: 'text',
  });
  codeField.control.style.textTransform = 'uppercase';
  codeField.control.style.fontFamily = 'var(--mono)';
  codeField.control.style.fontSize = '1.4rem';
  codeField.control.style.letterSpacing = '0.18em';
  codeField.control.style.textAlign = 'center';

  const joinButton = el('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, 'Connect');

  const form = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      codeField.setError(null);

      const code = codeField.control.value.trim().toUpperCase();
      if (!code) {
        codeField.setError('Enter the code shown on the scan station.');
        codeField.control.focus();
        return;
      }

      await withBusy(joinButton, 'Connecting…', async () => {
        try {
          const result = await api.joinScanChannel(code);
          state.code = code;
          state.channel = result.channel;
          renderScanner(result.station_connected);
        } catch (err) {
          codeField.setError(err.message);
          codeField.control.focus();
          announce(err.message, { assertive: true });
        }
      });
    },
  }, [codeField, joinButton]);

  mount(clear(root),
    message ? alertBox(message, { type: 'info' }) : null,
    el('p', {
      text:
        'Enter the pairing code shown on the scan station. Nothing to install and no sign-in needed — ' +
        'the code expires on its own.',
    }),
    form,
  );

  if (!state.code) codeField.control.focus();
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function renderScanner(stationConnected) {
  const video = el('video', { id: 'camera-preview', playsinline: true, muted: true });
  const status = el('p', { class: 'muted center', role: 'status' },
    stationConnected ? 'Connected. Point the camera at a barcode.' : 'Connected, but the station is not listening yet.');

  const lastScan = el('div', { style: { marginTop: '12px' } });
  const counter = el('p', { class: 'muted center', 'aria-live': 'polite' }, 'No scans sent yet.');

  const manualField = field({
    name: 'manual', label: 'Or type a barcode', autocomplete: 'off',
    help: 'Use this if the camera cannot read the label.',
  });

  const sendManual = el('button', { type: 'button', class: 'btn btn-block' }, 'Send this code');
  sendManual.addEventListener('click', () => {
    const value = manualField.control.value.trim();
    if (!value) {
      manualField.setError('Enter a barcode first.');
      manualField.control.focus();
      return;
    }
    manualField.setError(null);
    manualField.control.value = '';
    send(value, 'manual');
  });

  const stopButton = el('button', { type: 'button', class: 'btn btn-ghost btn-block' }, 'Disconnect');
  stopButton.addEventListener('click', () => {
    stopCamera();
    state.channel = null;
    renderJoin('Disconnected from the scan station.');
  });

  clear(root).append(
    el('div', { class: 'card', style: { background: 'var(--surface-alt)', marginBottom: '14px' } }, [
      el('p', { style: { margin: 0 } }, [
        el('strong', {}, 'Paired: '),
        el('span', { class: 'mono' }, state.channel.pair_code),
        state.channel.label ? ` · ${state.channel.label}` : '',
      ]),
    ]),
    video,
    status,
    lastScan,
    counter,
    el('hr', { class: 'divider' }),
    manualField,
    sendManual,
    el('hr', { class: 'divider' }),
    stopButton,
  );

  startCamera(video, status, lastScan, counter);
}

async function startCamera(video, status, lastScan, counter) {
  if (!window.isSecureContext) {
    status.textContent =
      'The camera needs a secure (HTTPS) connection. This page is on plain HTTP, so use the ' +
      '"type a barcode" box below instead.';
    announce(status.textContent, { assertive: true });
    return;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
    });
    video.srcObject = state.stream;
    await video.play();
    decodeLoop(video, lastScan, counter, status);
  } catch (err) {
    status.textContent = err.name === 'NotAllowedError'
      ? 'Camera permission was declined. Allow camera access, or type the barcode below.'
      : `Could not start the camera: ${err.message}. Type the barcode below instead.`;
    announce(status.textContent, { assertive: true });
  }
}

function stopCamera() {
  if (state.loop) { cancelAnimationFrame(state.loop); state.loop = null; }
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
}

async function decodeLoop(video, lastScan, counter, status) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  let detector = null;
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      detector = new window.BarcodeDetector({
        formats: formats.filter((f) =>
          ['qr_code', 'code_128', 'code_39', 'ean_13', 'upc_a', 'data_matrix'].includes(f)),
      });
    } catch { detector = null; }
  }

  if (!detector && !window.jsQR) {
    // Fallback reader, loaded only where the platform has no BarcodeDetector.
    await new Promise((resolve) => {
      const script = el('script', { src: '/vendor/jsQR.js', onLoad: resolve, onError: resolve });
      document.head.append(script);
    });
    if (!window.jsQR) {
      status.textContent = 'This browser cannot decode barcodes. Type the code below instead.';
      return;
    }
    status.textContent = 'Ready. This browser can read QR codes only.';
  }

  const tick = async () => {
    if (!state.stream) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      let found = null;
      try {
        if (detector) {
          const codes = await detector.detect(canvas);
          if (codes.length) found = codes[0].rawValue;
        } else if (window.jsQR) {
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = window.jsQR(image.data, image.width, image.height);
          if (code) found = code.data;
        }
      } catch {
        // Ignore a failed frame.
      }

      // Same code re-decodes every frame while it is held in view.
      if (found && (found !== state.lastValue || Date.now() - state.lastAt > 3000)) {
        state.lastValue = found;
        state.lastAt = Date.now();
        send(found, 'camera', lastScan, counter);
      }
    }

    state.loop = requestAnimationFrame(tick);
  };

  state.loop = requestAnimationFrame(tick);
}

async function send(barcode, source, lastScan = null, counter = null) {
  const target = lastScan || document.querySelector('#scanner-root > div:nth-of-type(3)');

  try {
    const result = await api.pushScan(state.code, { barcode, source });
    state.sent += 1;

    // Vibrate as confirmation — the phone is usually not being looked at.
    if (navigator.vibrate) navigator.vibrate(result.delivered_to_station ? 60 : [40, 60, 40]);

    if (target) {
      clear(target).append(alertBox(
        result.device
          ? `${result.device.name} — ${result.message}`
          : `${barcode} — sent, but no device in this pool matches it.`,
        { type: result.delivered_to_station ? 'ok' : 'warn', title: barcode },
      ));
    }

    if (counter) {
      counter.textContent = `${state.sent} scan${state.sent === 1 ? '' : 's'} sent this session.`;
    }

    announce(
      result.device
        ? `${result.device.name}. ${result.message}`
        : `${barcode} sent. No matching device.`,
      { assertive: true },
    );
  } catch (err) {
    if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
    if (target) {
      clear(target).append(alertBox(err.message, { type: 'danger', title: 'Could not send' }));
    }
    announce(`Could not send the scan. ${err.message}`, { assertive: true });

    // An expired channel means the station closed; go back to the join screen.
    if (err instanceof ApiError && err.status === 404) {
      stopCamera();
      state.channel = null;
      renderJoin('That pairing code is no longer valid. Ask the station for a new one.');
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // No sign-in on the phone. The pairing code is the credential: it expires
  // within hours and the only thing it can do is hand a barcode to the desk,
  // where a person still confirms every action. Making someone sign in on a
  // borrowed phone would defeat the point of the feature.
  if (state.code) {
    try {
      const result = await api.joinScanChannel(state.code);
      state.channel = result.channel;
      renderScanner(result.station_connected);
      return;
    } catch {
      renderJoin('That pairing code is not valid or has expired. Enter the current one.');
      return;
    }
  }

  renderJoin();
}

window.addEventListener('pagehide', stopCamera);

boot();
