/**
 * Barcode value allocation and label rendering.
 *
 * Every device gets a `barcode` string at creation or import. That string is
 * what a scanner reads, regardless of symbology — so an org can switch from QR
 * to Code 128 and reprint labels without any device's identity changing.
 *
 * Symbologies:
 *   qr       — 2D. Scannable by phone cameras and 2D imagers. NOT readable by
 *              1D laser scanners, which is why the choice is per-org.
 *   code128  — 1D, dense, alphanumeric. Readable by essentially every scanner.
 *   code39   — 1D, less dense, but readable by very old hardware.
 *
 * The Code 128 and Code 39 encoders are implemented here rather than pulled in
 * as a dependency; both are small, fully specified, and verified by
 * scripts/verify-barcode.js (every pattern must be exactly 11 modules wide,
 * and the check digit must match known-good vectors).
 */

import QRCode from 'qrcode';
import { randomCode, badRequest } from './util.js';

export const SYMBOLOGIES = ['qr', 'code128', 'code39'];

// ---------------------------------------------------------------------------
// Barcode value allocation
// ---------------------------------------------------------------------------

/**
 * Barcode values look like "LP-7K3F9Q2M".
 *
 * Deliberately not sequential: sequential asset codes leak inventory size, and
 * a mis-keyed digit in a sequential scheme silently resolves to a real, wrong
 * device. With a random alphabet drawn from an unambiguous character set, a
 * typo almost always resolves to nothing at all.
 *
 * 8 characters from a 32-character alphabet is ~40 bits. Collisions are
 * handled by the UNIQUE index plus retry in allocateBarcode(), not by hoping.
 */
export function generateBarcodeValue(prefix = 'LP', length = 8) {
  const cleanPrefix = String(prefix || 'LP')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'LP';
  return `${cleanPrefix}-${randomCode(length)}`;
}

/**
 * Allocate a barcode value that is not already taken.
 *
 * `exists` is an async predicate so this works both inside a transaction
 * (checking against the connection) and outside it.
 */
export async function allocateBarcode(exists, prefix = 'LP', maxAttempts = 12) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateBarcodeValue(prefix);
    if (!(await exists(candidate))) return candidate;
  }
  // Reaching here means either a catastrophically bad RNG or a barcode table
  // so full that random allocation no longer terminates. Both need a human.
  throw new Error(
    `Could not allocate a unique barcode after ${maxAttempts} attempts. ` +
    'Check the devices table for duplicate or corrupted barcode values.',
  );
}

/**
 * Scanners and humans introduce predictable noise: keyboard-wedge scanners
 * append Enter/Tab, some prepend a symbology identifier, and people type
 * lowercase. Normalise before lookup so a good scan is never a miss.
 */
export function normaliseScan(raw) {
  if (raw === null || raw === undefined) return null;
  let value = String(raw);

  value = value.replace(/[\r\n\t]+$/g, '');          // wedge terminators
  value = value.replace(/^\]([A-Za-z])\d/, '');      // AIM symbology identifier
  value = value.trim();
  if (value === '') return null;

  // Code 39 transmits its own start/stop asterisks on some readers.
  if (value.length > 2 && value.startsWith('*') && value.endsWith('*')) {
    value = value.slice(1, -1);
  }

  return value.toUpperCase();
}

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------

/**
 * QR at error-correction level M (~15% recoverable). Level M rather than L
 * because these labels live on equipment that gets handled, scuffed and
 * stickered over; rather than H because H inflates module count and a denser
 * code on a 1-inch label is harder for a phone camera to resolve.
 */
export async function qrSvg(value, { size = 120, margin = 1 } = {}) {
  return QRCode.toString(String(value), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin,
    width: size,
  });
}

export async function qrDataUrl(value, { size = 240, margin = 1 } = {}) {
  return QRCode.toDataURL(String(value), {
    errorCorrectionLevel: 'M',
    margin,
    width: size,
  });
}

// ---------------------------------------------------------------------------
// Code 128 (subset B)
// ---------------------------------------------------------------------------

