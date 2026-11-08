/**
 * Application shell and router.
 *
 * Hash-based routing, because the app is served as static files behind
 * Passenger on shared hosting where a history-API fallback for every path is
 * not always configurable. The server does provide a fallback, but hash
 * routing removes a whole class of "works locally, 404s on the host".
 */

import { api, ApiError, onSessionExpired } from './api.js';
import {
  installShortcuts, availableDestinations, SINGLE_KEYS, findPageSearch,
  shortcutsEnabled, setShortcutsEnabled,
} from './shortcuts.js';
import {
  el, clear, $, field, toast, toastError, toastOk, toastWarn, announce, alert as alertBox,
  modal, confirmDialog, withBusy, focusHeading, loadingBlock,
  messagesAutoDismiss, setMessagesAutoDismiss,
} from './ui.js';

import { renderDashboard } from './views/dashboard.js';
import { renderDevices, renderDeviceDetail, renderImport } from './views/devices.js';
import { renderScanStation } from './views/scan.js';
import { renderLoans, renderLoanDetail } from './views/loans.js';
import { renderRequests, renderRequestDetail, renderNewRequest } from './views/requests.js';
import { renderClients, renderPrograms, renderStaff } from './views/directory.js';
import { renderSettings, renderApiKeys, renderLoanPeriods } from './views/admin.js';
import { renderAudit, renderReports } from './views/insights.js';
import { renderKits, renderWaitlist, renderRepairs, renderRepairDetail } from './views/workshop.js';
import { initTheme, openAppearanceDialog } from './theme.js';

/** Shared state every view can read. Never mutated by views directly. */
export const session = {
  user: null,
  organization: null,
  capabilities: [],
  actorType: null,
};

export function can(capability) {
  return session.capabilities.includes(capability);
}

const root = document.getElementById('app-root');
let mainRegion = null;
let navRegion = null;
let pendingCounts = { requests: 0, overdue: 0, repairs: 0, ready: 0 };

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ROUTES = [
  { path: 'dashboard',        title: 'Dashboard',        render: renderDashboard,     capability: null },
  { path: 'scan',             title: 'Scan station',     render: renderScanStation,   capability: 'scan.use' },
  { path: 'devices',          title: 'Devices',          render: renderDevices,       capability: 'devices.read' },
  { path: 'devices/import',   title: 'Import devices',   render: renderImport,        capability: 'devices.import' },
  { path: 'devices/:id',      title: 'Device',           render: renderDeviceDetail,  capability: 'devices.read' },
  { path: 'loans',            title: 'Loans',            render: renderLoans,         capability: 'loans.read' },
  { path: 'loans/:id',        title: 'Loan',             render: renderLoanDetail,    capability: 'loans.read' },
  { path: 'kits',             title: 'Kits',             render: renderKits,          capability: 'devices.read' },
  { path: 'waitlist',         title: 'Waitlist',         render: renderWaitlist,      capability: 'loans.read' },
  { path: 'repairs',          title: 'Repairs',          render: renderRepairs,       capability: 'devices.read' },
  { path: 'repairs/:id',      title: 'Repair',           render: renderRepairDetail,  capability: 'devices.read' },
  { path: 'requests',         title: 'Requests',         render: renderRequests,      capability: 'requests.read' },
  { path: 'requests/new',     title: 'New request',      render: renderNewRequest,    capability: 'requests.write' },
  { path: 'requests/:id',     title: 'Request',          render: renderRequestDetail, capability: 'requests.read' },
  { path: 'clients',          title: 'Clients',          render: renderClients,       capability: 'clients.read' },
  { path: 'programs',         title: 'Programs',         render: renderPrograms,      capability: 'programs.read' },
  { path: 'staff',            title: 'Staff',            render: renderStaff,         capability: 'users.read' },
  { path: 'reports',          title: 'Reports',          render: renderReports,       capability: 'reports.read' },
  { path: 'audit',            title: 'Audit log',        render: renderAudit,         capability: 'audit.read' },
  { path: 'settings',         title: 'Settings',         render: renderSettings,      capability: 'settings.read' },
  { path: 'settings/periods', title: 'Loan periods',     render: renderLoanPeriods,   capability: 'settings.write' },
  { path: 'settings/api',     title: 'API keys',         render: renderApiKeys,       capability: 'apikeys.read' },
];

