/**
 * Accessible UI primitives.
 *
 * Every helper here exists because the accessible version of a pattern is
 * fiddly enough that doing it inline in each view guarantees it will be got
 * wrong somewhere. Focus management, live-region announcements and field
 * error wiring in particular.
 */

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

/**
 * Create an element.
 *
 * Text content is set via textContent, never innerHTML, so nothing a user
 * typed into a device name or a client note can become markup. The one
 * deliberate exception is `html:` for server-generated SVG (barcodes), which
 * is explicitly named so it stands out in review.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list' && typeof value !== 'object') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * append(), but skipping null, undefined and false.
 *
 * `Node.append()` stringifies anything that is not a Node, so passing a
 * `condition ? node : null` argument renders the literal word "null" on the
 * page. `el()` filters its children for exactly this reason; use this wherever
 * children are appended directly instead.
 */
export function mount(target, ...children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    target.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return target;
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

// ---------------------------------------------------------------------------
// Live region announcements
// ---------------------------------------------------------------------------

let politeRegion = null;
let assertiveRegion = null;

function ensureRegions() {
  if (politeRegion) return;

  politeRegion = el('div', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' });
  assertiveRegion = el('div', { class: 'visually-hidden', 'aria-live': 'assertive', 'aria-atomic': 'true' });
  document.body.append(politeRegion, assertiveRegion);
}

/**
 * Announce a message to screen readers.
 *
 * The text is cleared first and set on the next frame — a live region whose
 * content is replaced with an identical string is not re-announced, which
 * silently breaks repeated scans of the same barcode.
 */
export function announce(message, { assertive = false } = {}) {
  ensureRegions();
  const region = assertive ? assertiveRegion : politeRegion;
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = message; });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastRegion = null;

function ensureToastRegion() {
  if (toastRegion) return toastRegion;
  toastRegion = el('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
  document.body.append(toastRegion);
  return toastRegion;
}

/**
 * Show a transient message.
 *
 * Errors do not auto-dismiss: WCAG 2.2 SC 2.2.1 aside, a message that vanishes
 * before it is read is worse than no message. Successes clear themselves.
 */
export function toast(message, { type = 'info', title = null, timeout = null } = {}) {
  const region = ensureToastRegion();

  const closeButton = el('button', {
    type: 'button',
    class: 'toast-close',
    'aria-label': 'Dismiss this message',
    onClick: () => node.remove(),
  }, '×');

  const node = el('div', { class: `toast is-${type}` }, [
    el('div', { class: 'toast-body' }, [
      title ? el('strong', { class: 'toast-title', text: title }) : null,
      el('span', { text: message }),
    ]),
    closeButton,
  ]);

  region.append(node);
  announce(title ? `${title}. ${message}` : message, { assertive: type === 'danger' });

  const life = timeout ?? (type === 'danger' ? null : 5200);
  if (life) setTimeout(() => node.remove(), life);

  return node;
}

export const toastOk = (message, title) => toast(message, { type: 'ok', title });
export const toastError = (message, title = 'Something went wrong') =>
  toast(message, { type: 'danger', title });
export const toastWarn = (message, title) => toast(message, { type: 'warn', title });

// ---------------------------------------------------------------------------
// Modal dialogs
// ---------------------------------------------------------------------------

/**
 * Open a modal built on <dialog>, which gives focus trapping, Escape handling
 * and inertness of the background for free — all things that hand-rolled
 * modals routinely get wrong.
 *
 * Resolves with the value passed to `close()`, or null if dismissed.
 */
export function modal({ title, body, actions = [], wide = false, onOpen = null }) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
    let result = null;

    const dialog = el('dialog', {
      class: `modal${wide ? ' modal-wide' : ''}`,
      'aria-labelledby': titleId,
    });

    const close = (value = null) => {
      result = value;
      dialog.close();
    };

    const footer = el('div', { class: 'modal-footer' },
      actions.map((action) => el('button', {
        type: 'button',
        class: `btn ${action.class || ''}`.trim(),
        onClick: () => action.onClick ? action.onClick(close, dialog) : close(action.value ?? null),
      }, action.label)),
    );

    dialog.append(
      el('div', { class: 'modal-header' }, [
        el('h2', { id: titleId, text: title }),
        el('button', {
          type: 'button',
          class: 'btn btn-ghost btn-icon',
          'aria-label': 'Close this dialog',
          onClick: () => close(null),
        }, '×'),
      ]),
      el('div', { class: 'modal-body' }, [body]),
      actions.length ? footer : null,
    );

    dialog.addEventListener('close', () => {
      dialog.remove();
      // Return focus to whatever opened the dialog — SC 2.4.3 Focus Order.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      resolve(result);
    });

    document.body.append(dialog);
    dialog.showModal();

    // Focus the first meaningful control rather than the close button.
    const firstField = dialog.querySelector(
      '.modal-body input:not([type="hidden"]), .modal-body select, .modal-body textarea, .modal-body button',
    );
    (firstField || dialog.querySelector('.modal-footer .btn') || dialog).focus();

    if (onOpen) onOpen(dialog, close);
  });
}

