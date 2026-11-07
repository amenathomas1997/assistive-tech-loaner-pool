/**
 * Scan station.
 *
 * Four ways to get a barcode into the system, all converging on one handler:
 *
 *   1. HID keyboard-wedge scanner — the default. The scanner types the code
 *      and presses Enter; a permanently-focused input catches it.
 *   2. This device's camera — BarcodeDetector where available, jsQR otherwise.
 *   3. A paired phone — pushes scans over an SSE channel.
 *   4. Typing the code by hand.
 *
 * Everything is announced through a live region, because the person scanning
 * is usually looking at the device in their hands rather than at the screen.
 */

import { api } from '../api.js';
import {
  el, clear, mount, field, toastOk, toastError, toastWarn, announce, pill,
  alert as alertBox, formatDate, modal, loadingBlock,
} from '../ui.js';
import { can } from '../app.js';
import { openCheckoutDialog, openCheckinDialog } from './loans.js';
import {
  enqueueCheckin, countPending, flushQueue, registerServiceWorker, watchConnectivity,
} from '../offline.js';

export async function renderScanStation() {
  const container = el('div');

  // --- Offline support -----------------------------------------------------
  const settings = await api.settings().catch(() => ({ settings: {} }));
  const offlineEnabled = settings.settings?.['scan.offline_enabled'] !== false;

  if (offlineEnabled) registerServiceWorker();

  const offlineBanner = el('div', { class: 'offline-banner', hidden: true, role: 'status' });

  const refreshBanner = async () => {
    const pending = await countPending().catch(() => 0);
    const online = navigator.onLine;

    if (online && pending === 0) {
      offlineBanner.hidden = true;
      return;
    }

    offlineBanner.hidden = false;
    mount(clear(offlineBanner),
      el('span', { 'aria-hidden': 'true' }, online ? '↻' : '⚠'),
      el('span', {}, online
        ? 'Back online — sending queued returns.'
        : 'No connection. Returns you scan now are queued and sent when the network comes back. ' +
          'Check-outs need a connection and are not queued.'),
      pending > 0
        ? el('span', { class: 'queue-count' }, [
            String(pending),
            el('span', { class: 'visually-hidden' }, ' queued'),
          ])
        : null,
      pending > 0 && online
        ? el('button', {
            type: 'button', class: 'btn btn-sm',
            onClick: () => flushNow(),
          }, 'Send now')
        : null,
    );
  };

  async function flushNow() {
    if (!navigator.onLine) return;

    const result = await flushQueue(
      (payload) => api.checkIn(payload),
      { onProgress: () => refreshBanner() },
    );

    if (result.sent) {
      toastOk(`${result.sent} queued return(s) sent.`);
      announce(`${result.sent} queued returns have been sent.`);
    }
    if (result.failed) {
      toastError(
        `${result.failed} queued return(s) could not be sent: ` +
        result.failures.map((f) => `${f.barcode} (${f.reason})`).join('; '),
        'Some returns need attention',
      );
    }

    await refreshBanner();
  }

  if (offlineEnabled) {
    watchConnectivity((online) => {
      refreshBanner();
      if (online) flushNow();
    });
  }

  // --- The always-focused capture input ------------------------------------
  const captureInput = el('input', {
    type: 'text',
    id: 'scan-capture',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: false,
    'aria-label': 'Barcode. Scan a label or type a code and press Enter.',
    placeholder: 'Waiting for a scan…',
  });

  const scanTarget = el('div', { class: 'scan-target is-listening' }, [
    el('p', { class: 'scan-headline', id: 'scan-headline' }, 'Ready to scan'),
    el('p', { class: 'muted', id: 'scan-subline' },
      'Point your scanner at a label, or type a barcode and press Enter.'),
    captureInput,
  ]);

  const resultArea = el('div', { id: 'scan-result', style: { marginTop: '16px' } });
  const logList = el('ul', { class: 'scan-log' });
  let logCount = 0;

  // --- Core handler --------------------------------------------------------

  let busy = false;

  async function handleScan(rawCode, source = 'wedge') {
    const code = String(rawCode || '').trim();
    if (!code || busy) return;

    busy = true;
    captureInput.value = '';

    // Offline: queue the return rather than pretending the lookup worked.
    if (offlineEnabled && !navigator.onLine) {
      await enqueueCheckin({ device: code, scanned: true });
      setTargetState('ok', code, 'Queued. It will be sent when the connection returns.');
      addLog(code, 'Queued', source, 'ok');
      announce(`${code} queued for return. It will be sent when the connection comes back.`, { assertive: true });
      clear(resultArea).append(alertBox(
        'You are offline, so this was recorded as a return and queued. Check-outs are not possible ' +
        'until the connection comes back, because the system cannot confirm the device is free.',
        { type: 'warn', title: `${code} queued` },
      ));
      await refreshBanner();
      busy = false;
      captureInput.focus();
      return;
    }

    setTargetState('listening', 'Looking up…', code);
    clear(resultArea).append(loadingBlock(`Looking up ${code}…`));

    try {
      const result = await api.scanLookup(code);
      showResult(result, source);
    } catch (err) {
      setTargetState('danger', 'Not recognised', err.message);
      clear(resultArea).append(
        alertBox(err.message, { type: 'danger', title: `No match for "${code}"` }),
      );
      addLog(code, 'Not found', source, 'danger');
      announce(`Barcode ${code} was not recognised. ${err.message}`, { assertive: true });
    } finally {
      busy = false;
      captureInput.focus();
    }
  }

  function setTargetState(state, headline, subline) {
    scanTarget.className = `scan-target is-${state}`;
    scanTarget.querySelector('#scan-headline').textContent = headline;
    scanTarget.querySelector('#scan-subline').textContent = subline;
  }

  function addLog(code, outcome, source, tone = 'ok') {
    logCount += 1;
    const time = new Date().toLocaleTimeString();
    logList.prepend(el('li', {}, [
      el('span', { class: 'scan-time', text: time }),
      el('span', { class: 'mono', text: code }),
      el('span', { class: `pill pill-${tone === 'ok' ? 'ok' : 'danger'}` }, outcome),
      el('span', { class: 'muted', text: source }),
    ]));
    while (logList.children.length > 40) logList.lastChild.remove();
  }

  function showResult(result, source) {
    const { device, active_loan: activeLoan, suggested_action: action, blocked_reason: blocked } = result;

    const refresh = () => handleScan(device.barcode, source);

    if (action === 'check_in') {
      setTargetState('ok', device.name, `On loan to ${activeLoan.holder_summary}. Ready to check in.`);
      announce(
        `${device.name} is on loan to ${activeLoan.holder_summary}. Press check in to return it.`,
        { assertive: true },
      );
      addLog(device.barcode, 'On loan', source, 'ok');
    } else if (action === 'check_out') {
      setTargetState('ok', device.name, 'Available. Ready to check out.');
      announce(`${device.name} is available and ready to check out.`, { assertive: true });
      addLog(device.barcode, 'Available', source, 'ok');
    } else {
      setTargetState('danger', device.name, blocked || 'This device cannot be lent out.');
      announce(`${device.name}. ${blocked}`, { assertive: true });
      addLog(device.barcode, 'Blocked', source, 'danger');
    }

    clear(resultArea).append(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('h2', { style: { margin: 0 } }, el('a', { href: `#/devices/${device.id}` }, device.name)),
          el('p', { class: 'mono muted', style: { margin: '2px 0 0' }, text: device.barcode }),
        ]),
        pill(device.is_overdue ? 'lost' : device.status),
      ]),

      el('dl', { class: 'detail-list' }, [
        el('dt', { text: 'Asset tag' }), el('dd', { text: device.asset_tag || '—' }),
        el('dt', { text: 'Serial' }), el('dd', { text: device.serial_number || '—' }),
        el('dt', { text: 'Category' }), el('dd', { text: device.category || '—' }),
        el('dt', { text: 'Location' }), el('dd', { text: device.location || '—' }),
        ...(activeLoan ? [
          el('dt', { text: 'On loan to' }), el('dd', { text: activeLoan.holder_summary }),
          el('dt', { text: 'Since' }), el('dd', { text: formatDate(activeLoan.checked_out_at) }),
          el('dt', { text: 'Due back' }),
          el('dd', {
            class: activeLoan.is_overdue ? 'pill pill-danger' : null,
            text: activeLoan.due_at
              ? `${formatDate(activeLoan.due_at)}${activeLoan.is_overdue ? ` — ${activeLoan.days_overdue} days late` : ''}`
              : 'Open ended',
          }),
        ] : []),
      ]),

      el('div', { class: 'btn-group', style: { marginTop: '14px' } }, [
        action === 'check_in' && can('loans.write')
          ? el('button', {
              type: 'button', class: 'btn btn-primary btn-lg',
              onClick: () => openCheckinDialog({ device, loan: activeLoan, onDone: refresh }),
            }, 'Check in')
          : null,
        action === 'check_out' && can('loans.write')
          ? el('button', {
              type: 'button', class: 'btn btn-primary btn-lg',
              onClick: () => openCheckoutDialog({ device, onDone: refresh }),
            }, 'Check out')
          : null,
        el('a', { class: 'btn', href: `#/devices/${device.id}` }, 'Open device record'),
      ]),

      blocked ? alertBox(blocked, { type: 'warn' }) : null,
    ]));
  }

  // --- HID keyboard-wedge capture ------------------------------------------

  captureInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    handleScan(captureInput.value, 'wedge');
  });

  /**
   * Keep focus in the capture input so a wedge scanner's keystrokes always
   * land somewhere useful. Skipped whenever the user is deliberately in
   * another control, or a dialog is open — stealing focus from a form field
   * mid-typing would be far worse than missing a scan.
   */
  const refocus = () => {
    if (document.querySelector('dialog[open]')) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== captureInput) {
      const isFormControl = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(active.tagName);
      if (isFormControl) return;
    }
    captureInput.focus();
  };

  const refocusTimer = setInterval(refocus, 1200);

  // Stop the timer when this view is torn down, or it leaks across navigation.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(container)) {
      clearInterval(refocusTimer);
      stopCamera();
      closeChannelStream();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // --- Camera scanning -----------------------------------------------------

  let cameraStream = null;
  let cameraLoop = null;
  const video = el('video', { id: 'camera-preview', playsinline: true, muted: true, hidden: true });
  const cameraStatus = el('p', { class: 'muted', role: 'status' });
  const cameraButton = el('button', { type: 'button', class: 'btn' }, 'Use this device’s camera');

  function stopCamera() {
    if (cameraLoop) { cancelAnimationFrame(cameraLoop); cameraLoop = null; }
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    video.hidden = true;
    cameraButton.textContent = 'Use this device’s camera';
  }

  cameraButton.addEventListener('click', async () => {
    if (cameraStream) {
      stopCamera();
      cameraStatus.textContent = 'Camera stopped.';
      announce('Camera stopped.');
      return;
    }

    if (!window.isSecureContext) {
      cameraStatus.textContent =
        'Camera scanning needs a secure (HTTPS) connection. This page is served over plain HTTP.';
      announce(cameraStatus.textContent, { assertive: true });
      return;
    }

    try {
      cameraStatus.textContent = 'Starting the camera…';
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      video.srcObject = cameraStream;
      video.hidden = false;
      await video.play();

      cameraButton.textContent = 'Stop the camera';
      cameraStatus.textContent = 'Camera running. Hold a barcode in view.';
      announce('Camera running. Hold a barcode in view.');

      startDecoding();
    } catch (err) {
      stopCamera();
      cameraStatus.textContent =
        err.name === 'NotAllowedError'
          ? 'Camera permission was declined. Allow camera access in your browser, or use a scanner instead.'
          : `Could not start the camera: ${err.message}`;
      announce(cameraStatus.textContent, { assertive: true });
    }
  });

  /**
   * Prefer the platform BarcodeDetector — it is faster, uses less battery and
   * reads 1D symbologies as well as QR. jsQR is bundled as a fallback for
   * browsers without it (notably Safari), but only reads QR codes.
   */
  async function startDecoding() {
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
      } catch {
        detector = null;
      }
    }

    if (!detector) {
      cameraStatus.textContent =
        'Camera running using the built-in QR reader. This browser cannot read 1D barcodes from the camera — ' +
        'use a hardware scanner for those.';
      // jsQR is loaded lazily so browsers with BarcodeDetector never pay for it.
      if (!window.jsQR) {
        await new Promise((resolve, reject) => {
          const script = el('script', { src: '/vendor/jsQR.js', onLoad: resolve, onError: reject });
          document.head.append(script);
        }).catch(() => {
          cameraStatus.textContent = 'Could not load the QR reader. Use a hardware scanner instead.';
        });
      }
    }

    let lastCode = null;
    let lastAt = 0;

    const tick = async () => {
      if (!cameraStream) return;

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
          // A single failed frame is not worth reporting; the next one will do.
        }

        // Debounce: a barcode held in view decodes on every frame.
        if (found && (found !== lastCode || Date.now() - lastAt > 3000)) {
          lastCode = found;
          lastAt = Date.now();
          handleScan(found, 'camera');
        }
      }

      cameraLoop = requestAnimationFrame(tick);
    };

    cameraLoop = requestAnimationFrame(tick);
  }

  // --- Remote phone pairing ------------------------------------------------

  // Scans from the paired phone are short-polled rather than streamed. PHP
  // occupies a server worker for the whole life of a request, so one long-lived
  // connection per scan station would exhaust the worker pool on exactly the
  // kind of shared hosting this runs on. The server tells us how long to wait
  // before asking again, so the rate can be eased without changing this file.
  let pollTimer = null;
  let pollAbort = null;
  let lastEventId = 0;
  let channel = null;
  const pairingArea = el('div');

  function setPairStatus(text) {
    const status = document.getElementById('pair-status');
    if (status) status.textContent = text;
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (pollAbort) { pollAbort.abort(); pollAbort = null; }
  }

  function closeChannelStream() {
    stopPolling();
    lastEventId = 0;
    if (channel) {
      api.closeScanChannel(channel.id).catch(() => {});
      channel = null;
    }
  }

  function channelClosed(reason) {
    toastWarn(reason || 'The pairing channel closed.');
    stopPolling();
    channel = null;
    lastEventId = 0;
    clear(pairingArea);
    pairButton.textContent = 'Pair a phone as a scanner';
  }

  async function pollOnce() {
    if (!channel) return;

    pollAbort = new AbortController();

    let result;
    try {
      result = await api.get(`/scan/channels/${channel.id}/events`, {
        query: { after: lastEventId },
        signal: pollAbort.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') return;

      // A dropped connection is not a closed channel — the phone may still be
      // scanning. Keep trying, but back off so a server that is down is not
      // hammered, and say so rather than looking idle.
      setPairStatus('Connection interrupted — retrying…');
      pollTimer = setTimeout(pollOnce, 5000);
      return;
    } finally {
      pollAbort = null;
    }

    if (!channel) return;

    if (result.closed) {
      channelClosed(result.reason);
      return;
    }

    for (const event of result.events || []) {
      lastEventId = Math.max(lastEventId, event.id);
      setPairStatus(`Last scan from the phone: ${event.barcode}`);
      handleScan(event.barcode, 'phone');
    }

    if ((result.events || []).length === 0 && lastEventId === 0) {
      setPairStatus('Waiting for a phone to connect…');
    }

    pollTimer = setTimeout(pollOnce, result.poll_after_ms || 1500);
  }

  const pairButton = el('button', { type: 'button', class: 'btn' }, 'Pair a phone as a scanner');

  pairButton.addEventListener('click', async () => {
    if (channel) {
      closeChannelStream();
      clear(pairingArea);
      pairButton.textContent = 'Pair a phone as a scanner';
      announce('Phone pairing closed.');
      return;
    }

    try {
      const result = await api.createScanChannel({ label: 'Scan station' });
      channel = result.channel;
      pairButton.textContent = 'Stop phone pairing';

      clear(pairingArea).append(
        el('div', { class: 'card', style: { marginTop: '12px' } }, [
          el('h3', { text: 'Pair a phone' }),
          el('p', {
            text:
              'On the phone, open the address below and enter this code. Every barcode the phone ' +
              'scans will appear here.',
          }),
          el('div', { class: 'grid grid-2' }, [
            el('div', {}, [
              el('p', { class: 'label' }, 'Pairing code'),
              el('p', { class: 'pair-code' }, result.channel.pair_code),
              el('p', { class: 'label', style: { marginTop: '12px' } }, 'Address'),
              el('p', { class: 'mono', text: result.join_url }),
            ]),
            // The QR is generated by the server so no client library is needed.
            el('div', { class: 'qr-holder', html: result.join_qr_svg }),
          ]),
          result.https_warning ? alertBox(result.https_warning, { type: 'warn' }) : null,
          el('p', { id: 'pair-status', class: 'muted', role: 'status' }, 'Waiting for a phone to connect…'),
        ]),
      );

      lastEventId = 0;
      pollOnce();

      announce(`Pairing code ${result.channel.pair_code.split('').join(' ')}. Enter it on the phone.`);
    } catch (err) {
      toastError(err.message);
    }
  });

  // --- Assemble ------------------------------------------------------------

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Scan station' }),
        el('p', {
          text:
            'Scan a device to check it out or back in. A USB or Bluetooth scanner works with no setup — ' +
            'it simply types the code.',
        }),
      ]),
      el('div', { class: 'btn-group' }, [
        el('a', { class: 'btn', href: '#/devices' }, 'Find a device by name'),
      ]),
    ]),

    offlineBanner,
    scanTarget,

    el('div', { class: 'grid grid-2', style: { marginTop: '16px' } }, [
      el('section', { class: 'card', 'aria-labelledby': 'other-ways' }, [
        el('h2', { id: 'other-ways', text: 'No scanner to hand?' }),
        el('p', {
          class: 'muted',
          text: 'Any of these work just as well as a hardware scanner.',
        }),
        el('div', { class: 'btn-group' }, [cameraButton, pairButton]),
        cameraStatus,
        video,
        pairingArea,
        el('p', { class: 'field-help', style: { marginTop: '12px' } },
          'You can also type a barcode into the box above and press Enter, or search for the device ' +
          'by name on the Devices screen and use the buttons there.'),
      ]),

      el('section', { class: 'card', 'aria-labelledby': 'scan-history' }, [
        el('h2', { id: 'scan-history', text: 'This session' }),
        el('p', { class: 'muted' }, 'The most recent scans, newest first.'),
        logList,
      ]),
    ]),

    resultArea,
  );

  // Focus the capture input once the view is on screen.
  setTimeout(() => captureInput.focus(), 60);

  return container;
}