/**
 * Element widths for Code 128 values 0-106. Each string is bar,space,bar,
 * space,bar,space in modules. Values 0-105 are 11 modules wide; 106 (stop) is
 * 13 and has a trailing bar.
 */
const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131',
  '211412', // 103 Start A
  '211214', // 104 Start B
  '211232', // 105 Start C
  '2331112', // 106 Stop
];

const CODE128_START_B = 104;
const CODE128_STOP = 106;

/** Exported so the verification script can assert the table's integrity. */
export function code128Patterns() {
  return CODE128_PATTERNS;
}

/**
 * Encode text as Code 128 subset B and return the module widths plus the
 * check character. Subset B covers ASCII 32-126, which is everything a
 * generated barcode value can contain.
 */
export function code128Encode(text) {
  const value = String(text);

  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) {
      throw badRequest(
        `Code 128 subset B cannot encode the character "${ch}". ` +
        'Barcode values must use printable ASCII only.',
      );
    }
  }

  const codes = [CODE128_START_B];
  for (const ch of value) codes.push(ch.charCodeAt(0) - 32);

  // Checksum: start value + sum(position * value), modulo 103.
  let checksum = CODE128_START_B;
  for (let i = 1; i < codes.length; i += 1) {
    checksum += codes[i] * i;
  }
  const checkDigit = checksum % 103;

  codes.push(checkDigit);
  codes.push(CODE128_STOP);

  const widths = [];
  for (const code of codes) {
    for (const digit of CODE128_PATTERNS[code]) widths.push(Number(digit));
  }

  return { codes, checkDigit, widths };
}

// ---------------------------------------------------------------------------
// Code 39
// ---------------------------------------------------------------------------

/**
 * Code 39: each character is 9 elements (5 bars, 4 spaces), 3 of which are
 * wide. "n" = narrow, "w" = wide, alternating bar/space starting with a bar.
 */
const CODE39_ALPHABET = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
  '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
  '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', 'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw',
  'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn', 'F': 'nnwnwwnnn',
  'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
  'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww',
  'O': 'wnnnwnnwn', 'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn',
  'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn', 'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw',
  'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn', 'Z': 'nwwnwnnnn',
  '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
  '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
};

export function code39Encode(text, { wideRatio = 2.5 } = {}) {
  const value = String(text).toUpperCase();

  for (const ch of value) {
    if (!(ch in CODE39_ALPHABET) || ch === '*') {
      throw badRequest(
        `Code 39 cannot encode the character "${ch}". ` +
        'Use A-Z, 0-9, space, or - . $ / + % only.',
      );
    }
  }

  const widths = [];
  const framed = `*${value}*`;

  framed.split('').forEach((ch, index) => {
    for (const element of CODE39_ALPHABET[ch]) {
      widths.push(element === 'w' ? wideRatio : 1);
    }
    // Inter-character gap: one narrow space.
    if (index < framed.length - 1) widths.push(1);
  });

  return { widths };
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

/**
 * Render alternating bar/space widths as an SVG. The first element is always a
 * bar, and elements alternate from there.
 */
function widthsToSvg(widths, { height = 60, moduleWidth = 2, quietZone = 10, text = null, fontSize = 10 }) {
  const totalModules = widths.reduce((sum, w) => sum + w, 0);
  const barsWidth = totalModules * moduleWidth;
  const width = barsWidth + quietZone * 2;
  const textHeight = text ? fontSize + 4 : 0;
  const totalHeight = height + textHeight;

  let x = quietZone;
  const rects = [];

  widths.forEach((moduleCount, index) => {
    const elementWidth = moduleCount * moduleWidth;
    // Even indices are bars, odd are spaces.
    if (index % 2 === 0) {
      rects.push(
        `<rect x="${round(x)}" y="0" width="${round(elementWidth)}" height="${height}" fill="#000"/>`,
      );
    }
    x += elementWidth;
  });

  const label = text
    ? `<text x="${round(width / 2)}" y="${height + fontSize}" text-anchor="middle" ` +
      `font-family="monospace" font-size="${fontSize}" fill="#000">${escapeXml(text)}</text>`
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(totalHeight)}" ` +
    `viewBox="0 0 ${round(width)} ${round(totalHeight)}" role="img" ` +
    `aria-label="Barcode ${escapeXml(String(text ?? ''))}">` +
    `<rect width="100%" height="100%" fill="#fff"/>${rects.join('')}${label}</svg>`
  );
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function code128Svg(value, options = {}) {
  const { widths } = code128Encode(value);
  return widthsToSvg(widths, { text: value, ...options });
}