/** Confirmation dialog. Destructive actions get a danger-styled confirm. */
export function confirmDialog({
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
}) {
  return modal({
    title,
    body: el('p', { text: message }),
    actions: [
      { label: cancelLabel, class: 'btn-ghost', value: false },
      { label: confirmLabel, class: danger ? 'btn-danger' : 'btn-primary', value: true },
    ],
  }).then((value) => value === true);
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/**
 * A labelled form field wired for accessibility:
 *   - label bound via `for`/`id`
 *   - help text and error text bound via aria-describedby
 *   - aria-invalid toggled together with the visible error
 *
 * `autocomplete` is passed through because WCAG 2.2 SC 3.3.8 (Accessible
 * Authentication) and SC 1.3.5 (Identify Input Purpose) both depend on it, and
 * it is what lets a password manager fill the form.
 */
export function field({
  name, label, type = 'text', value = '', required = false, help = null,
  options = null, placeholder = null, autocomplete = null, inputmode = null,
  min = null, max = null, step = null, rows = null, disabled = false, pattern = null,
}) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const helpId = help ? `${id}-help` : null;
  const errorId = `${id}-error`;

  const describedBy = [helpId, errorId].filter(Boolean).join(' ');

  const shared = {
    id, name, required, disabled,
    'aria-describedby': describedBy || null,
    autocomplete,
    inputmode,
    placeholder,
  };

  let control;
  if (type === 'select') {
    control = el('select', shared, (options || []).map((option) =>
      el('option', {
        value: option.value,
        selected: String(option.value) === String(value),
        disabled: option.disabled || false,
      }, option.label)));
  } else if (type === 'textarea') {
    control = el('textarea', { ...shared, rows: rows || 4 });
    control.value = value ?? '';
  } else {
    control = el('input', { ...shared, type, value: value ?? '', min, max, step, pattern });
  }

  const errorNode = el('p', { class: 'field-error', id: errorId, hidden: true, role: 'alert' });

  const wrapper = el('div', { class: 'field' }, [
    el('label', { for: id }, [
      label,
      required ? el('span', { class: 'required-marker', 'aria-hidden': 'true' }, '*') : null,
      required ? el('span', { class: 'visually-hidden' }, ' (required)') : null,
    ]),
    control,
    help ? el('p', { class: 'field-help', id: helpId, text: help }) : null,
    errorNode,
  ]);

  wrapper.control = control;
  wrapper.setError = (message) => {
    if (message) {
      errorNode.textContent = message;
      errorNode.hidden = false;
      control.setAttribute('aria-invalid', 'true');
    } else {
      errorNode.textContent = '';
      errorNode.hidden = true;
      control.removeAttribute('aria-invalid');
    }
  };

  return wrapper;
}

/** Read a form's values as a plain object, treating empty strings as null. */
export function formValues(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) {
    data[key] = value === '' ? null : value;
  }
  // FormData omits unchecked boxes entirely, which would read as "unchanged".
  for (const box of form.querySelectorAll('input[type="checkbox"]')) {
    data[box.name] = box.checked;
  }
  return data;
}

/**
 * Apply an ApiError to a form: mark the offending field, move focus to it, and
 * announce the message. Falls back to a toast when the error names no field.
 */
export function applyApiError(error, fieldsByName = {}) {
  const name = error.field;
  const target = name ? fieldsByName[name] : null;

  if (target?.setError) {
    target.setError(error.message);
    target.control.focus();
    announce(error.message, { assertive: true });
    return true;
  }

  toastError(error.message);
  return false;
}

/** Clear every error on a set of fields. */
export function clearErrors(fieldsByName) {
  for (const f of Object.values(fieldsByName)) f?.setError?.(null);
}

