/**
 * Keyboard navigation.
 *
 * Two things, for two different people.
 *
 * Skip links and named landmarks are for somebody using a screen reader, who
 * navigates by region and heading rather than by tabbing through everything.
 * Those live in app.js, where the shell is built.
 *
 * This file is the other half: shortcuts for somebody who works here all day
 * and does not want to tab across a sidebar forty times an hour. Deliberately
 * modelled on the "go to" pattern people already know from mail and issue
 * trackers — press G, then a letter.
 *
 * SC 2.1.4 Character Key Shortcuts (Level A) governs this. Single-character
 * shortcuts have to be switchable off, remappable, or active only while a
 * component has focus. These are global, so the requirement is met by:
 *
 *   - a switch, in the keyboard help and remembered per browser; and
 *   - never firing while the focus is in a text field, a select, or anything
 *     editable, which is where an unexpected shortcut does real damage —
 *     somebody dictating into a notes field should not be navigated away
 *     mid-sentence.
 *
 * There is no shortcut that destroys anything. Every one of them moves you
 * somewhere or opens help, so a mistyped key costs a keystroke and nothing
 * else.
 */

const STORAGE_KEY = 'loanerpool.shortcuts';

/**
 * Press G, then one of these.
 *
 * Letters follow the word, not a numbering scheme, because the thing people
 * actually recall is the first letter of where they are going.
 */
export const DESTINATIONS = [
  { keys: 'd', path: 'dashboard',    label: 'Dashboard',     capability: null },
  { keys: 's', path: 'scan',         label: 'Scan station',  capability: 'scan.use' },
  { keys: 'v', path: 'devices',      label: 'Devices',       capability: 'devices.read' },
  { keys: 'l', path: 'loans',        label: 'Loans',         capability: 'loans.read' },
  { keys: 'k', path: 'kits',         label: 'Kits',          capability: 'devices.read' },
  { keys: 'e', path: 'repairs',      label: 'Repairs',       capability: 'devices.read' },
  { keys: 'r', path: 'requests',     label: 'Loan requests', capability: 'requests.read' },
  { keys: 'w', path: 'waitlist',     label: 'Waitlist',      capability: 'loans.read' },
  { keys: 'c', path: 'clients',      label: 'Clients',       capability: 'clients.read' },
  { keys: 'p', path: 'programs',     label: 'Programs',      capability: 'programs.read' },
  { keys: 'u', path: 'staff',        label: 'Staff',         capability: 'users.read' },
  { keys: 'o', path: 'reports',      label: 'Reports',       capability: 'reports.read' },
  { keys: 'a', path: 'audit',        label: 'Audit log',     capability: 'audit.read' },
  { keys: ',', path: 'settings',     label: 'Settings',      capability: 'settings.read' },
];

/** Shortcuts that stand on their own. */
export const SINGLE_KEYS = [
  { key: '/', label: 'Search or filter this screen' },
  { key: 'g', label: 'Go to… (then press a letter)' },
  { key: '?', label: 'Show this list' },
  { key: 'Escape', label: 'Close a dialog, or cancel "go to"' },
];

/**
 * How long "G" waits for its second key.
 *
 * Long enough not to punish anyone typing slowly — the people most likely to
 * need these shortcuts are often the slowest to press two keys — and short
 * enough that a forgotten G does not swallow the next thing typed.
 */
const SEQUENCE_TIMEOUT_MS = 3000;

/**
 * Where the search box is, if this screen has one.
 *
 * Defined here and used by both the slash shortcut and the "Skip to search"
 * link, because the two must agree. They did not: the skip link looked for
 * one set of selectors and the shortcut for another, so on every screen whose
 * search is a plain type="search" field the link quietly reported that there
 * was no search while pressing / found it immediately.
 */
const PAGE_SEARCH_SELECTOR =
  '[data-page-search], input[type="search"], [role="search"] input';

export function findPageSearch() {
  return document.querySelector(PAGE_SEARCH_SELECTOR);
}

export function shortcutsEnabled() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Private browsing, or storage blocked. Shortcuts stay on; the setting is
    // a convenience, not a security boundary.
    return true;
  }
}

export function setShortcutsEnabled(on) {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch { /* Nothing to do; the toggle simply will not persist. */ }
}

/**
 * Is the focus somewhere that a bare letter means a letter?
 *
 * Covers the obvious inputs, anything contenteditable, and — importantly —
 * any element that has opted out, so a future widget with its own key
 * handling can say so without this file needing to know about it.
 */
function typingInto(target) {
  if (!target || target === document.body) return false;

  if (target.closest?.('[data-no-shortcuts]')) return true;

  const tag = target.tagName;

  if (tag === 'INPUT') {
    // Checkboxes and radios do not consume letters, so shortcuts still work
    // when the focus is sitting on one.
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type);
  }

  return tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

/**
 * Wire up the shortcuts.
 *
 * @param {object} handlers
 * @param {(path: string) => void}  handlers.navigate
 * @param {() => void}              handlers.showHelp
 * @param {(key: string) => boolean} handlers.can  capability check
 * @param {(msg: string, opts?: object) => void} handlers.announce
 * @param {() => boolean} [handlers.active]  false while nobody is signed in
 */
export function installShortcuts({ navigate, showHelp, can, announce, active = () => true }) {
  let awaitingSecondKey = false;
  let timer = null;

  const endSequence = (why) => {
    if (!awaitingSecondKey) return;
    awaitingSecondKey = false;
    clearTimeout(timer);
    document.body.removeAttribute('data-goto');
    if (why) announce(why);
  };

  document.addEventListener('keydown', (event) => {
    if (!shortcutsEnabled()) return;

    // Nobody signed in: there is nowhere to go and no help to show.
    if (!active()) {
      endSequence(null);
      return;
    }

    // Let the browser and the operating system keep their own combinations.
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'Escape' && awaitingSecondKey) {
      endSequence('Cancelled.');
      event.preventDefault();
      return;
    }

    if (typingInto(event.target)) return;

    // A dialog is modal; navigating out from underneath it would leave the
    // person somewhere they did not ask to be, with a dialog still open.
    if (document.querySelector('dialog[open]')) return;

    if (awaitingSecondKey) {
      const key = event.key.toLowerCase();
      const target = DESTINATIONS.find((d) => d.keys === key);

      endSequence(null);

      if (!target) {
        announce(`No screen is on "${event.key}". Press G then ? for the list.`);
        return;
      }

      if (target.capability && !can(target.capability)) {
        announce(`You do not have access to ${target.label}.`, { assertive: true });
        return;
      }

      event.preventDefault();
      navigate(target.path);
      return;
    }

    if (event.key === 'g' || event.key === 'G') {
      awaitingSecondKey = true;
      // A visible hint as well as an announced one: this is a mode, and a
      // mode nobody can see is a trap.
      document.body.setAttribute('data-goto', 'true');
      announce('Go to. Press a letter, or Escape to cancel.');
      timer = setTimeout(() => endSequence(null), SEQUENCE_TIMEOUT_MS);
      event.preventDefault();
      return;
    }

    if (event.key === '?') {
      showHelp();
      event.preventDefault();
      return;
    }

    if (event.key === '/') {
      // The page's own search, whatever it happens to be called.
      const search = findPageSearch();

      if (search) {
        search.focus();
        search.select?.();
        announce('Search. Type to filter this screen.');
        event.preventDefault();
      }
    }
  });
}

/** The destinations this person can actually reach, for the help dialog. */
export function availableDestinations(can) {
  return DESTINATIONS.filter((d) => !d.capability || can(d.capability));
}
