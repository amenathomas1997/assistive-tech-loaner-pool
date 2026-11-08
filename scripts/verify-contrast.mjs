/**
 * Contrast check for the colour tokens in public/css/app.css.
 *
 * This exists because contrast is the one accessibility property that decays
 * silently. Nothing breaks when somebody lightens a grey by four per cent to
 * make a heading look nicer; the page still renders, the tests still pass,
 * and the only person who notices is the one who can no longer read it.
 *
 * Every pairing below is one that actually occurs on screen — muted text on
 * each surface it is used on, each status colour on its own tint, white on
 * the primary button's gradient at both ends. Each is checked at 7:1, which
 * is WCAG 2.2 SC 1.4.6 Contrast (Enhanced), the AAA threshold, rather than
 * the 4.5:1 of SC 1.4.3 at AA.
 *
 * Run: node scripts/verify-contrast.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'public/css/app.css'), 'utf8');

const AAA_NORMAL = 7;
const AAA_LARGE = 4.5;
const NON_TEXT = 3;

// ---------------------------------------------------------------------------
// Colour maths (WCAG 2.x relative luminance)
// ---------------------------------------------------------------------------

function parseHex(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function luminance([r, g, b]) {
  const chan = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Flatten a colour with alpha over an opaque backdrop. */
function over([r, g, b], alpha, backdrop) {
  return [r, g, b].map((c, i) => Math.round(c * alpha + backdrop[i] * (1 - alpha)));
}

// ---------------------------------------------------------------------------
// Read the tokens out of the stylesheet
// ---------------------------------------------------------------------------

/**
 * The light tokens come from the :root block; the dark ones from the first
 * prefers-color-scheme block, which redefines a subset. Parsed rather than
 * duplicated here, so this file cannot drift from the stylesheet it checks.
 */
function tokens() {
  const rootStart = css.indexOf(':root {');
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark) {');

  const read = (text) => {
    const out = {};
    for (const [, name, value] of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      out[name] = value.trim();
    }
    return out;
  };

  const light = read(css.slice(rootStart, darkStart));
  // The dark block ends at the first line that closes both the :root and the
  // @media — i.e. the next "\n}\n" after the inner close.
  const darkEnd = css.indexOf('\n}\n', css.indexOf('\n  }\n', darkStart));
  const dark = { ...light, ...read(css.slice(darkStart, darkEnd)) };

  return { light, dark };
}

const { light, dark } = tokens();

const hexOf = (theme, name) => {
  const value = theme[name];
  if (!value || !value.startsWith('#')) {
    throw new Error(`Token ${name} is missing or not a plain hex colour: ${value}`);
  }
  return parseHex(value);
};

// ---------------------------------------------------------------------------
// The pairings
// ---------------------------------------------------------------------------

const WHITE = [255, 255, 255];

/** @returns {Array<{what: string, fg: number[], bg: number[], min: number}>} */
function pairings(theme, name) {
  const t = (n) => hexOf(theme, n);

  const surfaces = [
    ['surface', t('--surface')],
    ['surface-alt', t('--surface-alt')],
    ['bg', t('--bg')],
    ['surface-sunken', t('--surface-sunken')],
  ];

  const list = [];

  for (const [where, bg] of surfaces) {
    list.push({ what: `${name}: body text on ${where}`, fg: t('--text'), bg, min: AAA_NORMAL });
    list.push({ what: `${name}: muted text on ${where}`, fg: t('--text-muted'), bg, min: AAA_NORMAL });
    list.push({ what: `${name}: link on ${where}`, fg: t('--brand'), bg, min: AAA_NORMAL });
  }

  // Status colours on their own tints, which is where they are hardest.
  for (const status of ['ok', 'warn', 'danger', 'info', 'neutral']) {
    const bgToken = `--${status}-bg`;
    if (!theme[bgToken]) continue;
    list.push({
      what: `${name}: ${status} text on ${status} tint`,
      fg: t(`--${status}`), bg: t(bgToken), min: AAA_NORMAL,
    });
    list.push({
      what: `${name}: ${status} text on surface`,
      fg: t(`--${status}`), bg: t('--surface'), min: AAA_NORMAL,
    });
  }

  // The active item in the sidebar: brand text on the brand tint.
  list.push({
    what: `${name}: active nav item`,
    fg: t('--brand'), bg: t('--brand-soft'), min: AAA_NORMAL,
  });

  // Borders and the focus ring are non-text (SC 1.4.11), so 3:1.
  list.push({
    what: `${name}: focus ring against surface`,
    fg: t('--border-focus'), bg: t('--surface'), min: NON_TEXT,
  });
  list.push({
    what: `${name}: focus ring against page background`,
    fg: t('--border-focus'), bg: t('--bg'), min: NON_TEXT,
  });
  list.push({
    what: `${name}: input border against surface`,
    fg: t('--border-strong'), bg: t('--surface'), min: NON_TEXT,
  });

  return list;
}

const checks = [...pairings(light, 'light'), ...pairings(dark, 'dark')];

// The primary button and the header are gradients, so both ends are checked.
// The label is white in the light theme; the dark theme flips it.
checks.push(
  { what: 'light: white label on primary button, light end', fg: WHITE, bg: hexOf(light, '--brand'), min: AAA_NORMAL },
  { what: 'light: white label on primary button, dark end', fg: WHITE, bg: hexOf(light, '--brand-strong'), min: AAA_NORMAL },
  { what: 'light: white on header, lightest stop', fg: WHITE, bg: hexOf(light, '--brand-bright'), min: AAA_NORMAL },
  { what: 'light: white on header, darkest stop', fg: WHITE, bg: hexOf(light, '--brand-strong'), min: AAA_NORMAL },
  // The avatar chip is a black veil over the header's lightest stop.
  {
    what: 'light: initials on the avatar chip',
    fg: WHITE, bg: over([0, 0, 0], 0.25, hexOf(light, '--brand-bright')), min: AAA_NORMAL,
  },
  { what: 'dark: label on primary button', fg: hexOf(dark, '--text-inverse'), bg: hexOf(dark, '--brand'), min: AAA_NORMAL },
);

// ---------------------------------------------------------------------------

let failed = 0;
const rows = [];

for (const check of checks) {
  const ratio = contrast(check.fg, check.bg);
  const ok = ratio >= check.min - 0.005;
  if (!ok) failed++;
  rows.push(`  ${ok ? 'ok  ' : 'FAIL'} ${check.what.padEnd(46)} ${ratio.toFixed(2)}:1 (needs ${check.min})`);
}

console.log('==> Colour contrast (WCAG 2.2 SC 1.4.6 Contrast (Enhanced), 7:1)\n');
console.log(rows.join('\n'));
console.log();

if (failed > 0) {
  console.error(
    `${failed} of ${checks.length} pairings are below the AAA threshold.\n\n` +
    'This is not a style preference. Each pairing above appears on screen, and\n' +
    'a token nudged for looks is the usual cause. Adjust the token rather than\n' +
    'the threshold.',
  );
  process.exit(1);
}

console.log(`All ${checks.length} colour pairings clear their threshold.`);