/** Navigation, grouped. Entries whose capability is missing are not rendered. */
const NAV = [
  {
    label: null,
    items: [
      { path: 'dashboard', label: 'Dashboard', icon: '▤', capability: null },
      { path: 'scan', label: 'Scan station', icon: '⌗', capability: 'scan.use' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { path: 'devices', label: 'Devices', icon: '▣', capability: 'devices.read' },
      { path: 'loans', label: 'Loans', icon: '⇄', capability: 'loans.read', badge: 'overdue' },
      { path: 'kits', label: 'Kits', icon: '⊞', capability: 'devices.read' },
      { path: 'repairs', label: 'Repairs', icon: '⚒', capability: 'devices.read', badge: 'repairs' },
    ],
  },
  {
    label: 'Requests',
    items: [
      { path: 'requests', label: 'Loan requests', icon: '✉', capability: 'requests.read', badge: 'requests' },
      { path: 'waitlist', label: 'Waitlist', icon: '◷', capability: 'loans.read', badge: 'ready' },
    ],
  },
  {
    label: 'People',
    items: [
      { path: 'clients', label: 'Clients', icon: '☺', capability: 'clients.read' },
      { path: 'programs', label: 'Programs', icon: '◈', capability: 'programs.read' },
      { path: 'staff', label: 'Staff', icon: '⚇', capability: 'users.read' },
    ],
  },
  {
    label: 'Insight',
    items: [
      { path: 'reports', label: 'Reports', icon: '◑', capability: 'reports.read' },
      { path: 'audit', label: 'Audit log', icon: '☰', capability: 'audit.read' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { path: 'settings', label: 'Settings', icon: '⚙', capability: 'settings.read' },
      { path: 'settings/api', label: 'API keys', icon: '⚿', capability: 'apikeys.read' },
    ],
  },
];

/** Match a hash path against the route table, extracting :params. */
function matchRoute(path) {
  const segments = path.split('/').filter(Boolean);

  for (const route of ROUTES) {
    const routeSegments = route.path.split('/').filter(Boolean);
    if (routeSegments.length !== segments.length) continue;

    const params = {};
    let matched = true;

    for (let i = 0; i < routeSegments.length; i += 1) {
      if (routeSegments[i].startsWith(':')) {
        params[routeSegments[i].slice(1)] = decodeURIComponent(segments[i]);
      } else if (routeSegments[i] !== segments[i]) {
        matched = false;
        break;
      }
    }

    if (matched) return { route, params };
  }

  return null;
}

export function navigate(path) {
  window.location.hash = `#/${String(path).replace(/^#?\/?/, '')}`;
}

/** A link that participates in routing. */
export function routeLink(path, label, props = {}) {
  return el('a', { href: `#/${String(path).replace(/^#?\/?/, '')}`, ...props }, label);
}

// ---------------------------------------------------------------------------
// Shell rendering
// ---------------------------------------------------------------------------

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

function buildShell() {
  // Landmarks carry names because a screen reader's region list reads the
  // names, not the tags. "navigation" twice over tells somebody nothing;
  // "Sections" and "Account" tell them which one to enter.
  navRegion = el('nav', { class: 'app-nav', 'aria-label': 'Sections' });
  mainRegion = el('main', {
    class: 'app-main', id: 'main-content', tabindex: '-1',
    'aria-label': 'Main content',
  });

  const shell = el('div', { class: 'app-shell' }, [
    // "Skip to main content" is already the first focusable thing in
    // app.html, where it works before this script has even loaded. These two
    // are the extra ones, and they need JavaScript: the sidebar does not
    // exist until somebody is signed in, and the search box differs per
    // screen. A keyboard user arriving mid-task usually wants one of them,
    // and tabbing to either means crossing everything in between.
    el('div', { class: 'skip-links' }, [
      el('a', {
        class: 'skip-link', href: '#app-nav',
        onClick: (e) => { e.preventDefault(); focusRegion(navRegion, 'Sections'); },
      }, 'Skip to section links'),
      el('a', {
        class: 'skip-link', id: 'skip-to-search', href: '#main-content', hidden: true,
        onClick: (e) => {
          e.preventDefault();
          const search = findPageSearch();
          if (search) { search.focus(); search.select?.(); }
          else announce('This screen has no search.');
        },
      }, 'Skip to search'),
    ]),

    el('header', { class: 'app-header', 'aria-label': 'Loaner Pool' }, [
      el('a', { class: 'brand', href: '#/dashboard' }, [
        el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, [
          svgIcon('M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96 12 12.01l8.73-5.05 M12 22.08V12'),
        ]),
        el('span', {}, [
          'Loaner Pool',
          el('span', { class: 'visually-hidden' }, ` — ${session.organization?.name || ''}`),
        ]),
      ]),

      el('div', { class: 'header-actions', role: 'group', 'aria-label': 'Account' }, [
        // In the header, not in settings. Somebody who cannot comfortably
        // read this screen needs this control before they need anything else
        // on it, and a preference three screens deep is one they have to read
        // their way to first.
        el('button', {
          type: 'button',
          class: 'header-btn',
          onClick: openAppearanceDialog,
        }, [
          el('span', { 'aria-hidden': 'true' }, '◐'),
          el('span', {}, 'Appearance'),
        ]),

        // SC 3.2.6 Consistent Help: this control is in the same place on
        // every screen of the application.
        el('button', {
          type: 'button',
          class: 'header-btn',
          onClick: showHelp,
        }, [el('span', { 'aria-hidden': 'true' }, '?'), el('span', {}, 'Help')]),

        el('span', { class: 'user-chip' }, [
          el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(session.user?.full_name) }),
          el('span', { class: 'user-name' }, session.user?.full_name || ''),
        ]),

        el('button', {
          type: 'button',
          class: 'header-btn',
          onClick: signOut,
        }, [el('span', { 'aria-hidden': 'true' }, '⏻'), el('span', {}, 'Sign out')]),
      ]),
    ]),

    el('div', { class: 'app-body' }, [navRegion, mainRegion]),

    // A real contentinfo landmark. Small, but it is the region a screen
    // reader user jumps to looking for "what is this and who runs it".
    el('footer', { class: 'app-footer', 'aria-label': 'About this installation' }, [
      el('p', {}, [
        session.organization?.name || 'Loaner Pool',
        ' · ',
        el('button', {
          type: 'button', class: 'linkish',
          onClick: showHelp,
        }, 'Keyboard shortcuts and help'),
      ]),
    ]),
  ]);

  navRegion.id = 'app-nav';
  navRegion.tabIndex = -1;

  clear(root).append(shell);
  renderNav();

  // Installed once, with the shell. Nothing here is destructive: every
  // shortcut either moves you or opens help.
  installShortcuts({
    navigate: (path) => { window.location.hash = `#/${path}`; },
    showHelp,
    can,
    announce,
  });
}

