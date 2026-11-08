/**
 * Appearance: light, dark, or two colours of the user's own choosing.
 *
 * This exists for one success criterion, which is worth naming because the
 * requirement is easy to mistake for "support dark mode".
 *
 * WCAG 2.2 SC 1.4.8 Visual Presentation (Level AAA) lists five things, and
 * the first is that for blocks of text, "foreground and background colors can
 * be selected by the user". Following prefers-color-scheme is not that: it
 * offers two palettes somebody else picked. The criterion asks for the user's
 * colours.
 *
 * It is not a hypothetical need in an assistive-technology loaner pool. The
 * combinations people actually ask for — yellow on black for low vision,
 * black on cream for scotopic sensitivity, high-contrast inversions for
 * glare — are not a theme designer's choices, and no pair of defaults covers
 * them.
 *
 * Windows High Contrast is supported too (see the forced-colors block in
 * app.css), and for the people who have it configured that remains the better
 * route, because it applies everywhere at once. This is for everybody else:
 * a browser on a shared machine, a Chromebook, a locked-down desktop where
 * the platform setting is not theirs to change.
 *
 * How custom mode works, and what it gives up
 * -------------------------------------------
 * Two colours in, a whole palette out. Every surface is the chosen background
 * or a measured step from it toward the foreground; every piece of text is the
 * chosen foreground exactly, including the text that is normally muted.
 *
 * So custom mode deliberately loses two things:
 *
 *   - Typographic hierarchy from colour. Muted text is not muted. Somebody who
 *     has chosen their own two colours has said legibility matters more than
 *     shading, and a "subtle" grey derived from an arbitrary pair cannot be
 *     guaranteed to clear 7:1 — or even 4.5:1.
 *   - Hue in the status pills. Available, out, overdue and broken all end up
 *     the same two colours. This is safe only because SC 1.3.1 was already
 *     satisfied without colour: every pill carries its word, and every status
 *     dot sits beside that word. Nothing in this application has ever been
 *     distinguishable by hue alone, which is what makes a two-colour mode
 *     possible at all.
 *
 * The chosen pair is not validated away. The dialog measures the ratio, says
 * plainly what it meets, and warns below 4.5:1 — but it applies whatever is
 * asked for. Refusing somebody's colours because a formula disagrees would
 * defeat the criterion this file exists to meet; the person at the keyboard
 * can see the screen and the script cannot.
 */

import { el, modal, announce } from './ui.js';

const MODE_KEY = 'loanerpool.theme';
const FG_KEY   = 'loanerpool.theme.fg';
const BG_KEY   = 'loanerpool.theme.bg';
/** The serialised declaration list, replayed by theme-boot.js before paint. */
const CSS_KEY  = 'loanerpool.theme.css';

const DEFAULT_FG = '#000000';
const DEFAULT_BG = '#ffffff';

export const MODES = [
  {
    value: 'system',
    label: 'Follow this device',
    help: 'Light or dark, whichever this computer or phone is set to.',
  },
  { value: 'light', label: 'Light', help: 'Dark text on a light background, always.' },
  { value: 'dark',  label: 'Dark',  help: 'Light text on a dark background, always.' },
  {
    value: 'custom',
    label: 'Choose my own colours',
    help: 'Pick the text and background colours yourself.',
  },
];

/**
 * Starting points.
 *
 * Not a palette — a list of the pairings people actually ask for, so that
 * somebody who needs one of them is three clicks away rather than hunting
 * through a colour wheel with the very eyesight that brought them here.
 */
export const PRESETS = [
  { label: 'Black on white',   fg: '#000000', bg: '#ffffff' },
  { label: 'White on black',   fg: '#ffffff', bg: '#000000' },
  { label: 'Yellow on black',  fg: '#ffe600', bg: '#000000' },
  { label: 'Black on cream',   fg: '#000000', bg: '#fbf3e0' },
  { label: 'Green on black',   fg: '#4aff9f', bg: '#001208' },
  { label: 'Navy on pale blue', fg: '#001a33', bg: '#e8f1fa' },
];

// ---------------------------------------------------------------------------
// Colour arithmetic
//
// The same relative-luminance formula as scripts/verify-contrast.mjs, which
// checks the built-in palettes on every test run. It cannot check this one,
// because this palette does not exist until somebody chooses it — so the
// measurement has to happen here, in front of them.
// ---------------------------------------------------------------------------