export function code39Svg(value, options = {}) {
  const { widths } = code39Encode(value);
  return widthsToSvg(widths, { text: value, ...options });
}

/** Render `value` in whichever symbology the organisation has configured. */
export async function renderBarcodeSvg(value, symbology = 'qr', options = {}) {
  switch (symbology) {
    case 'code128':
      return code128Svg(value, options);
    case 'code39':
      return code39Svg(value, options);
    case 'qr':
    default:
      return qrSvg(value, options);
  }
}

// ---------------------------------------------------------------------------
// Printable label sheets
// ---------------------------------------------------------------------------

/**
 * A print-ready HTML page of device labels.
 *
 * Sizing is in millimetres with an explicit @page rule, because label stock is
 * sold by physical size and "looks right on screen" is not a useful guarantee
 * when the output is going onto a sheet of Avery labels.
 */
export async function renderLabelSheet(devices, { symbology = 'qr', orgName = '', columns = 3, labelWidthMm = 63.5, labelHeightMm = 38.1 } = {}) {
  const labels = [];

  for (const device of devices) {
    const svg = await renderBarcodeSvg(device.barcode, symbology, {
      size: 90,
      height: 44,
      moduleWidth: 1.4,
      fontSize: 8,
    });

    labels.push(`
      <div class="label">
        <div class="code">${svg}</div>
        <div class="meta">
          <div class="value">${escapeXml(device.barcode)}</div>
          <div class="name">${escapeXml(truncate(device.name, 34))}</div>
          ${device.asset_tag ? `<div class="asset">Asset ${escapeXml(device.asset_tag)}</div>` : ''}
          ${orgName ? `<div class="org">${escapeXml(truncate(orgName, 30))}</div>` : ''}
        </div>
      </div>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Device labels (${devices.length})</title>
<style>
  @page { size: A4; margin: 8mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #000; background: #fff; }
  .toolbar { padding: 12px; background: #f2f2f2; border-bottom: 1px solid #ccc; }
  .toolbar button { font: inherit; padding: 8px 16px; cursor: pointer; }
  .sheet { display: grid; grid-template-columns: repeat(${Number(columns)}, ${labelWidthMm}mm); gap: 0; }
  .label {
    width: ${labelWidthMm}mm; height: ${labelHeightMm}mm;
    display: flex; align-items: center; gap: 2mm;
    padding: 2mm; overflow: hidden;
    page-break-inside: avoid; break-inside: avoid;
  }
  .code { flex: 0 0 auto; display: flex; align-items: center; }
  .code svg { display: block; max-width: 24mm; max-height: 24mm; }
  .meta { flex: 1 1 auto; min-width: 0; line-height: 1.25; }
  .value { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 8pt; font-weight: 700; }
  .name { font-size: 7pt; overflow: hidden; }
  .asset, .org { font-size: 6pt; color: #333; }
  @media print { .toolbar { display: none; } }
</style>
</head>
<body>
  <div class="toolbar">
    <button type="button" onclick="window.print()">Print ${devices.length} label${devices.length === 1 ? '' : 's'}</button>
    <span> &nbsp; Symbology: ${escapeXml(symbology)} &nbsp;|&nbsp; Label size: ${labelWidthMm} &times; ${labelHeightMm} mm</span>
  </div>
  <div class="sheet">${labels.join('')}</div>
</body>
</html>`;
}

function truncate(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
