/**
 * Web installer.
 *
 * A linear wizard whose state lives in one object. Answers are kept in memory
 * across steps so nothing is ever asked twice (WCAG 2.2 SC 3.3.7 Redundant
 * Entry) and going back never loses what was typed.
 *
 * Nothing touches the database until the final "Install" action.
 */

import { el, clear, field, toast, toastError, toastOk, announce, alert as alertBox, withBusy } from './ui.js';

const container = document.getElementById('step-container');
const indicator = document.getElementById('step-indicator');

const STEPS = ['welcome', 'database', 'organisation', 'periods', 'admin', 'done'];

const state = {
  step: 'welcome',
  environment: null,
  databaseVerified: false,
  answers: {
    db_host: 'localhost',
    db_port: 3306,
    db_user: '',
    db_password: '',
    db_name: '',
    org_name: '',
    org_contact_email: '',
    org_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    barcode_symbology: 'qr',
    barcode_prefix: 'LP',
    admin_name: '',
    admin_email: '',
    admin_password: '',
    admin_password_confirm: '',
    base_url: '',
    loan_periods: [
      { name: 'Short term', days: 7, is_default: false, max_extensions: 2, extension_days: 7 },
      { name: 'Standard', days: 30, is_default: true, max_extensions: 2, extension_days: 14 },
      { name: 'Extended', days: 90, is_default: false, max_extensions: 1, extension_days: 30 },
      { name: 'Open ended (no due date)', days: 0, is_default: false, max_extensions: 0, extension_days: 0 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function updateIndicator() {
  const currentIndex = STEPS.indexOf(state.step);
  for (const item of indicator.querySelectorAll('li')) {
    const index = STEPS.indexOf(item.dataset.step);
    item.classList.toggle('is-current', index === currentIndex);
    item.classList.toggle('is-done', index < currentIndex);
    // Only the current step gets aria-current, so the position is exposed
    // without turning the whole list into noise.
    if (index === currentIndex) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
}

function goTo(step) {
  state.step = step;
  updateIndicator();
  render();
}

function render() {
  clear(container);
  const renderer = {
    welcome: renderWelcome,
    database: renderDatabase,
    organisation: renderOrganisation,
    periods: renderPeriods,
    admin: renderAdmin,
    done: renderDone,
  }[state.step];

  container.append(renderer());

  // Move focus to the step heading so the change of context is announced.
  const heading = container.querySelector('h2');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }
}

function navButtons({ back = null, next = null, nextLabel = 'Continue', nextClass = 'btn-primary' }) {
  return el('div', { class: 'row', style: { marginTop: '22px', justifyContent: 'space-between' } }, [
    back
      ? el('button', { type: 'button', class: 'btn btn-ghost', onClick: back }, '← Back')
      : el('span'),
    next
      ? el('button', { type: 'submit', class: `btn ${nextClass}`, onClick: next }, nextLabel)
      : null,
  ]);
}

// ---------------------------------------------------------------------------
// Step: welcome
// ---------------------------------------------------------------------------

function renderWelcome() {
  const env = state.environment;

  return el('div', {}, [
    el('h2', { text: 'Before you start' }),
    el('p', {
      text:
        'This wizard creates the database tables and your first administrator account. ' +
        'You will need a MySQL or MariaDB database that already exists, and a user with full ' +
        'rights on it.',
    }),

    el('div', { class: 'card', style: { background: 'var(--surface-alt)', marginTop: '16px' } }, [
      el('h3', { text: 'You will need' }),
      el('ul', { style: { margin: '0', paddingLeft: '20px' } }, [
        el('li', { text: 'The database host, name, username and password.' }),
        el('li', {
          text:
            'An empty database created in advance. Some hosting control panels add your account ' +
            'name as a prefix — enter the full final name, exactly as the panel shows it.',
        }),
        el('li', { text: 'A name for your organisation and an email address for the first administrator.' }),
      ]),
    ]),

    env ? el('div', { style: { marginTop: '16px' } }, [
      el('h3', { text: 'This server' }),
      el('dl', { class: 'detail-list' }, [
        el('dt', { text: 'Node.js' }), el('dd', { class: 'mono', text: env.node_version }),
        el('dt', { text: 'Application' }), el('dd', { text: `Loaner Pool ${env.app_version}` }),
        el('dt', { text: 'Address' }), el('dd', { class: 'mono', text: env.detected_base_url }),
        el('dt', { text: 'Connection' }),
        el('dd', {}, env.is_https
          ? el('span', { class: 'pill pill-ok' }, 'Secure (HTTPS)')
          : el('span', { class: 'pill pill-warn' }, 'Not secure (HTTP)')),
        el('dt', { text: 'Config file' }), el('dd', { class: 'mono', text: env.config_path }),
      ]),
    ]) : null,

    env && !env.is_https
      ? alertBox(
          'This page was loaded over plain HTTP. You can finish setup, but enable HTTPS before ' +
          'entering real client information — sign-in cookies and phone camera scanning both ' +
          'depend on a secure connection.',
          { type: 'warn', title: 'No HTTPS yet' })
      : null,

    navButtons({ next: () => goTo('database') }),
  ]);
}

// ---------------------------------------------------------------------------
// Step: database
// ---------------------------------------------------------------------------

function renderDatabase() {
  const fields = {
    db_host: field({
      name: 'db_host', label: 'Database host', value: state.answers.db_host, required: true,
      help: 'Usually "localhost" on shared hosting.', autocomplete: 'off',
    }),
    db_port: field({
      name: 'db_port', label: 'Port', type: 'number', value: state.answers.db_port,
      required: true, min: 1, max: 65535,
    }),
    db_name: field({
      name: 'db_name', label: 'Database name', value: state.answers.db_name, required: true,
      help: 'The exact, final name — including any prefix your control panel added.',
      autocomplete: 'off',
    }),
    db_user: field({
      name: 'db_user', label: 'Database username', value: state.answers.db_user, required: true,
      autocomplete: 'off',
    }),
    db_password: field({
      name: 'db_password', label: 'Database password', type: 'password',
      value: state.answers.db_password,
      help: 'Leave blank only if this database genuinely has no password.',
      // "off" rather than "current-password": this is a server credential, not
      // the user's own login, and offering to save it in their browser
      // password manager would be wrong.
      autocomplete: 'off',
    }),
  };

  const resultBox = el('div', { id: 'db-test-result', style: { marginTop: '14px' } });

  const testButton = el('button', { type: 'button', class: 'btn' }, 'Test connection');
  const continueButton = el('button', {
    type: 'button',
    class: 'btn btn-primary',
    disabled: !state.databaseVerified,
    onClick: () => goTo('organisation'),
  }, 'Continue');

  testButton.addEventListener('click', async () => {
    captureDatabaseAnswers(fields);

    await withBusy(testButton, 'Testing…', async () => {
      clear(resultBox);
      try {
        const response = await fetch('/api/install/test-database', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.answers),
        });
        const payload = await response.json();

        resultBox.append(renderChecks(payload.checks));

        if (payload.ok) {
          state.databaseVerified = true;
          continueButton.disabled = false;
          resultBox.append(alertBox(
            `Connected successfully to ${state.answers.db_name}.`,
            { type: 'ok', title: 'Database is ready' },
          ));
          if (payload.warning) resultBox.append(alertBox(payload.warning, { type: 'warn' }));
          announce('Database connection succeeded. You can continue.', { assertive: true });
        } else {
          state.databaseVerified = false;
          continueButton.disabled = true;
          resultBox.append(alertBox(payload.error, { type: 'danger', title: 'Could not connect' }));
          announce(`Database connection failed. ${payload.error}`, { assertive: true });
        }
      } catch (err) {
        state.databaseVerified = false;
        continueButton.disabled = true;
        resultBox.append(alertBox(
          `The installer could not reach the server: ${err.message}`,
          { type: 'danger', title: 'Request failed' },
        ));
      }
    });
  });

  // Editing any field invalidates a previous successful test.
  for (const f of Object.values(fields)) {
    f.control.addEventListener('input', () => {
      if (!state.databaseVerified) return;
      state.databaseVerified = false;
      continueButton.disabled = true;
      clear(resultBox);
    });
  }

  const form = el('form', { novalidate: true, onSubmit: (event) => event.preventDefault() }, [
    el('h2', { text: 'Connect to your database' }),
    el('p', {
      class: 'muted',
      text: 'These details are stored in a configuration file on the server, not in the database itself.',
    }),
    el('div', { class: 'form-grid' }, [fields.db_host, fields.db_port]),
    fields.db_name,
    el('div', { class: 'form-grid' }, [fields.db_user, fields.db_password]),
    el('div', { class: 'row' }, [testButton]),
    resultBox,
    el('div', { class: 'row', style: { marginTop: '22px', justifyContent: 'space-between' } }, [
      el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => goTo('welcome') }, '← Back'),
      continueButton,
    ]),
  ]);

  return form;
}