/** @returns {{r:number,g:number,b:number}|null} */
export function parseHex(value) {
  if (typeof value !== 'string') return null;

  let hex = value.trim().replace(/^#/, '');

  // #abc is a perfectly ordinary thing to type, and rejecting it would be
  // pedantry aimed at the person least able to afford the extra keystrokes.
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }

  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;

  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }) {
  const pair = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/** WCAG relative luminance. */
function luminance({ r, g, b }) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two hex colours, or null if either will not parse. */
export function contrastRatio(a, b) {
  const first = parseHex(a);
  const second = parseHex(b);

  if (!first || !second) return null;

  const l1 = luminance(first);
  const l2 = luminance(second);

  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** What that ratio means, in words rather than a number. */
export function rateContrast(ratio) {
  if (ratio === null) return { level: 'unknown', text: 'Enter two colours to see the contrast.' };

  const shown = ratio.toFixed(1);

  if (ratio >= 7) {
    return { level: 'ok', text: `${shown} to 1. Meets the highest standard (AAA) for body text.` };
  }
  if (ratio >= 4.5) {
    return {
      level: 'warn',
      text: `${shown} to 1. Enough for body text (AA), short of the highest standard (AAA, 7 to 1).`,
    };
  }
  if (ratio >= 3) {
    return {
      level: 'warn',
      text: `${shown} to 1. Enough for large text only. Ordinary text needs 4.5 to 1.`,
    };
  }

  return {
    level: 'danger',
    text: `${shown} to 1. Below the minimum of 4.5 to 1 — text may be hard to read.`,
  };
}

/** A step from one colour toward another. `amount` is 0 to 1. */
function mix(fromHex, towardHex, amount) {
  const from = parseHex(fromHex);
  const toward = parseHex(towardHex);

  if (!from || !toward) return fromHex;

  return toHex({
    r: from.r + (toward.r - from.r) * amount,
    g: from.g + (toward.g - from.g) * amount,
    b: from.b + (toward.b - from.b) * amount,
  });
}

// ---------------------------------------------------------------------------
// The stored preference
// ---------------------------------------------------------------------------

/**
 * Per browser, not per account.
 *
 * Deliberate: the colours somebody needs are a property of the screen they
 * are sitting at and the light in the room, not of their user record. A
 * technician who signs in at the bench, at the front desk and on a tablet
 * wants three different answers, and a shared machine at the front desk
 * should not inherit whatever the last person needed.
 *
 * It also means it works on the sign-in screen, before there is an account to
 * read a preference from — which matters, because somebody who cannot read
 * white-on-blue cannot sign in to say so.
 */
export function readPreference() {
  try {
    const mode = window.localStorage.getItem(MODE_KEY);

    return {
      mode: MODES.some((m) => m.value === mode) ? mode : 'system',
      fg: window.localStorage.getItem(FG_KEY) || DEFAULT_FG,
      bg: window.localStorage.getItem(BG_KEY) || DEFAULT_BG,
    };
  } catch {
    return { mode: 'system', fg: DEFAULT_FG, bg: DEFAULT_BG };
  }
}

function savePreference({ mode, fg, bg, css }) {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
    window.localStorage.setItem(FG_KEY, fg);
    window.localStorage.setItem(BG_KEY, bg);

    if (css) window.localStorage.setItem(CSS_KEY, css);
    else window.localStorage.removeItem(CSS_KEY);
  } catch {
    // Nothing to do. The choice applies for this page load and is forgotten
    // on the next one, which is better than failing to apply it at all.
  }
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

/**
 * Derive a full token set from two colours.
 *
 * Every value is either one of the two colours or a fixed step between them,
 * so the result inherits the contrast of the pair the user chose. Nothing is
 * invented: there is no hue here that they did not ask for.
 */
function customTokens(fg, bg) {
  const step = (amount) => mix(bg, fg, amount);

  // Every colour token in :root must appear below. One left out does not fall
  // back to anything sensible — it keeps the light theme's value, which on a
  // black background is navy-on-black at 1.7:1. That is how --link was missed
  // the first time, so scripts/verify-contrast.mjs now compares the two lists
  // and fails the build on a token that is in the stylesheet but not here.

  return {
    'color-scheme': (contrastRatio(fg, '#ffffff') ?? 0) > (contrastRatio(bg, '#ffffff') ?? 0)
      // Which of the two is the darker tells the browser how to draw the
      // things this stylesheet does not reach: scrollbars, the spinner in a
      // date field, the native colour picker itself.
      ? 'light' : 'dark',

    '--bg': bg,
    '--bg-gradient': 'none',
    '--surface': bg,
    '--surface-alt': step(0.12),
    '--surface-sunken': step(0.07),

    '--border': step(0.45),
    '--border-strong': step(0.7),
    '--border-focus': fg,

    '--text': fg,
    // Not muted. See the note at the top of this file: a derived grey cannot
    // be guaranteed to clear 4.5:1 against an arbitrary background, and
    // unreadable secondary text is worse than flat secondary text.
    '--text-muted': fg,
    '--text-inverse': bg,
    '--link': fg,

    '--brand': fg,
    '--brand-strong': fg,
    '--brand-bright': fg,
    '--brand-soft': step(0.18),
    '--brand-tint': step(0.1),

    '--accent': fg,
    '--accent-soft': step(0.14),

    '--ok': fg,     '--ok-bg': step(0.14),     '--ok-border': step(0.7),
    '--warn': fg,   '--warn-bg': step(0.14),   '--warn-border': step(0.7),
    '--danger': fg, '--danger-bg': step(0.14), '--danger-border': step(0.7),
    '--info': fg,   '--info-bg': step(0.14),   '--info-border': step(0.7),
    '--neutral': fg, '--neutral-bg': step(0.12),

    // A shadow is a tint of black over a background that may itself be black.
    // Borders carry the separation in custom mode instead.
    '--shadow-xs': 'none',
    '--shadow': 'none',
    '--shadow-md': 'none',
    '--shadow-lg': 'none',
  };
}

/**
 * Put a preference into effect.
 *
 * @param {{mode: string, fg: string, bg: string}} preference
 * @param {boolean} persist  false while previewing inside the dialog
 */
export function applyTheme(preference, persist = true) {
  const { mode } = preference;
  const root = document.documentElement;

  // Always a concrete value, never "system": the stylesheet then needs one
  // selector per theme rather than a media query plus an override of it, and
  // there is no window in which both could apply.
  const resolved = mode === 'system' ? systemTheme() : mode;

  root.setAttribute('data-theme', resolved);

  let css = null;

  if (resolved === 'custom') {
    const tokens = customTokens(preference.fg, preference.bg);

    root.style.cssText = '';
    for (const [name, value] of Object.entries(tokens)) {
      root.style.setProperty(name, value);
    }

    css = root.style.cssText;
  } else {
    // Clear the custom palette so switching back really does go back. An
    // inline custom property outranks every rule in the stylesheet.
    root.style.cssText = '';
  }

  if (persist) savePreference({ ...preference, css });
}

function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Keep "follow this device" actually following it.
 *
 * Without this, somebody whose machine switches to dark at sunset keeps the
 * light palette until they reload — and because theme-boot.js resolves the
 * preference to a concrete attribute, nothing else would ever notice.
 */
export function watchSystemTheme() {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!query?.addEventListener) return;

  query.addEventListener('change', () => {
    const preference = readPreference();
    if (preference.mode === 'system') applyTheme(preference);
  });
}

/**
 * Apply whatever is stored. Called once at start-up.
 *
 * Persists deliberately, although nothing has changed. theme-boot.js replays
 * a declaration list that this module computed at some point in the past, so
 * after an update that adds a token or changes a step, that cached string is
 * out of date — and the stale version is what gets painted first on every
 * load until somebody happens to open the dialog and save again.
 *
 * Rewriting it here costs one localStorage write per page load and keeps the
 * cache honest. It is how a palette missing a token that was added in a later
 * release repairs itself.
 */
export function initTheme() {
  applyTheme(readPreference(), true);
  watchSystemTheme();
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

/**
 * Change the appearance.
 *
 * Previews as you go. A colour scheme is the one setting nobody can judge
 * from a description, and asking somebody to save, look, reopen and adjust is
 * a loop they may not be able to see their way through.
 */
export function openAppearanceDialog() {
  const starting = readPreference();
  const working = { ...starting };

  const customBlock = el('div', { class: 'stack', hidden: starting.mode !== 'custom' });
  const readout = el('p', { class: 'contrast-readout', role: 'status' });

  const fgSwatch = el('input', { type: 'color', id: 'theme-fg', value: normalise(working.fg) });
  const bgSwatch = el('input', { type: 'color', id: 'theme-bg', value: normalise(working.bg) });
  const fgText = el('input', { type: 'text', class: 'hex-input', id: 'theme-fg-hex', value: working.fg, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'hex-help' });
  const bgText = el('input', { type: 'text', class: 'hex-input', id: 'theme-bg-hex', value: working.bg, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'hex-help' });

  const preview = () => applyTheme(working, false);

  const refresh = ({ announceRatio = false } = {}) => {
    const rating = rateContrast(contrastRatio(working.fg, working.bg));

    readout.className = `contrast-readout contrast-${rating.level}`;
    readout.textContent = rating.text;

    if (announceRatio) announce(rating.text);
  };

  /**
   * One colour, two ways.
   *
   * The swatch opens the platform picker, which is the easy path and the one
   * most people will take. The text box is not a convenience for developers:
   * the native picker is a small, mouse-shaped target that some people cannot
   * operate at all, and an optician's note or a support article gives a hex
   * value. Either control drives the other.
   */
  const bindPair = (swatch, text, key) => {
    swatch.addEventListener('input', () => {
      working[key] = swatch.value;
      text.value = swatch.value;
      preview();
      refresh();
    });

    text.addEventListener('input', () => {
      const parsed = parseHex(text.value);
      // Typing is incremental — "#ff" is on the way to "#ff0000", not an
      // error. Nothing is said until it is a colour.
      if (!parsed) return;

      working[key] = toHex(parsed);
      swatch.value = working[key];
      preview();
      refresh();
    });

    text.addEventListener('blur', () => {
      if (!parseHex(text.value)) text.value = working[key];
    });
  };

  bindPair(fgSwatch, fgText, 'fg');
  bindPair(bgSwatch, bgText, 'bg');

  const modeRadios = MODES.map((mode) => {
    const input = el('input', {
      type: 'radio', name: 'theme-mode', id: `theme-${mode.value}`,
      value: mode.value, checked: starting.mode === mode.value,
    });

    input.addEventListener('change', () => {
      if (!input.checked) return;

      working.mode = mode.value;
      customBlock.hidden = mode.value !== 'custom';
      preview();
      refresh();

      if (mode.value === 'custom') {
        announce('Choose your own colours. Text colour, background colour, and the contrast between them.');
        // Focus follows the disclosure: the controls that just appeared are
        // below the radio, and a screen reader would not know they arrived.
        fgSwatch.focus();
      } else {
        announce(`${mode.label}.`);
      }
    });

    return el('label', { class: 'radio', for: `theme-${mode.value}` }, [
      input,
      el('span', {}, [mode.label, el('span', { class: 'option-help', text: mode.help })]),
    ]);
  });

  customBlock.append(
    el('div', { class: 'preset-row' }, [
      el('span', { class: 'preset-label', id: 'preset-label', text: 'Start from:' }),
      el('div', { class: 'btn-group', role: 'group', 'aria-labelledby': 'preset-label' },
        PRESETS.map((set) => el('button', {
          type: 'button', class: 'btn btn-sm',
          onClick: () => {
            working.fg = set.fg;
            working.bg = set.bg;
            fgSwatch.value = set.fg;
            bgSwatch.value = set.bg;
            fgText.value = set.fg;
            bgText.value = set.bg;
            preview();
            refresh();
            announce(`${set.label}. ${rateContrast(contrastRatio(set.fg, set.bg)).text}`);
          },
        }, set.label))),
    ]),

    el('div', { class: 'colour-fields' }, [
      el('div', { class: 'colour-field' }, [
        el('label', { class: 'field-label', for: 'theme-fg', text: 'Text colour' }),
        el('div', { class: 'colour-inputs' }, [fgSwatch, fgText]),
      ]),
      el('div', { class: 'colour-field' }, [
        el('label', { class: 'field-label', for: 'theme-bg', text: 'Background colour' }),
        el('div', { class: 'colour-inputs' }, [bgSwatch, bgText]),
      ]),
    ]),

    el('p', {
      class: 'field-help', id: 'hex-help',
      text: 'Use the swatch to pick a colour, or type a code such as #ffe600 if you have one.',
    }),

    readout,

    el('p', {
      class: 'field-help',
      text: 'Your two colours are used for everything: every surface is the background colour or '
          + 'a step toward the text colour. Status labels keep their words — Available, Overdue, '
          + 'In repair — but lose their separate colours, because the colours would no longer be '
          + 'yours.',
    }),
  );

  refresh();

  return modal({
    title: 'Appearance',
    startAtTop: true,
    body: el('div', { class: 'stack' }, [
      el('p', {
        text: 'This is remembered on this browser only, so a shared machine keeps whatever the '
            + 'next person needs.',
      }),

      el('fieldset', { class: 'fieldset' }, [
        el('legend', { text: 'Colour scheme' }),
        ...modeRadios,
      ]),

      customBlock,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: false },
      { label: 'Save', class: 'btn-primary', value: true },
    ],
  }).then((saved) => {
    if (saved === true) {
      applyTheme(working, true);
      announce('Appearance saved.');
      return true;
    }

    // Anything else — Cancel, the close button, or Escape — has to undo the
    // live preview, or "cancel" would be a lie and Escape would be a trap.
    applyTheme(starting, false);
    return false;
  });
}

/** <input type="color"> will only accept #rrggbb, and silently resets otherwise. */
function normalise(value) {
  const parsed = parseHex(value);
  return parsed ? toHex(parsed) : DEFAULT_FG;
}