/**
 * Show or hide the "Skip to search" link to match the screen.
 *
 * Offering it on a screen with no search is worse than not offering it: a
 * keyboard user tabs to a link, presses it, and is told the thing it names
 * does not exist. Hidden when there is nothing to skip to, and pointed at
 * the real field when there is, so the link works on its href alone.
 */
function syncSearchSkipLink() {
  const link = document.getElementById('skip-to-search');
  if (!link) return;

  const search = findPageSearch();

  if (!search) {
    link.hidden = true;
    return;
  }

  if (!search.id) search.id = 'page-search';
  link.href = `#${search.id}`;
  link.hidden = false;
}

/** Move focus into a landmark and say which one it is. */
function focusRegion(region, name) {
  if (!region) return;
  region.focus();
  announce(`${name} region.`);
}

function svgIcon(path) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  for (const segment of path.split(' M').map((s, i) => (i === 0 ? s : `M${s}`))) {
    const node = document.createElementNS(ns, 'path');
    node.setAttribute('d', segment.trim());
    svg.append(node);
  }
  return svg;
}

function renderNav() {
  if (!navRegion) return;
  const current = currentPath();

  clear(navRegion);

  for (const group of NAV) {
    const visible = group.items.filter((item) => !item.capability || can(item.capability));
    if (!visible.length) continue;

    if (group.label) {
      navRegion.append(el('p', { class: 'nav-group-label', text: group.label }));
    }

    navRegion.append(el('ul', {}, visible.map((item) => {
      const isCurrent = current === item.path || current.startsWith(`${item.path}/`);
      const count = item.badge ? pendingCounts[item.badge] : 0;

      return el('li', {}, el('a', {
        href: `#/${item.path}`,
        'aria-current': isCurrent ? 'page' : null,
      }, [
        el('span', { class: 'nav-icon', 'aria-hidden': 'true', text: item.icon }),
        el('span', {}, item.label),
        count > 0
          ? el('span', { class: 'badge-count' }, [
              String(count),
              el('span', { class: 'visually-hidden' }, ` ${item.badge === 'overdue' ? 'overdue' : 'awaiting attention'}`),
            ])
          : null,
      ]));
    })));
  }
}