function captureDatabaseAnswers(fields) {
  state.answers.db_host = fields.db_host.control.value.trim();
  state.answers.db_port = Number(fields.db_port.control.value) || 3306;
  state.answers.db_name = fields.db_name.control.value.trim();
  state.answers.db_user = fields.db_user.control.value.trim();
  state.answers.db_password = fields.db_password.control.value;
}

function renderChecks(checks) {
  if (!checks) return el('span');

  const rows = [
    ['Server reachable', checks.reachable],
    ['Username and password accepted', checks.authenticated],
    ['Database exists', checks.database_exists],
    ['Can create tables', checks.can_create_tables],
  ];

  return el('ul', { class: 'check-list' }, rows.map(([label, passed]) =>
    el('li', { class: passed ? 'is-pass' : 'is-fail' }, [
      el('span', { class: 'check-mark', 'aria-hidden': 'true', text: passed ? '✓' : '✕' }),
      el('span', {}, [
        label,
        // The icon is decorative; the state is also given as text.
        el('span', { class: 'visually-hidden', text: passed ? ' — passed' : ' — failed' }),
      ]),
    ])));
}

// ---------------------------------------------------------------------------
// Step: organisation
// ---------------------------------------------------------------------------

function renderOrganisation() {
  const fields = {
    org_name: field({
      name: 'org_name', label: 'Organisation name', value: state.answers.org_name, required: true,
      help: 'Appears in the header and on printed labels.', autocomplete: 'organization',
    }),
    org_contact_email: field({
      name: 'org_contact_email', label: 'Contact email address', type: 'email',
      value: state.answers.org_contact_email,
      help: 'Optional. Shown to counselors who need to reach the loaner pool team.',
      autocomplete: 'email',
    }),
    org_timezone: field({
      name: 'org_timezone', label: 'Time zone', value: state.answers.org_timezone,
      help: 'Used for due dates. Detected from this browser — change it if the pool runs elsewhere.',
    }),
    barcode_symbology: field({
      name: 'barcode_symbology', label: 'Barcode type', type: 'select',
      value: state.answers.barcode_symbology,
      options: [
        { value: 'qr', label: 'QR code — phone cameras and 2D imagers' },
        { value: 'code128', label: 'Code 128 — works with every laser scanner' },
        { value: 'code39', label: 'Code 39 — for older scanning hardware' },
      ],
      help: 'You can change this later, but existing printed labels would need reprinting.',
    }),
    barcode_prefix: field({
      name: 'barcode_prefix', label: 'Barcode prefix', value: state.answers.barcode_prefix,
      required: true,
      help: 'Up to 8 letters or digits at the start of every barcode, e.g. "LP" gives LP-7K3F9Q2M.',
    }),
  };

  const symbologyNote = el('div', { id: 'symbology-note' });

  const updateNote = () => {
    clear(symbologyNote);
    if (fields.barcode_symbology.control.value === 'qr') {
      symbologyNote.append(alertBox(
        'QR codes are read by phone cameras and 2D imaging scanners, but NOT by cheap 1D laser ' +
        'scanners. If your team uses laser wedge scanners, choose Code 128 instead.',
        { type: 'warn', title: 'Check your scanners' },
      ));
    }
  };
  fields.barcode_symbology.control.addEventListener('change', updateNote);
  updateNote();

  const proceed = (event) => {
    event.preventDefault();
    for (const f of Object.values(fields)) f.setError(null);

    const name = fields.org_name.control.value.trim();
    if (!name) {
      fields.org_name.setError('Enter the name of your organisation.');
      fields.org_name.control.focus();
      return;
    }
    const prefix = fields.barcode_prefix.control.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!prefix) {
      fields.barcode_prefix.setError('The prefix must contain at least one letter or digit.');
      fields.barcode_prefix.control.focus();
      return;
    }

    state.answers.org_name = name;
    state.answers.org_contact_email = fields.org_contact_email.control.value.trim();
    state.answers.org_timezone = fields.org_timezone.control.value.trim() || 'UTC';
    state.answers.barcode_symbology = fields.barcode_symbology.control.value;
    state.answers.barcode_prefix = prefix;

    goTo('periods');
  };

  return el('form', { novalidate: true, onSubmit: proceed }, [
    el('h2', { text: 'About your organisation' }),
    fields.org_name,
    el('div', { class: 'form-grid' }, [fields.org_contact_email, fields.org_timezone]),
    el('div', { class: 'form-grid' }, [fields.barcode_symbology, fields.barcode_prefix]),
    symbologyNote,
    navButtons({ back: () => goTo('database'), next: proceed }),
  ]);
}