/** Disable a button and show a spinner while an async action runs. */
export async function withBusy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  clear(button).append(el('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${label}`);

  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = original;
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const DEVICE_STATUS_STYLE = {
  available:   { class: 'pill-ok',      label: 'Available' },
  checked_out: { class: 'pill-info',    label: 'On loan' },
  reserved:    { class: 'pill-warn',    label: 'Reserved' },
  maintenance: { class: 'pill-warn',    label: 'Maintenance' },
  retired:     { class: 'pill-neutral', label: 'Retired' },
  lost:        { class: 'pill-danger',  label: 'Lost' },
};

const LOAN_STATUS_STYLE = {
  active:    { class: 'pill-info',    label: 'On loan' },
  returned:  { class: 'pill-ok',      label: 'Returned' },
  cancelled: { class: 'pill-neutral', label: 'Cancelled' },
  overdue:   { class: 'pill-danger',  label: 'Overdue' },
};

const REQUEST_STATUS_STYLE = {
  submitted: { class: 'pill-warn',    label: 'Awaiting review' },
  approved:  { class: 'pill-info',    label: 'Approved' },
  denied:    { class: 'pill-danger',  label: 'Declined' },
  cancelled: { class: 'pill-neutral', label: 'Cancelled' },
  fulfilled: { class: 'pill-ok',      label: 'Delivered' },
};

/** A status pill. The label is always rendered as text, never colour alone. */
export function pill(status, kind = 'device') {
  const table = kind === 'loan' ? LOAN_STATUS_STYLE
    : kind === 'request' ? REQUEST_STATUS_STYLE
    : DEVICE_STATUS_STYLE;

  const style = table[status] || { class: 'pill-neutral', label: String(status || 'Unknown') };
  return el('span', { class: `pill ${style.class}` }, style.label);
}

export function formatDate(value, { withTime = false } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  return date.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

/** "in 3 days" / "2 days ago". Paired with an absolute date, never alone. */
export function relativeDays(value) {
  if (!value) return '';
  const days = Math.round((new Date(value).getTime() - Date.now()) / 86400000);

  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

/** A <time> element carrying the machine-readable value for assistive tech. */
export function dateCell(value, { withTime = false, relative = false } = {}) {
  if (!value) return el('span', { class: 'muted' }, '—');

  const absolute = formatDate(value, { withTime });
  return el('time', { datetime: new Date(value).toISOString() }, [
    absolute,
    relative ? el('span', { class: 'cell-sub', text: relativeDays(value) }) : null,
  ]);
}

export function emptyState({ icon = '📭', title, message, action = null }) {
  return el('div', { class: 'empty-state' }, [
    el('div', { class: 'empty-icon', 'aria-hidden': 'true', text: icon }),
    el('h3', { text: title }),
    message ? el('p', { text: message }) : null,
    action,
  ]);
}

export function loadingBlock(message = 'Loading…') {
  return el('div', { class: 'loading-block', role: 'status' }, [
    el('span', { class: 'spinner', 'aria-hidden': 'true' }),
    ` ${message}`,
  ]);
}

export function alert(message, { type = 'info', title = null } = {}) {
  const icons = { info: 'ℹ', ok: '✓', warn: '⚠', danger: '⚠' };
  return el('div', { class: `alert alert-${type}`, role: type === 'danger' ? 'alert' : null }, [
    el('span', { class: 'alert-icon', 'aria-hidden': 'true', text: icons[type] || 'ℹ' }),
    el('div', { class: 'alert-body' }, [
      title ? el('h3', { text: title }) : null,
      el('p', { text: message }),
    ]),
  ]);
}

/**
 * A data table with a caption for screen readers and scoped headers.
 * `columns` is [{ key, label, render?, align?, sortable? }].
 */
export function dataTable({ caption, columns, rows, rowClass = null, emptyMessage = 'Nothing to show.' }) {
  if (!rows.length) {
    return el('div', { class: 'table-wrap' }, [emptyState({ title: emptyMessage })]);
  }

  const table = el('table', {}, [
    el('caption', { class: 'visually-hidden', text: caption }),
    el('thead', {}, el('tr', {}, columns.map((column) =>
      el('th', { scope: 'col', class: column.align === 'right' ? 'right' : null }, column.label)))),
    el('tbody', {}, rows.map((row) =>
      el('tr', { class: rowClass ? rowClass(row) : null }, columns.map((column) => {
        const content = column.render ? column.render(row) : (row[column.key] ?? '—');
        return el('td', { class: column.align === 'right' ? 'right' : null },
          content instanceof Node ? content : String(content));
      })))),
  ]);

  return el('div', { class: 'table-wrap' }, table);
}

/**
 * Pagination control. Announces the range so it is not visual-only.
 *
 * Returns an empty DocumentFragment rather than null when there is only one
 * page. `Node.append()` stringifies anything that is not a Node, so returning
 * null here printed the literal text "null" under every single-page list —
 * appending an empty fragment is a no-op instead.
 */
export function pagination(meta, onChange) {
  if (!meta || meta.total_pages <= 1) return document.createDocumentFragment();

  const from = (meta.page - 1) * meta.per_page + 1;
  const to = Math.min(meta.page * meta.per_page, meta.total);

  return el('nav', { class: 'pagination', 'aria-label': 'Pagination' }, [
    el('button', {
      type: 'button', class: 'btn btn-sm',
      disabled: meta.page <= 1,
      onClick: () => onChange(meta.page - 1),
    }, '← Previous'),
    el('span', { class: 'page-info' },
      `Showing ${from}–${to} of ${meta.total} (page ${meta.page} of ${meta.total_pages})`),
    el('button', {
      type: 'button', class: 'btn btn-sm',
      disabled: meta.page >= meta.total_pages,
      onClick: () => onChange(meta.page + 1),
    }, 'Next →'),
  ]);
}

/**
 * Debounce, for search-as-you-type. 350ms is long enough not to fire on every
 * keystroke and short enough not to feel laggy.
 */
export function debounce(fn, wait = 350) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Move focus to a heading after a view change, so screen readers follow. */
export function focusHeading(container) {
  const heading = container.querySelector('h1, h2');
  if (!heading) return;
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: false });
}