function currentPath() {
  return window.location.hash.replace(/^#\/?/, '') || 'dashboard';
}

/** Refresh the counts shown as nav badges. Failure here is not worth surfacing. */
async function refreshBadges() {
  if (!can('reports.read')) return;
  try {
    // Counts are fetched together and failures are tolerated individually, so
    // one slow endpoint does not blank every badge.
    const [summary, repairs, waitlist] = await Promise.all([
      api.summary(),
      can('devices.read') ? api.repairs({ open: true, per_page: 1 }).catch(() => null) : null,
      can('loans.read') ? api.reservations({ status: 'ready', per_page: 1 }).catch(() => null) : null,
    ]);

    pendingCounts = {
      requests: summary.requests.awaiting_review || 0,
      overdue: summary.loans.overdue || 0,
      repairs: repairs?.meta?.total || 0,
      ready: waitlist?.meta?.total || 0,
    };
    renderNav();
  } catch {
    // Badge counts are decoration; a failure must not interrupt the user.
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

let renderToken = 0;

async function handleRoute() {
  if (!session.user && session.actorType !== 'user') return;

  const path = currentPath();
  const matched = matchRoute(path);
  const token = ++renderToken;

  if (!matched) {
    clear(mainRegion).append(
      el('div', { class: 'card' }, [
        el('h1', { text: 'Page not found' }),
        el('p', { text: `There is no screen at "${path}".` }),
        el('a', { class: 'btn btn-primary', href: '#/dashboard' }, 'Back to the dashboard'),
      ]),
    );
    document.title = 'Not found — Loaner Pool';
    syncSearchSkipLink();
    focusHeading(mainRegion);
    return;
  }

  const { route, params } = matched;

  if (route.capability && !can(route.capability)) {
    clear(mainRegion).append(
      el('div', { class: 'card' }, [
        el('h1', { text: 'You do not have access to this' }),
        el('p', {
          text:
            `Your account (${session.user?.role_label || 'this role'}) cannot open the ` +
            `${route.title} screen. If you need it, ask an administrator.`,
        }),
        el('a', { class: 'btn btn-primary', href: '#/dashboard' }, 'Back to the dashboard'),
      ]),
    );
    document.title = 'No access — Loaner Pool';
    syncSearchSkipLink();
    focusHeading(mainRegion);
    return;
  }

  document.title = `${route.title} — Loaner Pool`;
  renderNav();
  clear(mainRegion).append(loadingBlock(`Loading ${route.title.toLowerCase()}…`));
  // The previous screen's search went with its content.
  syncSearchSkipLink();

  try {
    const content = await route.render({ params, navigate, session });
    // A slower earlier route must not overwrite a newer one.
    if (token !== renderToken) return;

    clear(mainRegion).append(content);
    syncSearchSkipLink();
    focusHeading(mainRegion);
    announce(`${route.title} loaded.`);
  } catch (err) {
    if (token !== renderToken) return;

    clear(mainRegion).append(
      el('div', { class: 'card' }, [
        el('h1', { text: `Could not load ${route.title.toLowerCase()}` }),
        alertBox(
          err instanceof ApiError ? err.message : `Unexpected error: ${err.message}`,
          { type: 'danger' },
        ),
        el('button', {
          type: 'button', class: 'btn btn-primary', onClick: () => handleRoute(),
        }, 'Try again'),
      ]),
    );
    focusHeading(mainRegion);
  }

  refreshBadges();
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp() {
  modal({
    title: 'Help',
    wide: false,
    // Reading matter, not a form.
    startAtTop: true,
    body: el('div', { class: 'stack' }, [
      el('h3', { text: 'Scanning' }),
      el('p', {
        text:
          'On the Scan station screen, a USB or Bluetooth barcode scanner works with no setup — ' +
          'it types the code and presses Enter. You can also use the camera on this device, ' +
          'pair a phone as a remote scanner, or type the code by hand.',
      }),
      el('h3', { text: 'If a device has no label' }),
      el('p', {
        text:
          'Search for it on the Devices screen and use the check-out or check-in button there. ' +
          'Everything a scanner can do can also be done by hand.',
      }),
      el('h3', { id: 'help-keyboard', text: 'Keyboard shortcuts' }),

      el('p', {
        text:
          'Press Tab from the top of any screen to reach the skip links: main content, the section '
          + 'links, and — on screens that have one — the search box.',
      }),

      // A definition list, not a table: each shortcut is a term and its
      // meaning, which is what a screen reader will read as a pair.
      el('dl', { class: 'shortcut-list' }, SINGLE_KEYS.flatMap((s) => [
        el('dt', {}, el('kbd', { text: s.key })),
        el('dd', { text: s.label }),
      ])),

      el('h4', { text: 'Go to a screen' }),
      el('p', { text: 'Press G, let go, then press the letter. Escape cancels.' }),

      el('dl', { class: 'shortcut-list' }, availableDestinations(can).flatMap((d) => [
        el('dt', {}, [el('kbd', { text: 'G' }), ' ', el('kbd', { text: d.keys.toUpperCase() })]),
        el('dd', { text: d.label }),
      ])),

      el('p', {
        class: 'field-help',
        text:
          'Shortcuts never fire while you are typing in a text box, and none of them changes or '
          + 'deletes anything — each one moves you somewhere or opens this help.',
      }),

      // SC 2.1.4 Character Key Shortcuts: a single-character shortcut has to
      // be switchable off. The switch lives here, beside the list it governs,
      // rather than buried in settings.
      shortcutToggle(),
      messageToggle(),

      el('h3', { text: 'If the screen is hard to read' }),
      el('p', {
        text:
          'The Appearance button at the top of every screen sets light, dark, or two colours of '
          + 'your own — it measures the contrast between them and tells you what it meets. '
          + 'Windows High Contrast and the equivalent setting on other systems are followed too, '
          + 'and take precedence when they are switched on.',
      }),
      el('p', {}, [
        el('button', {
          type: 'button', class: 'btn btn-sm', onClick: openAppearanceDialog,
        }, 'Change colours and contrast'),
      ]),

      glossary(),
      el('h3', { text: 'Who to contact' }),
      el('p', {
        text: session.organization?.contact_email
          ? `For anything this screen cannot answer, contact ${session.organization.contact_email}.`
          : 'Contact your Loaner Pool administrator for anything this screen cannot answer.',
      }),
    ]),
    actions: [{ label: 'Close', class: 'btn-primary', value: null }],
  });
}

/**
 * What the words mean.
 *
 * SC 3.1.3 Unusual Words and SC 3.1.4 Abbreviations (both Level AAA) ask for
 * a mechanism to find the meaning of jargon and the expansion of
 * abbreviations. A glossary reachable from every screen is that mechanism —
 * technique G102 — and it is cheaper than wrapping several hundred generated
 * strings in <abbr>, which would also read badly aloud, since a screen
 * reader announces the expansion every single time.
 *
 * It earns its place twice over: a VR agency hires people who have never seen
 * half of these words either, and the first week is mostly asking what they
 * mean.
 */
const TERMS = [
  ['VRC', 'Vocational Rehabilitation Counselor — the person who requests equipment for a client.'],
  ['AT', 'Assistive technology: the equipment this pool lends.'],
  ['Client', 'The person the equipment is for.'],
  ['Program', 'An activity a loan belongs to, such as a summer programme or a training course.'],
  ['Loan', 'One device out to one person, with a due date.'],
  ['Kit', 'Several devices that go out and come back together as one loan.'],
  ['Reservation', 'A hold on a device, or on any device of a category, for a future date.'],
  ['Waitlist', 'Who is waiting for something that is currently all out.'],
  ['Outcome', 'What the loan told you: whether the equipment suited the person.'],
  ['CSV', 'Comma-separated values: a spreadsheet file that Excel and Google Sheets both open.'],
  ['API', 'Application programming interface: the way another system talks to this one.'],
  ['API key', 'A password another system uses instead of signing in as a person.'],
  ['QR code', 'A square barcode. A phone camera can read one.'],
  ['SMS', 'A text message.'],
  ['Two-factor', 'A six-digit code from an app, asked for after the password.'],
  ['Sanitising', 'Cleaning a device between two people, recorded with a date and a method.'],
];

function glossary() {
  return el('details', { class: 'glossary' }, [
    el('summary', { text: 'What the words mean' }),
    el('dl', { class: 'detail-list' }, TERMS.flatMap(([term, meaning]) => [
      el('dt', { text: term }),
      el('dd', { text: meaning }),
    ])),
  ]);
}

/**
 * Whether confirmations clear themselves.
 *
 * SC 2.2.4 Interruptions. Sits beside the shortcut switch rather than in
 * settings, because somebody who has just watched a message disappear before
 * they finished reading it will look for the control where they are, which is
 * the help they already opened — not three screens away.
 */
function messageToggle() {
  const input = el('input', {
    type: 'checkbox', id: 'messages-autodismiss', checked: messagesAutoDismiss(),
  });

  input.addEventListener('change', () => {
    setMessagesAutoDismiss(input.checked);
    announce(input.checked
      ? 'Confirmations will clear themselves after a few seconds.'
      : 'Confirmations will now stay until you dismiss them.');
  });

  return el('label', { class: 'checkbox', for: 'messages-autodismiss' }, [
    input,
    el('span', {}, [
      'Let confirmations clear themselves',
      el('span', {
        class: 'option-help',
        text: 'Turn this off to keep every message on screen until you close it. '
            + 'Errors already stay put either way. Remembered on this browser.',
      }),
    ]),
  ]);
}

/** The on/off switch for the single-key shortcuts. */
function shortcutToggle() {
  const input = el('input', {
    type: 'checkbox', id: 'shortcuts-on', checked: shortcutsEnabled(),
  });

  input.addEventListener('change', () => {
    setShortcutsEnabled(input.checked);
    announce(input.checked
      ? 'Keyboard shortcuts are on.'
      : 'Keyboard shortcuts are off. Tab, Shift+Tab and Escape still work.');
  });

  return el('label', { class: 'checkbox', for: 'shortcuts-on' }, [
    input,
    el('span', {}, [
      'Use single-key shortcuts',
      el('span', {
        class: 'option-help',
        text: 'Turn this off if you use speech recognition, or if a single keypress reaching the '
            + 'page would get in your way. It switches off every one of them, this list '
            + 'included — the Help button at the top of the screen still opens it. '
            + 'Remembered on this browser.',
      }),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

/** Everything that happens once an identity is finally established. */
function completeSignIn(result) {
  session.user = result.user;
  session.organization = result.organization;
  session.capabilities = result.capabilities;
  session.actorType = 'user';

  announce(`Signed in as ${result.user.full_name}.`);
  start();

  if (result.must_change_password) promptPasswordChange();

  // Said after the dashboard has rendered, so it is advice rather than a
  // barrier — an administrator who has not enrolled yet still has to be able
  // to get in and do it.
  if (result.must_enrol_2fa) {
    toastWarn(
      'This organisation requires administrators to use a second factor. Set one up from your ' +
      'account settings.',
      'Two-factor sign-in needed',
    );
  }

  if (result.recovery_notice) {
    toastWarn(result.recovery_notice, 'You used a recovery code');
  }
}

/**
 * The second step of a two-factor sign-in.
 *
 * A separate screen with its own heading and its own focus, because this is
 * the point at which somebody who has lost their phone needs to find the way
 * out — so the recovery route is on screen, not hidden behind a link.
 */
function renderSecondFactor(login, email) {
  const codeField = field({
    name: 'code',
    label: 'Six-digit code',
    required: true,
    // one-time-code lets iOS and Android offer the code from the keyboard,
    // and tells a password manager what this field is for. inputmode numeric
    // brings up the number pad without rejecting a pasted recovery code.
    autocomplete: 'one-time-code',
    inputmode: 'numeric',
    help: login.can_recover
      ? 'From your authenticator app. A recovery code works here too.'
      : 'From your authenticator app.',
  });

  const errorRegion = el('div', { role: 'alert' });
  const submitButton = el('button', { type: 'submit', class: 'btn btn-primary btn-block btn-lg' },
    'Verify and sign in');

  const form = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      clear(errorRegion);
      codeField.setError(null);

      const code = codeField.control.value.trim();

      if (!code) {
        codeField.setError('Enter the code from your app.');
        codeField.control.focus();
        return;
      }

      await withBusy(submitButton, 'Checking…', async () => {
        try {
          completeSignIn(await api.verifySecondFactor(login.pending_id, code));
        } catch (err) {
          const message = err instanceof ApiError ? err.message : 'Could not verify that code.';
          errorRegion.append(alertBox(message, { type: 'danger', title: 'Not verified' }));
          announce(`Not verified. ${message}`, { assertive: true });
          codeField.control.value = '';
          codeField.control.focus();
        }
      });
    },
  }, [codeField, submitButton]);

  clear(root).append(el('div', { class: 'centred-page' }, [
    el('div', { class: 'centred-card' }, [
      el('div', { class: 'brand-block' }, [
        el('span', { class: 'brand-mark-lg', 'aria-hidden': 'true' }, [
          svgIcon('M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96 12 12.01l8.73-5.05 M12 22.08V12'),
        ]),
        el('h1', { text: 'One more step' }),
        el('p', { text: `Signing in as ${email}.` }),
      ]),
      el('div', { class: 'card' }, [
        errorRegion,
        form,
        el('details', { style: { marginTop: '16px' } }, [
          el('summary', { text: 'I have lost my phone' }),
          el('p', {
            class: 'field-help',
            text: login.recovery_hint
              || 'Enter one of the recovery codes you saved when you set this up.',
          }),
          el('p', {
            class: 'field-help',
            text: 'If you have no codes left, another administrator can turn two-factor off for '
                + 'your account from the staff list.',
          }),
        ]),
        el('button', {
          type: 'button', class: 'btn btn-ghost btn-block', style: { marginTop: '12px' },
          onClick: () => renderSignIn({ message: 'Signing in was cancelled.' }),
        }, 'Start again'),
      ]),
    ]),
  ]));

  // Focus goes to the field, and the heading is announced, so a screen reader
  // user is told the page changed rather than left on a silent form.
  announce('Two-factor verification needed. Enter the six-digit code from your authenticator app.',
    { assertive: true });
  codeField.control.focus();
}

function renderSignIn({ message = null } = {}) {
  const emailField = field({
    name: 'email', label: 'Email address', type: 'email', required: true,
    // SC 1.3.5 / 3.3.8 — lets a password manager identify and fill the form.
    autocomplete: 'username',
  });
  const passwordField = field({
    name: 'password', label: 'Password', type: 'password', required: true,
    autocomplete: 'current-password',
  });

  const errorRegion = el('div', { role: 'alert' });
  const submitButton = el('button', { type: 'submit', class: 'btn btn-primary btn-block btn-lg' }, 'Sign in');

  const form = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      clear(errorRegion);
      emailField.setError(null);
      passwordField.setError(null);

      const email = emailField.control.value.trim();
      const password = passwordField.control.value;

      if (!email) { emailField.setError('Enter your email address.'); emailField.control.focus(); return; }
      if (!password) { passwordField.setError('Enter your password.'); passwordField.control.focus(); return; }

      await withBusy(submitButton, 'Signing in…', async () => {
        try {
          const result = await api.login(email, password);

          // The password was right but a code is still needed. Rendered as a
          // second screen rather than a dialog: it is a step in signing in,
          // not an interruption, and a dialog over an empty page reads as an
          // error to anyone using a screen reader.
          if (result.second_factor_required) {
            renderSecondFactor(result, email);
            return;
          }

          completeSignIn(result);
        } catch (err) {
          const message = err instanceof ApiError ? err.message : 'Could not sign in.';
          errorRegion.append(alertBox(message, { type: 'danger', title: 'Sign-in failed' }));
          announce(`Sign-in failed. ${message}`, { assertive: true });
          passwordField.control.value = '';
          passwordField.control.focus();
        }
      });
    },
  }, [
    emailField,
    passwordField,
    submitButton,
    el('p', { style: { textAlign: 'center', marginTop: '14px', marginBottom: 0 } }, [
      el('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        onClick: () => openForgotPasswordDialog(emailField.control.value.trim()),
      }, 'I have forgotten my password'),
    ]),
  ]);

  clear(root).append(el('div', { class: 'centred-page' }, [
    el('div', { class: 'centred-card' }, [
      el('div', { class: 'brand-block' }, [
        el('span', { class: 'brand-mark-lg', 'aria-hidden': 'true' }, [
          svgIcon('M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96 12 12.01l8.73-5.05 M12 22.08V12'),
        ]),
        el('h1', { text: 'Loaner Pool' }),
        el('p', { text: 'Sign in to manage devices, loans and requests.' }),
      ]),
      el('div', { class: 'card' }, [
        message ? alertBox(message, { type: 'info' }) : null,
        errorRegion,
        form,
      ]),

      // Before sign-in, deliberately. Somebody who cannot read light text on
      // a blue header cannot sign in to say so, and a colour setting that
      // only exists behind the sign-in form is no use to the people it is
      // for.
      el('p', { class: 'signin-appearance' }, [
        el('button', {
          type: 'button', class: 'btn btn-ghost btn-sm', onClick: openAppearanceDialog,
        }, [el('span', { 'aria-hidden': 'true' }, '◐ '), 'Change colours and contrast']),
      ]),
    ]),
  ]));

  emailField.control.focus();
}

/**
 * Ask for a reset link.
 *
 * The response is identical whether or not the address exists, so this dialog
 * says the same thing either way — anything else would let someone work out
 * who has an account.
 */
function openForgotPasswordDialog(prefill = '') {
  const emailField = field({
    name: 'email', label: 'Your email address', type: 'email', required: true,
    value: prefill, autocomplete: 'username',
  });

  return modal({
    title: 'Reset your password',
    body: el('div', {}, [
      el('p', {
        text:
          'Enter the address you sign in with. If it belongs to an account, we will email a link ' +
          'that lets you choose a new password. The link works once and expires in an hour.',
      }),
      emailField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Send the link',
        class: 'btn-primary',
        onClick: async (close) => {
          emailField.setError(null);
          const email = emailField.control.value.trim();
          if (!email) {
            emailField.setError('Enter your email address.');
            emailField.control.focus();
            return;
          }

          try {
            const result = await api.forgotPassword(email);
            close(true);
            toastOk(result.message, 'Check your inbox');
            if (result.admin_warning) toastWarn(result.admin_warning, 'Email not configured');
          } catch (err) {
            emailField.setError(err.message);
            emailField.control.focus();
          }
        },
      },
    ],
  });
}

/**
 * The screen someone lands on from the emailed link.
 * Reached at #/reset?token=… before any session exists.
 */
function renderResetPassword(token) {
  const newField = field({
    name: 'new_password', label: 'New password', type: 'password', required: true,
    help: 'At least 12 characters, with at least one number or symbol.',
    autocomplete: 'new-password',
  });
  const confirmField = field({
    name: 'confirm_password', label: 'Confirm new password', type: 'password',
    required: true, autocomplete: 'new-password',
  });

  const errorRegion = el('div', { role: 'alert' });
  const submitButton = el('button', { type: 'submit', class: 'btn btn-primary btn-block btn-lg' }, 'Set my password');

  const form = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      clear(errorRegion);
      newField.setError(null);
      confirmField.setError(null);

      if (newField.control.value !== confirmField.control.value) {
        confirmField.setError('The two passwords do not match.');
        confirmField.control.focus();
        return;
      }

      await withBusy(submitButton, 'Saving…', async () => {
        try {
          const result = await api.resetPassword({
            token,
            new_password: newField.control.value,
            confirm_password: confirmField.control.value,
          });
          window.location.hash = '';
          renderSignIn({ message: result.message });
        } catch (err) {
          const target = err.field === 'token' ? null : newField;
          if (target) {
            target.setError(err.message);
            target.control.focus();
          } else {
            errorRegion.append(alertBox(err.message, { type: 'danger', title: 'That link did not work' }));
          }
        }
      });
    },
  }, [newField, confirmField, submitButton]);

  clear(root).append(el('div', { class: 'centred-page' }, [
    el('div', { class: 'centred-card' }, [
      el('div', { class: 'brand-block' }, [
        el('h1', { text: 'Choose a new password' }),
        el('p', { text: 'Once you save this, you will be signed out everywhere else.' }),
      ]),
      el('div', { class: 'card' }, [errorRegion, form]),
    ]),
  ]));

  newField.control.focus();
}