// ---------------------------------------------------------------------------
// Step: loan periods
// ---------------------------------------------------------------------------

function renderPeriods() {
  const list = el('div', { id: 'period-list', class: 'stack' });

  /**
   * Rows are re-rendered wholesale on change. Ordering uses a number input
   * rather than drag handles, so there is no drag-only interaction
   * (WCAG 2.2 SC 2.5.7 Dragging Movements).
   */
  const renderRows = () => {
    clear(list);

    state.answers.loan_periods.forEach((period, index) => {
      const nameInput = el('input', {
        type: 'text', value: period.name, 'aria-label': `Name of loan period ${index + 1}`,
        onInput: (event) => { period.name = event.target.value; },
      });
      const daysInput = el('input', {
        type: 'number', min: 0, max: 3650, value: period.days,
        'aria-label': `Length in days of loan period ${index + 1}. Enter 0 for no due date.`,
        onInput: (event) => { period.days = Number(event.target.value) || 0; },
      });
      const extensionsInput = el('input', {
        type: 'number', min: 0, max: 50, value: period.max_extensions,
        'aria-label': `Maximum extensions for loan period ${index + 1}`,
        onInput: (event) => { period.max_extensions = Number(event.target.value) || 0; },
      });
      const defaultRadio = el('input', {
        type: 'radio', name: 'default_period', checked: period.is_default,
        'aria-label': `Make loan period ${index + 1} the default`,
        onChange: () => {
          state.answers.loan_periods.forEach((p, i) => { p.is_default = i === index; });
        },
      });

      list.append(el('fieldset', {}, [
        el('legend', {}, `Period ${index + 1}${period.days === 0 ? ' (open ended)' : ''}`),
        el('div', { class: 'form-grid' }, [
          el('div', { class: 'field' }, [el('span', { class: 'label' }, 'Name'), nameInput]),
          el('div', { class: 'field' }, [
            el('span', { class: 'label' }, 'Days'),
            daysInput,
            el('p', { class: 'field-help', text: '0 means no return date.' }),
          ]),
          el('div', { class: 'field' }, [el('span', { class: 'label' }, 'Max extensions'), extensionsInput]),
        ]),
        el('div', { class: 'row' }, [
          el('label', { class: 'checkbox', style: { marginBottom: '0' } }, [
            defaultRadio, el('span', {}, 'Use this by default at check-out'),
          ]),
          el('button', {
            type: 'button', class: 'btn btn-sm btn-ghost',
            disabled: state.answers.loan_periods.length <= 1,
            onClick: () => {
              const wasDefault = period.is_default;
              state.answers.loan_periods.splice(index, 1);
              if (wasDefault && state.answers.loan_periods.length) {
                state.answers.loan_periods[0].is_default = true;
              }
              renderRows();
              announce(`Removed loan period ${index + 1}.`);
            },
          }, 'Remove'),
        ]),
      ]));
    });
  };

  renderRows();

  const proceed = (event) => {
    event.preventDefault();

    const named = state.answers.loan_periods.filter((p) => p.name.trim());
    if (!named.length) {
      toastError('Add at least one loan period with a name.');
      return;
    }
    state.answers.loan_periods = named;
    if (!named.some((p) => p.is_default)) named[0].is_default = true;

    goTo('admin');
  };

  return el('form', { novalidate: true, onSubmit: proceed }, [
    el('h2', { text: 'How long do loans run for?' }),
    el('p', {
      class: 'muted',
      text:
        'These are the durations offered at check-out. Every one of them can be edited later, and a ' +
        'technician can always set a custom length for an individual loan.',
    }),
    list,
    el('button', {
      type: 'button', class: 'btn btn-sm',
      onClick: () => {
        state.answers.loan_periods.push({
          name: '', days: 14, is_default: false, max_extensions: 2, extension_days: 14,
        });
        renderPeriodsInPlace();
      },
    }, '+ Add another period'),
    navButtons({ back: () => goTo('organisation'), next: proceed }),
  ]);
}

/** Re-render the periods step, keeping focus sensible after adding a row. */
function renderPeriodsInPlace() {
  render();
  const inputs = container.querySelectorAll('#period-list input[type="text"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

// ---------------------------------------------------------------------------
// Step: administrator
// ---------------------------------------------------------------------------

function renderAdmin() {
  const fields = {
    admin_name: field({
      name: 'admin_name', label: 'Your full name', value: state.answers.admin_name,
      required: true, autocomplete: 'name',
    }),
    admin_email: field({
      name: 'admin_email', label: 'Your email address', type: 'email',
      value: state.answers.admin_email, required: true,
      help: 'This is the username you will sign in with.',
      autocomplete: 'username',
    }),
    admin_password: field({
      name: 'admin_password', label: 'Password', type: 'password',
      required: true,
      help: 'At least 12 characters, with at least one number or symbol.',
      // SC 3.3.8: correct tokens so a password manager can generate and store
      // this. Paste is never blocked anywhere in this application.
      autocomplete: 'new-password',
    }),
    admin_password_confirm: field({
      name: 'admin_password_confirm', label: 'Confirm password', type: 'password',
      required: true, autocomplete: 'new-password',
    }),
  };

  const strength = el('p', { class: 'field-help', id: 'password-strength', role: 'status' });
  fields.admin_password.control.setAttribute('aria-describedby',
    `${fields.admin_password.control.getAttribute('aria-describedby')} password-strength`);

  fields.admin_password.control.addEventListener('input', (event) => {
    const value = event.target.value;
    if (!value) { strength.textContent = ''; return; }

    const problems = [];
    if (value.length < 12) problems.push(`${12 - value.length} more character(s) needed`);
    if (!/[a-zA-Z]/.test(value)) problems.push('add a letter');
    if (!/[^a-zA-Z]/.test(value)) problems.push('add a number or symbol');

    strength.textContent = problems.length
      ? `Not yet valid: ${problems.join(', ')}.`
      : 'This password meets the requirements.';
  });

  const installButton = el('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, 'Install now');
  const errorBox = el('div', { style: { marginTop: '14px' } });

  const submit = async (event) => {
    event.preventDefault();
    clear(errorBox);
    for (const f of Object.values(fields)) f.setError(null);

    state.answers.admin_name = fields.admin_name.control.value.trim();
    state.answers.admin_email = fields.admin_email.control.value.trim();
    state.answers.admin_password = fields.admin_password.control.value;
    state.answers.admin_password_confirm = fields.admin_password_confirm.control.value;
    state.answers.base_url = state.environment?.detected_base_url || '';

    if (state.answers.admin_password !== state.answers.admin_password_confirm) {
      fields.admin_password_confirm.setError('The two passwords do not match.');
      fields.admin_password_confirm.control.focus();
      return;
    }

    await withBusy(installButton, 'Installing…', async () => {
      try {
        const response = await fetch('/api/install/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.answers),
        });
        const payload = await response.json();

        if (!response.ok) {
          const message = payload?.error?.message || 'Installation failed.';
          const fieldName = payload?.error?.details?.field;

          if (fieldName && fields[fieldName]) {
            fields[fieldName].setError(message);
            fields[fieldName].control.focus();
          } else {
            errorBox.append(alertBox(message, { type: 'danger', title: 'Installation failed' }));
          }
          announce(`Installation failed. ${message}`, { assertive: true });
          return;
        }

        state.result = payload;
        goTo('done');
      } catch (err) {
        errorBox.append(alertBox(
          `Could not reach the server: ${err.message}`,
          { type: 'danger', title: 'Request failed' },
        ));
      }
    });
  };

  return el('form', { novalidate: true, onSubmit: submit }, [
    el('h2', { text: 'Create your administrator account' }),
    el('p', {
      class: 'muted',
      text: 'This account can do everything, including adding other staff and changing settings.',
    }),
    fields.admin_name,
    fields.admin_email,
    el('div', { class: 'form-grid' }, [fields.admin_password, fields.admin_password_confirm]),
    strength,
    errorBox,
    el('div', { class: 'row', style: { marginTop: '22px', justifyContent: 'space-between' } }, [
      el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => goTo('periods') }, '← Back'),
      installButton,
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Step: done
// ---------------------------------------------------------------------------

function renderDone() {
  const result = state.result || {};

  return el('div', {}, [
    el('h2', { text: 'Loaner Pool is ready' }),
    alertBox(
      `Your installation is set up and the administrator account ${result.admin_email || ''} has been created.`,
      { type: 'ok', title: 'Installation complete' },
    ),

    result.warning ? alertBox(result.warning, { type: 'warn', title: 'One thing to fix' }) : null,

    el('h3', { text: 'What happened' }),
    el('ul', {}, (result.log || []).map((line) => el('li', { text: line }))),

    el('h3', { text: 'Next steps' }),
    el('ol', {}, [
      el('li', { text: 'Sign in with the administrator account you just created.' }),
      el('li', { text: 'Import your device inventory from a spreadsheet, and print barcode labels.' }),
      el('li', { text: 'Add your technicians and counselors under Staff.' }),
      el('li', { text: 'Optionally, configure Microsoft Graph under Settings so the system can send email.' }),
    ]),

    el('div', {
      class: 'card',
      style: { background: 'var(--warn-bg)', borderColor: 'var(--warn-border)', marginTop: '16px' },
    }, [
      el('h3', { text: 'Keep this file safe' }),
      el('p', {
        text:
          'Your database credentials and encryption key are stored at the path below. ' +
          'Back it up, and do not let it become publicly readable — anyone who can read it can ' +
          'read your database.',
      }),
      el('p', { class: 'mono', text: result.config_path || '' }),
    ]),

    el('div', { class: 'row', style: { marginTop: '22px' } }, [
      el('a', { class: 'btn btn-primary btn-lg', href: '/' }, 'Go to sign in →'),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const response = await fetch('/api/install/state');

    if (response.status === 410) {
      clear(container).append(
        el('h2', { text: 'Already installed' }),
        alertBox(
          'This Loaner Pool has already been set up, so the installer is closed. ' +
          'To reinstall, an administrator must remove the configuration file on the server.',
          { type: 'info' },
        ),
        el('a', { class: 'btn btn-primary', href: '/' }, 'Go to the application →'),
      );
      return;
    }

    state.environment = await response.json();
    updateIndicator();
    render();
  } catch (err) {
    clear(container).append(alertBox(
      `Could not read this server's setup state: ${err.message}`,
      { type: 'danger', title: 'Cannot start the installer' },
    ));
  }
}

boot();