function promptPasswordChange() {
  const currentField = field({
    name: 'current_password', label: 'Current password', type: 'password',
    required: true, autocomplete: 'current-password',
  });
  const newField = field({
    name: 'new_password', label: 'New password', type: 'password', required: true,
    help: 'At least 12 characters, with at least one number or symbol.',
    autocomplete: 'new-password',
  });
  const confirmField = field({
    name: 'confirm_password', label: 'Confirm new password', type: 'password',
    required: true, autocomplete: 'new-password',
  });

  modal({
    title: 'Choose a new password',
    body: el('div', {}, [
      el('p', {
        text:
          'Your password was set by an administrator, so they know it. ' +
          'Choose one only you know before you carry on.',
      }),
      currentField, newField, confirmField,
    ]),
    actions: [
      { label: 'Later', class: 'btn-ghost', value: null },
      {
        label: 'Change password',
        class: 'btn-primary',
        onClick: async (close) => {
          for (const f of [currentField, newField, confirmField]) f.setError(null);

          if (newField.control.value !== confirmField.control.value) {
            confirmField.setError('The two passwords do not match.');
            confirmField.control.focus();
            return;
          }

          try {
            await api.changePassword({
              current_password: currentField.control.value,
              new_password: newField.control.value,
              confirm_password: confirmField.control.value,
            });
            toastOk('Your password has been changed and all other sessions were signed out.');
            close(true);
          } catch (err) {
            const target = err.field === 'current_password' ? currentField : newField;
            target.setError(err.message);
            target.control.focus();
          }
        },
      },
    ],
  });
}

async function signOut() {
  const confirmed = await confirmDialog({
    title: 'Sign out?',
    message: 'You will need to sign in again to use Loaner Pool.',
    confirmLabel: 'Sign out',
  });
  if (!confirmed) return;

  try {
    await api.logout();
  } catch {
    // Even if the server call fails, clear local state — the user asked to leave.
  }

  session.user = null;
  session.capabilities = [];
  session.actorType = null;
  window.location.hash = '';
  renderSignIn({ message: 'You have been signed out.' });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function start() {
  buildShell();
  if (!window.location.hash || window.location.hash === '#') {
    window.location.hash = '#/dashboard';
  }
  handleRoute();
  refreshBadges();
}

/**
 * Sign back in without losing the screen.
 *
 * SC 2.2.5 Re-authenticating (Level AAA): when an authenticated session
 * expires, the person must be able to carry on after signing in again
 * without losing what they had done. This used to replace the whole page
 * with the sign-in form, which threw away a half-filled request form or a
 * check-out in progress — and the people most likely to hit it are the ones
 * who take longest over a form.
 *
 * So the page stays where it is and the sign-in comes over the top. A
 * <dialog> is modal and inert-makes the background, so nothing behind it can
 * be touched while it is open, but it is all still there afterwards.
 *
 * Falls back to the full sign-in screen where carrying on is not possible:
 * if a second factor is needed, if the account is being made to change its
 * password, or if the person would rather start again.
 */
let reauthOpen = false;

async function promptReauthentication() {
  // Every request in flight gets a 401 when a session goes, so this fires
  // several times over. One dialog.
  if (reauthOpen) return;

  const email = session.user?.email;

  if (!email) {
    signOutToSignIn('Your session has expired. Please sign in again.');
    return;
  }

  reauthOpen = true;

  const passwordField = field({
    name: 'password', label: 'Password', type: 'password', required: true,
    autocomplete: 'current-password',
  });
  const errorRegion = el('div', { role: 'alert' });

  const signedBackIn = await modal({
    title: 'Your session has expired',
    body: el('div', { class: 'stack' }, [
      el('p', {
        text: `Signing in again as ${email}. Nothing on the screen behind this has been lost — `
            + 'you will be back where you were.',
      }),
      errorRegion,
      // A form, so Enter submits and a password manager recognises it.
      el('form', {
        novalidate: true,
        onSubmit: (event) => event.preventDefault(),
      }, [passwordField]),
    ]),
    actions: [
      {
        label: 'Start again',
        class: 'btn-ghost',
        onClick: (close) => close(false),
      },
      {
        label: 'Sign in',
        class: 'btn-primary',
        onClick: async (close, dialog) => {
          const password = passwordField.control.value;

          if (!password) {
            passwordField.setError('Enter your password.');
            passwordField.control.focus();
            return;
          }

          const button = dialog.querySelector('.modal-footer .btn-primary');

          await withBusy(button, 'Signing in…', async () => {
            try {
              const result = await api.login(email, password);

              // Both of these need the full screen: one is another step, the
              // other is a form that must be completed before anything else.
              if (result.second_factor_required || result.must_change_password) {
                close(false);
                return;
              }

              session.user = result.user;
              session.organization = result.organization;
              session.capabilities = result.capabilities;
              session.actorType = 'user';

              close(true);
            } catch (err) {
              clear(errorRegion);
              const message = err instanceof ApiError ? err.message : 'Could not sign in.';
              errorRegion.append(alertBox(message, { type: 'danger', title: 'Sign-in failed' }));
              announce(`Sign-in failed. ${message}`, { assertive: true });
              passwordField.control.value = '';
              passwordField.control.focus();
            }
          });
        },
      },
    ],
  });

  reauthOpen = false;

  if (signedBackIn === true) {
    announce('Signed back in. You are where you were.');
    toastOk('You are signed back in.');
    renderNav();
    refreshBadges();
    return;
  }

  signOutToSignIn('Your session has expired. Please sign in again.');
}

function signOutToSignIn(message) {
  session.user = null;
  session.capabilities = [];
  renderSignIn({ message });
}

onSessionExpired(() => {
  // Already signed out, or never signed in: nothing to re-authenticate.
  if (!session.user) return;
  promptReauthentication();
});

window.addEventListener('hashchange', handleRoute);

/** A reset link is followed before any session exists, so check for it first. */
function resetTokenFromHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (!hash.startsWith('reset')) return null;
  return new URLSearchParams(hash.split('?')[1] || '').get('token');
}

async function boot() {
  // theme-boot.js has already put the stored appearance on screen. This hands
  // ownership back to the module that computed it, and starts listening for
  // the device switching between light and dark — without which "follow this
  // device" would stop following it until the next reload.
  initTheme();

  const resetToken = resetTokenFromHash();
  if (resetToken) {
    renderResetPassword(resetToken);
    return;
  }

  try {
    const me = await api.me();
    session.user = me.user;
    session.organization = me.organization;
    session.capabilities = me.capabilities;
    session.actorType = me.actor_type;
    start();
    if (me.must_change_password) promptPasswordChange();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderSignIn();
      return;
    }
    if (err instanceof ApiError && err.code === 'not_installed') {
      window.location.href = '/install.html';
      return;
    }

    clear(root).append(el('div', { class: 'centred-page' }, [
      el('div', { class: 'centred-card' }, [
        el('div', { class: 'card' }, [
          el('h1', { text: 'Loaner Pool could not start' }),
          alertBox(err.message, { type: 'danger' }),
          el('button', {
            type: 'button', class: 'btn btn-primary', onClick: () => window.location.reload(),
          }, 'Reload'),
        ]),
      ]),
    ]));
  }
}

boot();
