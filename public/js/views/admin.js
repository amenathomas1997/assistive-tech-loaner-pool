/**
 * Administration: organisation profile, notification settings (including the
 * Microsoft Graph mail configuration), loan periods and API keys.
 */

import { api } from '../api.js';
import {
  el, clear, mount, field, dataTable, dateCell, modal, toastOk, toastError, toastWarn,
  announce, loadingBlock, alert as alertBox, confirmDialog, withBusy, formatDate,
} from '../ui.js';
import { can, session } from '../app.js';

// ===========================================================================
// Settings
// ===========================================================================

export async function renderSettings() {
  const [settingsResponse, orgResponse] = await Promise.all([api.settings(), api.organization()]);
  const settings = settingsResponse.settings;
  const org = orgResponse.organization;
  const readOnly = !can('settings.write');

  const container = el('div');

  // --- Organisation --------------------------------------------------------

  const orgFields = {
    name: field({ name: 'name', label: 'Organisation name', value: org.name, required: true, disabled: readOnly }),
    contact_email: field({ name: 'contact_email', label: 'Contact email', type: 'email', value: org.contact_email || '', disabled: readOnly }),
    timezone: field({ name: 'timezone', label: 'Time zone', value: org.timezone, disabled: readOnly }),
    barcode_symbology: field({
      name: 'barcode_symbology', label: 'Barcode type', type: 'select', value: org.barcode_symbology,
      disabled: readOnly,
      options: [
        { value: 'qr', label: 'QR code — phone cameras and 2D imagers' },
        { value: 'code128', label: 'Code 128 — works with every laser scanner' },
        { value: 'code39', label: 'Code 39 — older scanning hardware' },
      ],
      help: 'Changing this does not change any barcode value, but existing labels would need reprinting.',
    }),
    barcode_prefix: field({
      name: 'barcode_prefix', label: 'Barcode prefix', value: org.barcode_prefix, disabled: readOnly,
      help: 'Applies to barcodes generated from now on. Existing barcodes are unchanged.',
    }),
  };

  const orgButton = el('button', { type: 'submit', class: 'btn btn-primary', disabled: readOnly }, 'Save organisation');

  const orgForm = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      await withBusy(orgButton, 'Saving…', async () => {
        const body = {};
        for (const [key, f] of Object.entries(orgFields)) {
          const value = f.control.value.trim?.() ?? f.control.value;
          body[key] = value === '' ? null : value;
        }
        try {
          const result = await api.updateOrganization(body);
          toastOk('Organisation settings saved.');
          if (result.notice) toastWarn(result.notice, 'Reprint your labels');
          session.organization = result.organization;
        } catch (err) {
          if (err.field && orgFields[err.field]) {
            orgFields[err.field].setError(err.message);
            orgFields[err.field].control.focus();
          } else { toastError(err.message); }
        }
      });
    },
  }, [
    el('div', { class: 'form-grid' }, [orgFields.name, orgFields.contact_email]),
    orgFields.timezone,
    el('div', { class: 'form-grid' }, [orgFields.barcode_symbology, orgFields.barcode_prefix]),
    orgButton,
  ]);

  // --- Microsoft Graph -----------------------------------------------------

  const graphFields = {
    'graph.tenant_id': field({
      name: 'graph.tenant_id', label: 'Directory (tenant) ID', value: settings['graph.tenant_id'] || '',
      disabled: readOnly, autocomplete: 'off',
      help: 'From the app registration Overview page in the Azure portal.',
    }),
    'graph.client_id': field({
      name: 'graph.client_id', label: 'Application (client) ID', value: settings['graph.client_id'] || '',
      disabled: readOnly, autocomplete: 'off',
    }),
    'graph.client_secret': field({
      name: 'graph.client_secret', label: 'Client secret', type: 'password',
      disabled: readOnly, autocomplete: 'off',
      placeholder: settings['graph.client_secret__is_set'] ? 'Stored — leave blank to keep it' : '',
      help: settings['graph.client_secret__is_set']
        ? `A secret is stored (${settings['graph.client_secret__hint']}). Leave this blank to keep it, or paste a new one to replace it.`
        : 'The secret VALUE from Azure, not the secret ID. It is shown only once when you create it.',
    }),
    'graph.sender': field({
      name: 'graph.sender', label: 'Send from this mailbox', type: 'email',
      value: settings['graph.sender'] || '', disabled: readOnly,
      help: 'A real, licensed mailbox in your tenant. Notifications appear to come from here.',
    }),
    'graph.reply_to': field({
      name: 'graph.reply_to', label: 'Reply-to address', type: 'email',
      value: settings['graph.reply_to'] || '', disabled: readOnly,
      help: 'Optional. Where replies should go if it differs from the sending mailbox.',
    }),
  };

  const graphEnabled = el('input', {
    type: 'checkbox', id: 'graph-enabled',
    checked: Boolean(settings['graph.enabled']), disabled: readOnly,
  });

  const statusBox = el('div');
  const renderStatus = (status) => {
    clear(statusBox);

    // Defensive: this is fed straight from a server response, and a missing
    // field should degrade to "we cannot tell" rather than throwing and
    // leaving the administrator looking at a half-rendered settings page.
    if (!status) {
      statusBox.append(alertBox(
        'Saved, but the server did not report whether email is working. Reload the page to check.',
        { type: 'warn', title: 'Status unknown' },
      ));
      return;
    }

    if (status.usable) {
      statusBox.append(alertBox(
        `Email is configured and switched on, sending from ${status.sender}.`,
        { type: 'ok', title: 'Ready' },
      ));
    } else {
      statusBox.append(alertBox(
        status.reason || 'Email is not configured.',
        { type: 'warn', title: 'Email is not sending' },
      ));
    }
  };
  renderStatus(settingsResponse.mail_status);

  const testButton = el('button', { type: 'button', class: 'btn', disabled: readOnly }, 'Send a test email');
  testButton.addEventListener('click', async () => {
    const recipientField = field({
      name: 'recipient', label: 'Send the test to', type: 'email', required: true,
      value: session.user?.email || '', autocomplete: 'email',
    });

    await modal({
      title: 'Send a test email',
      body: el('div', {}, [
        el('p', {
          text:
            'This sends immediately using the saved configuration, even if notifications are ' +
            'switched off — so you can check it works before turning them on.',
        }),
        recipientField,
      ]),
      actions: [
        { label: 'Cancel', class: 'btn-ghost', value: null },
        {
          label: 'Send test',
          class: 'btn-primary',
          onClick: async (close) => {
            try {
              const result = await api.testEmail(recipientField.control.value.trim());
              toastOk(
                result.sender
                  ? `Test sent from ${result.sender} to ${result.recipient}. Check the inbox.`
                  : 'Test message sent. Check the inbox.',
              );
              if (result.mail_status) renderStatus(result.mail_status);
              close(true);
            } catch (err) {
              recipientField.setError(err.message);
              recipientField.control.focus();
            }
          },
        },
      ],
    });
  });

  const graphButton = el('button', { type: 'submit', class: 'btn btn-primary', disabled: readOnly }, 'Save email settings');

  const graphForm = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      await withBusy(graphButton, 'Saving…', async () => {
        const updates = { 'graph.enabled': graphEnabled.checked };
        for (const [key, f] of Object.entries(graphFields)) {
          const value = f.control.value.trim?.() ?? f.control.value;
          // A blank secret means "leave it alone" — the server honours this,
          // so a save from a masked form never wipes the stored credential.
          if (key === 'graph.client_secret' && value === '') continue;
          updates[key] = value;
        }

        try {
          const result = await api.updateSettings(updates);
          toastOk('Email settings saved.');
          renderStatus(result.mail_status);
          graphFields['graph.client_secret'].control.value = '';
        } catch (err) {
          toastError(err.message);
        }
      });
    },
  }, [
    el('label', { class: 'checkbox', for: 'graph-enabled' }, [
      graphEnabled,
      el('span', {}, [
        'Send email notifications',
        el('span', { class: 'option-help' }, 'When off, nothing is sent but everything else keeps working.'),
      ]),
    ]),
    el('div', { class: 'form-grid' }, [graphFields['graph.tenant_id'], graphFields['graph.client_id']]),
    graphFields['graph.client_secret'],
    el('div', { class: 'form-grid' }, [graphFields['graph.sender'], graphFields['graph.reply_to']]),
    el('div', { class: 'btn-group' }, [graphButton, testButton]),
  ]);

  // --- Notification toggles ------------------------------------------------

  const NOTIFY = [
    ['notify.request_submitted', 'A counselor submits a request', 'Goes to the technician team.'],
    ['notify.request_approved', 'A request is approved', 'Goes to the counselor who asked.'],
    ['notify.request_denied', 'A request is declined', 'Goes to the counselor, with the reason.'],
    ['notify.ready_for_pickup', 'Equipment is ready to collect', 'Goes to the counselor.'],
    ['notify.reservation_ready', 'A waitlisted device becomes free', 'Goes to whoever asked to be told.'],
    ['notify.checked_out', 'A device is checked out', 'Goes to the client and technician.'],
    ['notify.due_soon', 'A loan is due back soon', 'Goes to whoever holds the device.'],
    ['notify.overdue', 'A loan is overdue', 'Goes to whoever holds the device.'],
    ['notify.checked_in', 'A device is returned', 'Off by default — usually just noise.'],
  ];

  const notifyBoxes = {};
  const dueSoonDays = field({
    name: 'notify.due_soon_days', label: 'Send the reminder this many days before it is due',
    type: 'number', min: 1, max: 60, value: settings['notify.due_soon_days'], disabled: readOnly,
  });
  const adminRecipients = field({
    name: 'notify.admin_recipients', label: 'Team email addresses',
    value: settings['notify.admin_recipients'] || '', disabled: readOnly,
    help: 'Comma separated. These receive new-request notifications.',
  });

  const notifyButton = el('button', { type: 'submit', class: 'btn btn-primary', disabled: readOnly }, 'Save notifications');

  const notifyForm = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      await withBusy(notifyButton, 'Saving…', async () => {
        const updates = {
          'notify.due_soon_days': Number(dueSoonDays.control.value),
          'notify.admin_recipients': adminRecipients.control.value.trim(),
        };
        for (const [key, box] of Object.entries(notifyBoxes)) updates[key] = box.checked;

        try {
          await api.updateSettings(updates);
          toastOk('Notification settings saved.');
        } catch (err) { toastError(err.message); }
      });
    },
  }, [
    ...NOTIFY.map(([key, label, help]) => {
      const box = el('input', { type: 'checkbox', id: `n-${key}`, checked: Boolean(settings[key]), disabled: readOnly });
      notifyBoxes[key] = box;
      return el('label', { class: 'checkbox', for: `n-${key}` }, [
        box, el('span', {}, [label, el('span', { class: 'option-help' }, help)]),
      ]);
    }),
    el('hr', { class: 'divider' }),
    el('div', { class: 'form-grid' }, [dueSoonDays, adminRecipients]),
    notifyButton,
  ]);

  // --- Loan policy ---------------------------------------------------------

  const policyBoxes = {};
  const POLICY = [
    ['loans.require_client_or_tech', 'A loan must name a client, technician or program',
     'Stops equipment going out with no named person responsible.'],
    ['loans.allow_overdue_checkout', 'Allow check-out to a client who already has something overdue',
     'Off by default. Turn on if blocking would get in the way of service.'],
    ['loans.auto_approve_vrc', 'Approve counselor requests automatically',
     'Skips technician review. Only sensible for small, high-trust teams.'],
  ];

  const maxPerClient = field({
    name: 'loans.max_per_client', label: 'Maximum devices on loan per client at once',
    type: 'number', min: 0, max: 100, value: settings['loans.max_per_client'], disabled: readOnly,
    help: '0 means no limit.',
  });

  const remoteScan = el('input', {
    type: 'checkbox', id: 'scan-remote', checked: Boolean(settings['scan.remote_enabled']), disabled: readOnly,
  });

  const offlineScan = el('input', {
    type: 'checkbox', id: 'scan-offline', checked: Boolean(settings['scan.offline_enabled']), disabled: readOnly,
  });

  const labelStock = field({
    name: 'labels.stock', label: 'Label sheets in the printer', type: 'select',
    value: settings['labels.stock'], disabled: readOnly,
    options: (settingsResponse.label_stocks || []).map((s) => ({ value: s.value, label: s.label })),
    help: 'What "Print labels" lays out for. A different sheet can still be chosen on the label page itself.',
  });

  const policyButton = el('button', { type: 'submit', class: 'btn btn-primary', disabled: readOnly }, 'Save policy');

  const policyForm = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      await withBusy(policyButton, 'Saving…', async () => {
        const updates = {
          'loans.max_per_client': Number(maxPerClient.control.value),
          'scan.remote_enabled': remoteScan.checked,
          'scan.offline_enabled': offlineScan.checked,
          'labels.stock': labelStock.control.value,
        };
        for (const [key, box] of Object.entries(policyBoxes)) updates[key] = box.checked;

        try {
          await api.updateSettings(updates);
          toastOk('Loan policy saved.');
        } catch (err) { toastError(err.message); }
      });
    },
  }, [
    ...POLICY.map(([key, label, help]) => {
      const box = el('input', { type: 'checkbox', id: `p-${key}`, checked: Boolean(settings[key]), disabled: readOnly });
      policyBoxes[key] = box;
      return el('label', { class: 'checkbox', for: `p-${key}` }, [
        box, el('span', {}, [label, el('span', { class: 'option-help' }, help)]),
      ]);
    }),
    maxPerClient,
    el('hr', { class: 'divider' }),
    el('label', { class: 'checkbox', for: 'scan-remote' }, [
      remoteScan,
      el('span', {}, [
        'Allow pairing a phone as a remote scanner',
        el('span', { class: 'option-help' }, 'Lets a signed-in phone send scans to a desktop scan station.'),
      ]),
    ]),
    el('label', { class: 'checkbox', for: 'scan-offline' }, [
      offlineScan,
      el('span', {}, [
        'Keep check-ins when the connection drops',
        el('span', { class: 'option-help' },
          'Returns scanned while offline are held on that computer and sent when it reconnects. '
          + 'Check-outs are never held.'),
      ]),
    ]),
    labelStock,
    policyButton,
  ]);

  mount(container,
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Settings' }),
        el('p', { text: 'How this installation behaves.' }),
      ]),
      el('div', { class: 'btn-group' }, [
        can('settings.write') ? el('a', { class: 'btn', href: '#/settings/periods' }, 'Loan periods') : null,
        can('apikeys.read') ? el('a', { class: 'btn', href: '#/settings/api' }, 'API keys') : null,
      ]),
    ]),

    readOnly ? alertBox('You can view these settings but not change them.', { type: 'info' }) : null,

    el('section', { class: 'card', 'aria-labelledby': 'org-heading' }, [
      el('h2', { id: 'org-heading', text: 'Organisation' }), orgForm,
    ]),

    el('section', { class: 'card', 'aria-labelledby': 'graph-heading' }, [
      el('h2', { id: 'graph-heading', text: 'Email (Microsoft Graph)' }),
      el('p', {
        class: 'muted',
        text:
          'Loaner Pool sends email through Microsoft Graph using an Azure app registration. ' +
          'You need the Mail.Send application permission with admin consent granted — delegated ' +
          'permissions will not work for unattended sending.',
      }),
      statusBox,
      graphForm,
    ]),

    ssoCard(settings, settingsResponse.sso_status, readOnly),

    el('section', { class: 'card', 'aria-labelledby': 'notify-heading' }, [
      el('h2', { id: 'notify-heading', text: 'What triggers an email' }), notifyForm,
    ]),

    el('section', { class: 'card', 'aria-labelledby': 'policy-heading' }, [
      el('h2', { id: 'policy-heading', text: 'Loan policy' }), policyForm,
    ]),

    agreementsSection(settings, readOnly),
    photosSection(settings, readOnly),
    outcomesSection(settings, readOnly),
    hygieneSection(settings, readOnly),
    smsSection(settings, readOnly),
    waitlistSection(settings, readOnly),
    schedulerSection(readOnly),
    backupSection(readOnly),
    retentionSection(settings, readOnly),
    twoFactorSection(settings, readOnly),
    updatesSection(readOnly),
  );

  return container;
}

// --- Backups ---------------------------------------------------------------

/**
 * Download a copy of the database.
 *
 * Deliberately prominent and deliberately nagging. The updater backs up the
 * files; nobody backs up the data until the first time they wish they had.
 */
function backupSection(readOnly) {
  const body = el('div', {}, el('p', { class: 'muted', text: 'Checking…' }));

  const render = (summary) => {
    clear(body).append(
      summary.notice
        ? alertBox(summary.notice, { type: 'warn', title: 'Worth doing now' })
        : (summary.last_backup
            ? alertBox(
                `Last downloaded ${formatDate(summary.last_backup.at, { withTime: true })} by `
                + `${summary.last_backup.by}.`,
                { type: 'ok', title: 'Backed up' })
            : null),

      el('dl', { class: 'detail-list' }, [
        el('dt', { text: 'Size' }),
        el('dd', { text: `About ${summary.approximate_size} across ${summary.table_count} tables` }),
      ]),

      alertBox(summary.warning, { type: 'info', title: 'Handle the file carefully' }),

      el('button', {
        type: 'button', class: 'btn btn-primary', disabled: readOnly,
        onClick: () => downloadBackup(),
      }, 'Download a backup'),
    );
  };

  api.backupSummary().then(render).catch((err) => {
    clear(body).append(alertBox(err.message, { type: 'danger' }));
  });

  return el('section', { class: 'card', 'aria-labelledby': 'backup-heading' }, [
    el('h2', { id: 'backup-heading', text: 'Database backup' }),
    el('p', {
      class: 'muted',
      text: 'A single SQL file holding everything: devices, loans, clients and their history. It '
          + 'restores through phpMyAdmin or the mysql command, so recovering does not depend on '
          + 'this application working.',
    }),
    body,
  ]);
}

/**
 * The download itself.
 *
 * A form POST rather than fetch: the response is a file, and letting the
 * browser handle it means no copy of the entire database is held in memory
 * in a tab.
 */
async function downloadBackup() {
  const passwordField = field({
    name: 'password', label: 'Your password', type: 'password', required: true,
    autocomplete: 'current-password',
    help: 'A backup is a copy of every client record and every password hash, so it asks again.',
  });

  await modal({
    title: 'Download a backup',
    body: el('div', {}, [
      el('p', { text: 'The download may take a moment on a large pool.' }),
      passwordField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Download',
        class: 'btn-primary',
        onClick: (close) => {
          const password = passwordField.control.value;

          if (!password) {
            passwordField.setError('Enter your password.');
            passwordField.control.focus();
            return;
          }

          const form = el('form', {
            method: 'POST',
            action: '/api/v1/admin/backup',
            style: { display: 'none' },
          }, el('input', { type: 'hidden', name: 'password', value: password }));

          document.body.append(form);
          form.submit();
          form.remove();

          toastOk('The backup is downloading. Store it somewhere safe.');
          close(true);
        },
      },
    ],
  });
}

// --- Retention -------------------------------------------------------------

function retentionSection(settings, readOnly) {
  const preview = el('div', {});

  api.retentionPreview().then((result) => {
    mount(
      clear(preview),
      alertBox(result.notice, { type: result.clients.count > 0 ? 'warn' : 'info', title: 'If run now' }),
      el('details', {}, [
        el('summary', { text: 'What this policy does, and does not, touch' }),
        el('ul', {}, result.policy.describes.map((line) => el('li', { text: line }))),
        el('p', { class: 'label', text: 'Never affected' }),
        el('ul', {}, result.policy.never_touched.map((line) => el('li', { text: line }))),
      ]),
      result.policy.enabled && !readOnly
        ? el('button', {
            type: 'button', class: 'btn', style: { marginTop: '10px' },
            onClick: () => runPurge(),
          }, 'Apply the policy now')
        : null,
    );
  }).catch((err) => {
    clear(preview).append(alertBox(err.message, { type: 'danger' }));
  });

  return settingsPanel({
    id: 'retention', title: 'Data retention', settings, readOnly,
    blurb:
      'Client records here carry information about people\u2019s disabilities. Keeping them forever '
      + 'is a liability rather than an asset. Clients are anonymised rather than deleted, because '
      + 'their loans reference them and destroying the row would rewrite the record of who held what.',
    extra: preview,
    fields: [
      {
        key: 'retention.enabled', type: 'boolean',
        label: 'Apply a retention policy',
        help: 'Off by default. Nothing is ever removed until you switch this on and run it.',
      },
      {
        key: 'retention.client_years', type: 'integer', min: 0,
        label: 'Anonymise clients after this many years without activity',
        help: 'Leave blank or 0 to keep them.',
      },
      { key: 'retention.audit_years', type: 'integer', min: 0,
        label: 'Delete audit entries after this many years',
        help: 'Leave blank or 0 to keep them.' },
      { key: 'retention.email_log_days', type: 'integer', min: 0,
        label: 'Delete email and text records after this many days',
        help: 'Leave blank or 0 to keep them.' },
    ],
  });
}

async function runPurge() {
  const passwordField = field({
    name: 'password', label: 'Your password', type: 'password', required: true,
    autocomplete: 'current-password',
  });

  await modal({
    title: 'Apply the retention policy',
    body: el('div', {}, [
      alertBox(
        'This permanently removes personal data. It cannot be undone, and a backup taken afterwards '
        + 'will not contain it either.',
        { type: 'warn', title: 'There is no undo' },
      ),
      passwordField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Apply it',
        class: 'btn-danger',
        onClick: async (close) => {
          try {
            const result = await api.purgeRetention(passwordField.control.value);
            toastOk(result.summary);
            announce(result.summary, { assertive: true });
            close(true);
          } catch (err) {
            passwordField.setError(err.message);
            passwordField.control.focus();
          }
        },
      },
    ],
  });
}

// --- Two-factor ------------------------------------------------------------

function twoFactorSection(settings, readOnly) {
  const body = el('div', {}, el('p', { class: 'muted', text: 'Checking…' }));

  const render = (status) => {
    mount(
      clear(body),
      status.notice ? alertBox(status.notice, { type: 'warn', title: 'Required here' }) : null,

      status.enabled
        ? alertBox(
            `On for your account since ${formatDate(status.confirmed_at)}. `
            + `${status.recovery_codes_remaining} recovery code(s) left.`,
            { type: 'ok', title: 'Two-factor is on' })
        : alertBox(
            'Your account signs in with a password alone.',
            { type: 'info', title: 'Two-factor is off' }),

      el('div', { class: 'btn-group', style: { marginTop: '12px' } }, [
        // Each button carries its own handler. They used to be found afterwards
        // by position, first, second, third, and since only some of them are on
        // the page at once the positions were wrong whenever two-factor was on:
        // "New recovery codes" started a fresh enrolment and "Turn it off"
        // offered new codes, so there was no way to turn it off at all.
        status.enabled
          ? null
          : el('button', {
              type: 'button', class: 'btn btn-primary',
              onClick: () => enrolTwoFactor(() => refresh()),
            }, 'Set up two-factor sign-in'),
        status.enabled
          ? el('button', {
              type: 'button', class: 'btn',
              onClick: () => newRecoveryCodes(() => refresh()),
            }, 'New recovery codes')
          : null,
        status.enabled && !status.required_for_you
          ? el('button', {
              type: 'button', class: 'btn btn-ghost',
              onClick: () => disableTwoFactor(() => refresh()),
            }, 'Turn it off')
          : null,
      ]),
    );
  };

  const refresh = () => api.twoFactor().then(render).catch((err) => {
    clear(body).append(alertBox(err.message, { type: 'danger' }));
  });

  refresh();

  return el('section', { class: 'card', 'aria-labelledby': '2fa-heading' }, [
    el('h2', { id: '2fa-heading', text: 'Two-factor sign-in' }),
    el('p', {
      class: 'muted',
      text: 'A code from your phone as well as your password. An administrator account reaches every '
          + 'client record here, which is what this protects.',
    }),
    body,

    el('hr'),

    settingsPanel({
      id: 'security', title: 'For everyone', settings, readOnly,
      blurb: null,
      fields: [{
        key: 'security.require_2fa_for_admins', type: 'boolean',
        label: 'Require two-factor for all administrators',
        help: 'Administrators who have not set it up yet are still let in, and told to. Turning '
            + 'this on cannot lock out the person turning it on.',
      }],
    }),
  ]);
}

async function enrolTwoFactor(onDone) {
  let setup;

  try {
    setup = await api.beginTwoFactor();
  } catch (err) {
    toastError(err.message);
    return;
  }

  const codeField = field({
    name: 'code', label: 'Code from the app', required: true,
    autocomplete: 'one-time-code', inputmode: 'numeric',
  });

  const error = el('div', { role: 'alert' });

  await modal({
    title: 'Set up two-factor sign-in',
    wide: true,
    body: el('div', {}, [
      el('ol', {}, setup.steps.map((step) => el('li', { text: step }))),

      el('div', { class: 'grid grid-2' }, [
        // The QR is generated on the server, so this page needs no library.
        el('div', { class: 'qr-holder', html: setup.qr_svg }),
        el('div', {}, [
          el('p', { class: 'label', text: 'Or type this in' }),
          el('p', { class: 'key-reveal mono', text: setup.secret_formatted }),
          el('p', {
            class: 'field-help',
            text: 'Use this if the camera will not focus, or if you are setting it up on the same '
                + 'device you are reading this on.',
          }),
        ]),
      ]),

      error,
      codeField,
      el('p', { class: 'field-help', text: setup.notice }),
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Turn it on',
        class: 'btn-primary',
        onClick: async (close) => {
          try {
            const result = await api.confirmTwoFactor(codeField.control.value.trim());
            close(true);
            showRecoveryCodes(result.recovery_codes, result.notice);
            onDone?.();
          } catch (err) {
            codeField.setError(err.message);
            codeField.control.focus();
          }
        },
      },
    ],
  });
}

/**
 * Show recovery codes, once.
 *
 * Offered as a download as well as on screen: told to write them down, most
 * people will not, and a lost phone with no codes means an administrator
 * locked out of their own system with nobody able to help.
 */
function showRecoveryCodes(codes, notice) {
  modal({
    title: 'Save your recovery codes',
    body: el('div', {}, [
      alertBox(notice, { type: 'warn', title: 'Shown once' }),
      el('ul', { class: 'key-reveal mono', style: { listStyle: 'none', padding: '12px' } },
        codes.map((code) => el('li', { text: code }))),
      el('button', {
        type: 'button', class: 'btn',
        onClick: () => {
          const lines = [
            'Loaner Pool recovery codes',
            '',
            'Each code works once. Keep them somewhere other than your phone.',
            '',
            ...codes,
            '',
          ];

          const blob = new Blob([lines.join(String.fromCharCode(10))], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = el('a', { href: url, download: 'loaner-pool-recovery-codes.txt' });
          document.body.append(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        },
      }, 'Download them as a text file'),
    ]),
    actions: [{ label: 'I have saved them', class: 'btn-primary', value: true }],
  });
}

async function newRecoveryCodes(onDone) {
  const passwordField = field({
    name: 'password', label: 'Your password', type: 'password', required: true,
    autocomplete: 'current-password',
  });

  await modal({
    title: 'Generate new recovery codes',
    body: el('div', {}, [
      el('p', { text: 'Your existing codes will stop working.' }),
      passwordField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Generate',
        class: 'btn-primary',
        onClick: async (close) => {
          try {
            const result = await api.regenerateRecoveryCodes(passwordField.control.value);
            close(true);
            showRecoveryCodes(result.recovery_codes, result.notice);
            // The card says how many codes are left, and that has just changed.
            onDone?.();
          } catch (err) {
            passwordField.setError(err.message);
            passwordField.control.focus();
          }
        },
      },
    ],
  });
}

async function disableTwoFactor(onDone) {
  const passwordField = field({
    name: 'password', label: 'Your password', type: 'password', required: true,
    autocomplete: 'current-password',
  });

  await modal({
    title: 'Turn off two-factor sign-in',
    body: el('div', {}, [
      el('p', { text: 'Your account will sign in with a password alone.' }),
      passwordField,
    ]),
    actions: [
      { label: 'Keep it on', class: 'btn-ghost', value: null },
      {
        label: 'Turn it off',
        class: 'btn-danger',
        onClick: async (close) => {
          try {
            await api.disableTwoFactor(passwordField.control.value);
            toastOk('Two-factor sign-in is off.');
            close(true);
            onDone?.();
          } catch (err) {
            passwordField.setError(err.message);
            passwordField.control.focus();
          }
        },
      },
    ],
  });
}

// --- Updates ---------------------------------------------------------------

/**
 * Whether this installation is behind the published version.
 *
 * Loaded after the page rather than with it: many shared hosts block outbound
 * HTTPS, and an update check that cannot complete must not hold up the
 * settings screen. Checking only — applying an update is a command on the
 * server, and the panel shows which one.
 */
function updatesSection(readOnly) {
  const body = el('div', {}, el('p', { class: 'muted', text: 'Checking for updates…' }));

  const checkButton = el('button', {
    type: 'button', class: 'btn', disabled: readOnly,
  }, 'Check now');

  const render = (result) => {
    const local = result.local || {};
    const rows = [
      el('dt', { text: 'Version' }),
      el('dd', { text: `${local.app_version || '—'} (database schema ${local.schema_version ?? '—'})` }),
      el('dt', { text: 'Installed from' }),
      el('dd', { text: local.install_method === 'git' ? 'a git clone' : 'uploaded files' }),
    ];

    if (local.commit_short) {
      rows.push(
        el('dt', { text: 'Code version' }),
        el('dd', { class: 'mono', text: `${local.commit_short}${local.branch ? ` on ${local.branch}` : ''}` }),
      );
    }

    clear(body);

    if (result.reachable === false) {
      body.append(
        alertBox(
          `${result.summary} ${result.detail || ''}`.trim(),
          { type: 'info', title: 'Cannot check from this server' },
        ),
        el('dl', { class: 'detail-list' }, rows),
      );
      return;
    }

    if (result.up_to_date === true) {
      body.append(
        alertBox('This installation is running the latest published version.',
          { type: 'ok', title: 'Up to date' }),
        el('dl', { class: 'detail-list' }, rows),
      );
      return;
    }

    const how = result.how_to_apply;

    mount(
      body,
      alertBox(result.summary, { type: 'warn', title: 'An update is available' }),
      el('dl', { class: 'detail-list' }, rows),

      local.has_local_changes === true
        ? alertBox(
            'Tracked files on the server have been edited. Updating would overwrite those edits, so ' +
            'review them first.',
            { type: 'warn', title: 'Local changes on the server' },
          )
        : null,

      // Clutter, not an obstacle: untracked files cannot conflict with an
      // update and nothing will touch them. Mentioned because a stray copy of
      // the application sitting beside it is worth knowing about.
      (local.untracked_files || []).length
        ? alertBox(
            `Files here are not part of the application: ${local.untracked_files.join(', ')}. ` +
            'They do not affect the update and will be left alone, but they can be deleted.',
            { type: 'info', title: 'Extra files in the folder' },
          )
        : null,

      el('div', { class: 'btn-group', style: { marginTop: '14px' } }, [
        can('settings.write')
          ? el('button', {
              type: 'button', class: 'btn btn-primary', disabled: readOnly,
              onClick: () => installUpdate(result, render),
            }, 'Install this update')
          : null,
        result.latest && result.latest.url
          ? el('a', { class: 'btn', href: result.latest.url, target: '_blank', rel: 'noopener' },
              'See what changed')
          : null,
      ]),

      how && how.command
        ? el('details', { style: { marginTop: '14px' } }, [
            el('summary', { text: 'Prefer to do it from the command line?' }),
            el('p', { class: 'label', style: { marginTop: '10px' }, text: 'Run this on the server' }),
            el('p', { class: 'mono key-reveal', text: how.command }),
            how.notice ? el('p', { class: 'field-help', text: how.notice }) : null,
          ])
        : null,
    );
  };

  /**
   * Install an update from the browser.
   *
   * The password is asked for again on purpose. This replaces the code the
   * server runs, so an open session left on an unattended machine should not
   * be enough by itself.
   */
  async function installUpdate(result, rerender) {
    const passwordField = field({
      name: 'password', label: 'Your password', type: 'password', required: true,
      autocomplete: 'current-password',
      help: 'Confirming that it is really you. Updating replaces the application code.',
    });

    const progress = el('div', { role: 'status', 'aria-live': 'polite' });

    await modal({
      title: 'Install this update',
      body: el('div', {}, [
        el('p', { text: result.summary }),
        el('ul', {}, [
          el('li', { text: 'Your devices, loans, clients and photos are not touched.' }),
          el('li', { text: 'A backup of the current files is saved first.' }),
          el('li', { text: 'The site is unavailable for a few seconds while the files are replaced.' }),
          el('li', { text: 'Any database changes the new version needs are applied automatically.' }),
        ]),
        el('p', { class: 'field-help' },
          'Back up your database before doing this. The updater backs up the files, not the data.'),
        passwordField,
        progress,
      ]),
      actions: [
        { label: 'Cancel', class: 'btn-ghost', value: null },
        {
          label: 'Install it',
          class: 'btn-primary',
          onClick: async (close) => {
            const password = passwordField.control.value;

            if (!password) {
              passwordField.setError('Enter your password to confirm.');
              passwordField.control.focus();
              return;
            }

            passwordField.setError(null);
            clear(progress).append(loadingBlock(
              'Downloading and installing. This can take a minute — do not close this page.',
            ));
            announce('Installing the update. Please wait.', { assertive: true });

            try {
              const outcome = await api.applyUpdate(password);

              clear(progress).append(
                alertBox(outcome.message, { type: 'ok', title: 'Update installed' }),
                el('ul', { class: 'mono', style: { fontSize: '0.85em' } },
                  (outcome.log || []).map((line) => el('li', { text: line }))),
              );

              // The browser is still running the old JavaScript, so a reload
              // is needed to pick up the new interface. It is theirs to press:
              // a page that replaces itself four seconds after a message
              // appeared takes that message away from anyone still reading it
              // (SC 3.2.5, 2.2.4).
              progress.append(el('button', {
                type: 'button', class: 'btn btn-primary',
                onClick: () => window.location.reload(),
              }, 'Reload to use the new version'));

              toastOk(outcome.message);
              announce('The update finished. Use the Reload button to start the new version.',
                { assertive: true });
            } catch (err) {
              clear(progress);

              if (err.field === 'password') {
                passwordField.setError(err.message);
                passwordField.control.focus();
                return;
              }

              progress.append(alertBox(err.message, { type: 'danger', title: 'The update did not run' }));
              announce(`The update did not run. ${err.message}`, { assertive: true });
            }
          },
        },
      ],
    });

    try {
      rerender(await api.updates());
    } catch { /* The panel will refresh on the reload. */ }
  }

  checkButton.addEventListener('click', async () => {
    await withBusy(checkButton, 'Checking…', async () => {
      try {
        render(await api.checkUpdates());
      } catch (err) {
        clear(body).append(alertBox(err.message, { type: 'danger', title: 'Could not check' }));
      }
    });
  });

  api.updates()
    .then(render)
    .catch((err) => {
      clear(body).append(alertBox(err.message, { type: 'info', title: 'Could not check for updates' }));
    });

  return el('section', { class: 'card', 'aria-labelledby': 'updates-heading' }, [
    el('div', { class: 'card-header' }, [
      el('h2', { id: 'updates-heading', text: 'Software updates' }),
      checkButton,
    ]),
    el('p', {
      class: 'muted',
      text:
        'This checks github.com for a newer version. It never installs anything without you asking, ' +
        'and it sends nothing about this installation — only a request for the latest version number.',
    }),
    body,
  ]);
}

/**
 * A settings panel that is nothing but switches and numbers.
 *
 * Most of the new ones are exactly that, and writing each out longhand would
 * be two hundred lines of the same shape with the interesting part — the
 * wording — buried in it.
 */
function settingsPanel({ id, title, blurb, settings, readOnly, fields, extra = null }) {
  const controls = {};

  const body = fields.map((spec) => {
    if (spec.type === 'boolean') {
      const input = el('input', {
        type: 'checkbox', id: `set-${spec.key}`,
        checked: Boolean(settings[spec.key]), disabled: readOnly,
      });
      controls[spec.key] = () => input.checked;

      return el('label', { class: 'checkbox', for: `set-${spec.key}` }, [
        input,
        el('span', {}, [
          spec.label,
          spec.help ? el('span', { class: 'option-help', text: spec.help }) : null,
        ]),
      ]);
    }

    const f = field({
      name: spec.key,
      label: spec.label,
      type: spec.type === 'integer' ? 'number' : (spec.inputType || 'text'),
      value: settings[spec.key] ?? '',
      help: spec.help,
      disabled: readOnly,
      min: spec.min,
      max: spec.max,
      autocomplete: spec.autocomplete || 'off',
    });

    controls[spec.key] = spec.type === 'integer'
      ? () => Number(f.control.value || 0)
      : () => f.control.value.trim();

    return f;
  });

  const button = el('button', { type: 'submit', class: 'btn btn-primary', disabled: readOnly },
    'Save these settings');

  const form = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();

      await withBusy(button, 'Saving…', async () => {
        const updates = {};
        for (const [key, read] of Object.entries(controls)) {
          const value = read();
          // A blank secret means "leave it as it is", so it is not sent at
          // all — saving this form must never wipe a stored credential.
          if (fields.find((f) => f.key === key)?.secret && value === '') continue;
          updates[key] = value;
        }

        try {
          await api.updateSettings(updates);
          toastOk('Settings saved.');
          announce('Settings saved.');
        } catch (err) {
          toastError(err.message);
        }
      });
    },
  }, [...body, button]);

  return el('section', { class: 'card', 'aria-labelledby': `${id}-heading` }, [
    el('h2', { id: `${id}-heading`, text: title }),
    blurb ? el('p', { class: 'muted', text: blurb }) : null,
    extra,
    form,
  ]);
}

// --- Waitlist ----------------------------------------------------------------

function waitlistSection(settings, readOnly) {
  return settingsPanel({
    id: 'waitlist', title: 'Waitlist', settings, readOnly,
    blurb:
      'When every unit of something is out, the next person can ask to be told when one comes '
      + 'back. The device is then held for them for a while, so it is not lent to whoever happens '
      + 'to be at the desk.',
    fields: [
      {
        key: 'reservations.enabled', type: 'boolean',
        label: 'Let people join a waitlist',
        help: 'Switching this off stops new entries. Anyone already waiting stays in the queue.',
      },
      {
        key: 'reservations.hold_hours', type: 'integer', min: 1, max: 720,
        label: 'Hold a returned device for this many hours',
        help: 'After that it goes to the next person waiting, or back on the shelf. Between 1 and 720.',
      },
    ],
  });
}

// --- Trial outcomes --------------------------------------------------------

function outcomesSection(settings, readOnly) {
  return settingsPanel({
    id: 'outcomes', title: 'Trial outcomes', settings, readOnly,
    blurb:
      'Whether a device actually worked for the person who borrowed it. This is what turns loan '
      + 'records into evidence for a purchase, and it is the only way to know which equipment is '
      + 'worth stocking more of.',
    fields: [
      { key: 'outcomes.enabled', type: 'boolean', label: 'Record trial outcomes' },
      {
        key: 'outcomes.prompt_on_checkin', type: 'boolean',
        label: 'Ask at check-in',
        help: 'Always skippable. An outcome guessed at the counter is worse than a blank one, '
            + 'because the reports cannot tell them apart.',
      },
      {
        key: 'outcomes.chase_after_days', type: 'integer', min: 1,
        label: 'Remind administrators after this many days',
        help: 'One reminder per trial, not a daily nag.',
      },
    ],
  });
}

// --- Hygiene ---------------------------------------------------------------

function hygieneSection(settings, readOnly) {
  return settingsPanel({
    id: 'hygiene', title: 'Cleaning between users', settings, readOnly,
    blurb:
      'Equipment that touches ears, mouths and hands goes to the next person afterwards. '
      + 'Recording the cleaning is what lets you answer, months later, whether a particular device '
      + 'was cleaned between two particular people.',
    fields: [
      { key: 'hygiene.enabled', type: 'boolean', label: 'Track cleaning' },
      {
        key: 'hygiene.require_between_loans', type: 'boolean',
        label: 'A device cannot be lent again until its cleaning is recorded',
        help: 'Switch this on only if it reflects what your service actually does. A rule staff '
            + 'have to work around is worse than no rule.',
      },
      {
        key: 'hygiene.default_method', type: 'string',
        label: 'Usual method',
        help: 'Offered as the default when somebody records a cleaning. For example: 70% alcohol wipe.',
      },
    ],
  });
}

// --- Text messages ---------------------------------------------------------

function smsSection(settings, readOnly) {
  return settingsPanel({
    id: 'sms', title: 'Text messages (Twilio)', settings, readOnly,
    blurb:
      'A text reaches people an email does not. Only clients who have agreed to be texted are ever '
      + 'sent one — a mobile number on a record is not consent by itself.',
    extra: el('p', { class: 'field-help' },
      'Texts cost money per message and arrive on a lock screen, so only the three time-critical '
      + 'events can send one. They never contain a link: a link in an unexpected text is '
      + 'indistinguishable from a phishing attempt.'),
    fields: [
      { key: 'sms.enabled', type: 'boolean', label: 'Send text messages' },
      { key: 'sms.account_sid', type: 'string', label: 'Twilio Account SID' },
      {
        key: 'sms.auth_token', type: 'string', label: 'Twilio auth token',
        inputType: 'password', secret: true,
        help: 'Stored encrypted. Leave blank to keep the one already saved.',
      },
      {
        key: 'sms.from_number', type: 'string', label: 'Sending number',
        help: 'In full international form, for example +19185550100.',
      },
      { key: 'sms.on_ready_for_pickup', type: 'boolean', label: 'When equipment is ready to collect' },
      { key: 'sms.on_due_soon', type: 'boolean', label: 'When a loan is due back soon' },
      { key: 'sms.on_overdue', type: 'boolean', label: 'When a loan is overdue' },
    ],
  });
}

// --- Loan agreements -------------------------------------------------------

function agreementsSection(settings, readOnly) {
  const enabled = el('input', {
    type: 'checkbox', id: 'agr-enabled', checked: Boolean(settings['agreements.enabled']), disabled: readOnly,
  });
  const required = el('input', {
    type: 'checkbox', id: 'agr-required', checked: Boolean(settings['agreements.required']), disabled: readOnly,
  });
  const allowWaive = el('input', {
    type: 'checkbox', id: 'agr-waive', checked: Boolean(settings['agreements.allow_waive']), disabled: readOnly,
  });

  const textField = field({
    name: 'agreements.text', label: 'Agreement wording', type: 'textarea', rows: 12,
    value: settings['agreements.text'] || '', disabled: readOnly,
    help:
      'Leave blank to use the built-in default. Placeholders {{organisation}}, {{device}}, ' +
      '{{due_date}}, {{accessories}}, {{client}} and {{reference}} are filled in per loan. ' +
      'The wording is copied onto each loan when it is signed, so changing it here never alters ' +
      'an agreement someone has already signed.',
  });

  const button = el('button', { type: 'submit', class: 'btn btn-primary', disabled: readOnly }, 'Save agreements');

  const form = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      await withBusy(button, 'Saving…', async () => {
        try {
          await api.updateSettings({
            'agreements.enabled': enabled.checked,
            'agreements.required': required.checked,
            'agreements.allow_waive': allowWaive.checked,
            'agreements.text': textField.control.value,
          });
          toastOk('Agreement settings saved.');
        } catch (err) { toastError(err.message); }
      });
    },
  }, [
    el('label', { class: 'checkbox', for: 'agr-enabled' }, [
      enabled,
      el('span', {}, [
        'Capture a loan agreement at check-out',
        el('span', { class: 'option-help' }, 'Prompts for a signature after each loan is created.'),
      ]),
    ]),
    el('label', { class: 'checkbox', for: 'agr-required' }, [
      required,
      el('span', {}, [
        'Treat the agreement as required',
        el('span', { class: 'option-help' },
          'Loans still go out if it is skipped — the equipment has already changed hands — but the ' +
          'gap is flagged and auditable.'),
      ]),
    ]),
    el('label', { class: 'checkbox', for: 'agr-waive' }, [
      allowWaive,
      el('span', {}, [
        'Allow staff to waive a signature with a reason',
        el('span', { class: 'option-help' }, 'The reason is recorded on the loan and in the audit log.'),
      ]),
    ]),
    textField,
    button,
  ]);

  return el('section', { class: 'card', 'aria-labelledby': 'agreements-heading' }, [
    el('h2', { id: 'agreements-heading', text: 'Loan agreements' }),
    el('p', {
      class: 'muted',
      text:
        'Clients can sign by typing their name, drawing a signature, or photographing a signed paper ' +
        'form — all three count equally, so nobody is blocked by not being able to use a pointer.',
    }),
    form,
  ]);
}

// --- Condition photos ------------------------------------------------------

function photosSection(settings, readOnly) {
  const boxes = {};
  const rows = [
    ['photos.enabled', 'Allow condition photos', 'Off by default. Taking photos of equipment affects privacy, so turn this on only if you mean to.'],
    ['photos.prompt_on_checkout', 'Offer the camera at check-out', 'Still optional for the person at the desk.'],
    ['photos.prompt_on_checkin', 'Offer the camera at check-in', 'Where damage is usually discovered.'],
  ];

  const maxField = field({
    name: 'photos.max_per_phase', label: 'Maximum photos per check-out or check-in',
    type: 'number', min: 1, max: 20, value: settings['photos.max_per_phase'], disabled: readOnly,
  });

  const usage = el('p', { class: 'field-help', role: 'status' }, 'Checking storage…');
  api.storageUsage()
    .then((u) => { usage.textContent = `Currently storing ${u.files} file(s), ${u.megabytes} MB.`; })
    .catch(() => { usage.textContent = ''; });

  const button = el('button', { type: 'submit', class: 'btn btn-primary', disabled: readOnly }, 'Save photo settings');

  const form = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      await withBusy(button, 'Saving…', async () => {
        const updates = { 'photos.max_per_phase': Number(maxField.control.value) };
        for (const [key, box] of Object.entries(boxes)) updates[key] = box.checked;
        try {
          await api.updateSettings(updates);
          toastOk('Photo settings saved.');
        } catch (err) { toastError(err.message); }
      });
    },
  }, [
    ...rows.map(([key, label, help]) => {
      const box = el('input', { type: 'checkbox', id: `ph-${key}`, checked: Boolean(settings[key]), disabled: readOnly });
      boxes[key] = box;
      return el('label', { class: 'checkbox', for: `ph-${key}` }, [
        box, el('span', {}, [label, el('span', { class: 'option-help' }, help)]),
      ]);
    }),
    maxField,
    usage,
    button,
  ]);

  return el('section', { class: 'card', 'aria-labelledby': 'photos-heading' }, [
    el('h2', { id: 'photos-heading', text: 'Condition photos' }),
    el('p', {
      class: 'muted',
      text:
        'Entirely optional. Photos are resized in the browser, stored outside the web root, and only ' +
        'served to signed-in staff — they are never at a guessable address.',
    }),
    form,
  ]);
}

// --- Scheduled reminders ---------------------------------------------------

function schedulerSection(readOnly) {
  const body = el('div', {}, loadingBlock('Checking the reminder job…'));

  const load = async () => {
    try {
      const jobs = await api.jobs();

      mount(clear(body),
        jobs.healthy
          ? alertBox(
              `Reminders are running. Last successful run: ${formatDate(jobs.last_success.started_at, { withTime: true })}.`,
              { type: 'ok', title: 'Healthy' })
          : alertBox(
              jobs.last_success
                ? `The last successful run was ${formatDate(jobs.last_success.started_at, { withTime: true })}, ` +
                  'which is longer ago than expected. Due-soon and overdue emails may not be going out.'
                : 'The reminder job has never completed successfully, so due-soon and overdue emails are not going out.',
              { type: 'warn', title: 'Reminders may not be running' }),

        el('p', {
          class: 'field-help',
          text: jobs.in_process_scheduler
            ? 'The built-in scheduler is on and checks hourly, sending only between 07:00 and 19:00 local time.'
            : 'The built-in scheduler is switched off, so an external cron entry must call the job.',
        }),

        el('div', { class: 'btn-group' }, [
          // Running the job and reading the cron command both need
          // settings.write; somebody who can only look is not offered either.
          readOnly ? null : el('button', {
            type: 'button', class: 'btn btn-primary',
            onClick: async (event) => {
              await withBusy(event.currentTarget, 'Running…', async () => {
                try {
                  const result = await api.runJobs();
                  toastOk(result.summary || 'Reminder run complete.');
                  load();
                } catch (err) { toastError(err.message); }
              });
            },
          }, 'Run reminders now'),
          // The answer holds the cron token, so this needs settings.write.
          readOnly ? null : el('button', {
            type: 'button', class: 'btn',
            onClick: async () => {
              try {
                const cron = await api.cronCommand();
                modal({
                  title: 'Run reminders from cron',
                  wide: true,
                  body: el('div', {}, [
                    el('p', { text: cron.note }),
                    el('p', { class: 'label' }, 'Crontab line (09:00 daily)'),
                    el('p', { class: 'key-reveal', text: cron.crontab }),
                    alertBox(
                      'This token lets anyone who has it trigger the job. Treat it like a password.',
                      { type: 'warn' },
                    ),
                  ]),
                  actions: [{ label: 'Close', class: 'btn-primary', value: true }],
                });
              } catch (err) { toastError(err.message); }
            },
          }, 'Show the cron command'),
        ]),

        jobs.runs.length
          ? dataTable({
              caption: 'Recent scheduled runs',
              columns: [
                { key: 'started_at', label: 'Started', render: (r) => dateCell(r.started_at, { withTime: true }) },
                {
                  key: 'status', label: 'Result',
                  render: (r) => el('span', { class: `pill ${r.status === 'ok' ? 'pill-ok' : r.status === 'failed' ? 'pill-danger' : 'pill-warn'}` }, r.status),
                },
                { key: 'triggered_by', label: 'Triggered by', render: (r) => r.triggered_by || '—' },
                { key: 'summary', label: 'What happened', render: (r) => r.summary || '—' },
              ],
              rows: jobs.runs,
            })
          : null,
      );
    } catch (err) {
      mount(clear(body), alertBox(err.message, { type: 'danger', title: 'Could not read job history' }));
    }
  };

  load();

  return el('section', { class: 'card', 'aria-labelledby': 'jobs-heading' }, [
    el('h2', { id: 'jobs-heading', text: 'Due-soon and overdue reminders' }),
    el('p', {
      class: 'muted',
      text:
        'These are the only emails sent on a schedule rather than in response to something happening. ' +
        'If this job stops running, nobody is chased for an overdue device.',
    }),
    body,
  ]);
}

// ===========================================================================
// Loan periods
// ===========================================================================

/** Sign in with Microsoft Entra ID. */
function ssoCard(settings, initialStatus, readOnly) {
  const fields = {
    'sso.tenant_id': field({
      name: 'sso.tenant_id', label: 'Directory (tenant) ID', value: settings['sso.tenant_id'] || '',
      disabled: readOnly, autocomplete: 'off',
      help: 'From the app registration Overview page. It has to be the ID, not a name such as "common".',
    }),
    'sso.client_id': field({
      name: 'sso.client_id', label: 'Application (client) ID', value: settings['sso.client_id'] || '',
      disabled: readOnly, autocomplete: 'off',
    }),
    'sso.client_secret': field({
      name: 'sso.client_secret', label: 'Client secret', type: 'password',
      disabled: readOnly, autocomplete: 'off',
      placeholder: settings['sso.client_secret__is_set'] ? 'Stored — leave blank to keep it' : '',
      help: settings['sso.client_secret__is_set']
        ? `A secret is stored (${settings['sso.client_secret__hint']}). Leave this blank to keep it.`
        : 'The secret VALUE from Azure, not the secret ID.',
    }),
    'sso.session_hours': field({
      name: 'sso.session_hours', label: 'Sign people out after this many hours', type: 'number',
      value: settings['sso.session_hours'] ?? 24, min: 1, max: 336, disabled: readOnly,
      help: 'Turning someone off in Microsoft does not end a session here, so this is how long a person who has left could still get in.',
    }),
    'sso.default_role': field({
      name: 'sso.default_role', label: 'Role for accounts created at first sign-in', type: 'select',
      value: settings['sso.default_role'] || 'viewer', disabled: readOnly,
      options: [
        { value: 'viewer', label: 'Read-only' },
        { value: 'vrc', label: 'Vocational Rehabilitation Counselor' },
        { value: 'tech', label: 'Technician' },
      ],
    }),
  };

  const box = (id, key, label, help) => {
    const input = el('input', { type: 'checkbox', id, checked: Boolean(settings[key]), disabled: readOnly });
    return {
      key,
      input,
      node: el('label', { class: 'checkbox', for: id }, [
        input, el('span', {}, [label, el('span', { class: 'option-help' }, help)]),
      ]),
    };
  };

  const boxes = [
    box('sso-enabled', 'sso.enabled', 'Offer "Sign in with Microsoft"', 'Adds the button to the sign-in page.'),
    box('sso-required', 'sso.required', 'Require it for everyone except administrators',
      'Staff can no longer use a password. Administrators can, so someone can still get in if Microsoft is unavailable.'),
    box('sso-auto-create', 'sso.auto_create', 'Create an account the first time someone signs in',
      'Off means an administrator adds each person first. Being in your directory does not by itself give access to client records.'),
  ];

  const statusBox = el('div');
  const renderStatus = (status) => {
    clear(statusBox);
    if (!status) return;
    statusBox.append(status.usable
      ? alertBox('Microsoft sign-in is set up and switched on.', { type: 'ok', title: 'Ready' })
      : alertBox(status.reason, { type: 'warn', title: 'Not in use' }));
    if (!status.https) {
      statusBox.append(alertBox('Microsoft only accepts an https:// redirect address, except on localhost.',
        { type: 'warn', title: 'This site is not on HTTPS' }));
    }
  };
  renderStatus(initialStatus);

  const button = el('button', { type: 'submit', class: 'btn btn-primary', disabled: readOnly }, 'Save sign-in settings');

  const form = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      await withBusy(button, 'Saving…', async () => {
        const updates = {};
        for (const b of boxes) updates[b.key] = b.input.checked;
        for (const [key, f] of Object.entries(fields)) {
          const value = f.control.value.trim?.() ?? f.control.value;
          if (key === 'sso.client_secret' && value === '') continue;
          updates[key] = key === 'sso.session_hours' ? Number(value || 24) : value;
        }

        try {
          const result = await api.updateSettings(updates);
          toastOk('Sign-in settings saved.');
          renderStatus(result.sso_status);
          fields['sso.client_secret'].control.value = '';
        } catch (err) {
          toastError(err.message);
        }
      });
    },
  }, [
    ...boxes.map((b) => b.node),
    el('div', { class: 'form-grid' }, [fields['sso.tenant_id'], fields['sso.client_id']]),
    fields['sso.client_secret'],
    el('div', { class: 'form-grid' }, [fields['sso.session_hours'], fields['sso.default_role']]),
    button,
  ]);

  return el('section', { class: 'card', 'aria-labelledby': 'sso-heading' }, [
    el('h2', { id: 'sso-heading', text: 'Sign in with Microsoft' }),
    el('p', { class: 'muted', text: 'Staff sign in with their Microsoft work account (Entra ID). In the app registration, add this as a Web redirect address:' }),
    el('p', { class: 'key-reveal', text: initialStatus?.redirect_uri || '' }),
    statusBox,
    form,
  ]);
}

export async function renderLoanPeriods() {
  const container = el('div');
  const results = el('div');

  const load = async () => {
    clear(results).append(loadingBlock('Loading loan periods…'));
    try {
      const response = await api.adminLoanPeriods();

      clear(results).append(dataTable({
        caption: 'Loan periods offered at check-out',
        columns: [
          {
            key: 'name', label: 'Name',
            render: (p) => el('span', {}, [
              p.name,
              p.is_default ? el('span', { class: 'cell-sub', text: 'Default' }) : null,
            ]),
          },
          {
            key: 'days', label: 'Length', align: 'right',
            render: (p) => p.days === 0 ? el('span', { class: 'muted' }, 'No due date') : `${p.days} days`,
          },
          { key: 'max_extensions', label: 'Extensions allowed', align: 'right', render: (p) => String(p.max_extensions) },
          { key: 'extension_days', label: 'Each extension', align: 'right', render: (p) => `${p.extension_days} days` },
          {
            key: 'status', label: 'Status',
            render: (p) => p.active
              ? el('span', { class: 'pill pill-ok' }, 'Active')
              : el('span', { class: 'pill pill-neutral' }, 'Inactive'),
          },
          {
            key: 'actions', label: 'Actions', align: 'right',
            render: (p) => el('div', { class: 'table-actions' }, [
              el('button', {
                type: 'button', class: 'btn btn-sm',
                onClick: () => openPeriodDialog(p, load),
              }, ['Edit', el('span', { class: 'visually-hidden' }, ` ${p.name}`)]),
              el('button', {
                type: 'button', class: 'btn btn-sm',
                disabled: Boolean(p.is_default),
                onClick: async () => {
                  const ok = await confirmDialog({
                    title: `Remove "${p.name}"?`,
                    message:
                      'If any loan has used this period it will be deactivated rather than deleted, ' +
                      'so historic loans keep their record.',
                    confirmLabel: 'Remove',
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    const result = await api.deleteLoanPeriod(p.id);
                    toastOk(result.message || 'Loan period removed.');
                    load();
                  } catch (err) { toastError(err.message); }
                },
              }, ['Remove', el('span', { class: 'visually-hidden' }, ` ${p.name}`)]),
            ]),
          },
        ],
        rows: response.data,
        emptyMessage: 'No loan periods configured.',
      }));
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load loan periods' }));
    }
  };

  container.append(
    el('p', { class: 'breadcrumb' }, [el('a', { href: '#/settings' }, 'Settings'), ' / Loan periods']),
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Loan periods' }),
        el('p', {
          text:
            'The durations offered at check-out. A technician can always set a custom length for ' +
            'an individual loan, so these are defaults rather than limits.',
        }),
      ]),
      el('button', {
        type: 'button', class: 'btn btn-primary', onClick: () => openPeriodDialog(null, load),
      }, 'Add loan period'),
    ]),
    results,
  );

  load();
  return container;
}

async function openPeriodDialog(period, onDone) {
  const fields = {
    name: field({ name: 'name', label: 'Name', required: true, value: period?.name || '' }),
    days: field({
      name: 'days', label: 'Length in days', type: 'number', min: 0, max: 3650,
      value: period?.days ?? 30, help: 'Enter 0 for a loan with no return date.',
    }),
    max_extensions: field({
      name: 'max_extensions', label: 'Extensions allowed', type: 'number', min: 0, max: 50,
      value: period?.max_extensions ?? 2,
      help: 'An administrator can override this on an individual loan.',
    }),
    extension_days: field({
      name: 'extension_days', label: 'Days per extension', type: 'number', min: 0, max: 365,
      value: period?.extension_days ?? 14,
    }),
  };

  const defaultBox = el('input', { type: 'checkbox', id: 'period-default', checked: Boolean(period?.is_default) });
  const activeBox = el('input', { type: 'checkbox', id: 'period-active', checked: period ? Boolean(period.active) : true });

  return modal({
    title: period ? `Edit "${period.name}"` : 'Add a loan period',
    body: el('div', {}, [
      fields.name,
      fields.days,
      el('div', { class: 'form-grid' }, [fields.max_extensions, fields.extension_days]),
      el('label', { class: 'checkbox', for: 'period-default' }, [
        defaultBox,
        el('span', {}, [
          'Use this by default at check-out',
          el('span', { class: 'option-help' }, 'Only one period can be the default.'),
        ]),
      ]),
      period ? el('label', { class: 'checkbox', for: 'period-active' }, [
        activeBox, el('span', {}, 'Offer this period at check-out'),
      ]) : null,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: period ? 'Save changes' : 'Add period',
        class: 'btn-primary',
        onClick: async (close) => {
          for (const f of Object.values(fields)) f.setError(null);

          const body = {
            name: fields.name.control.value.trim(),
            days: Number(fields.days.control.value),
            max_extensions: Number(fields.max_extensions.control.value),
            extension_days: Number(fields.extension_days.control.value),
            is_default: defaultBox.checked,
          };
          if (period) body.active = activeBox.checked;

          try {
            if (period) await api.updateLoanPeriod(period.id, body);
            else await api.createLoanPeriod(body);
            toastOk(period ? 'Loan period updated.' : 'Loan period added.');
            close(true);
            onDone?.();
          } catch (err) {
            if (err.field && fields[err.field]) {
              fields[err.field].setError(err.message);
              fields[err.field].control.focus();
            } else { toastError(err.message); }
          }
        },
      },
    ],
  });
}

// ===========================================================================
// API keys
// ===========================================================================

export async function renderApiKeys() {
  const container = el('div');
  const results = el('div');

  const load = async () => {
    clear(results).append(loadingBlock('Loading API keys…'));
    try {
      const response = await api.apiKeys();

      clear(results).append(dataTable({
        caption: 'API keys for third-party integrations',
        columns: [
          {
            key: 'name', label: 'Name',
            render: (k) => el('span', {}, [k.name, el('span', { class: 'cell-sub mono', text: k.masked_key })]),
          },
          { key: 'scopes', label: 'Access', render: (k) => k.scopes.join(', ') },
          { key: 'created', label: 'Created', render: (k) => dateCell(k.created_at) },
          { key: 'used', label: 'Last used', render: (k) => dateCell(k.last_used_at, { withTime: true }) },
          {
            key: 'status', label: 'Status',
            render: (k) => el('span', {
              class: `pill ${k.status === 'active' ? 'pill-ok' : k.status === 'expired' ? 'pill-warn' : 'pill-neutral'}`,
            }, k.status.charAt(0).toUpperCase() + k.status.slice(1)),
          },
          {
            key: 'actions', label: 'Actions', align: 'right',
            render: (k) => k.status === 'active' && can('apikeys.write')
              ? el('button', {
                  type: 'button', class: 'btn btn-sm btn-danger',
                  onClick: async () => {
                    const ok = await confirmDialog({
                      title: `Revoke "${k.name}"?`,
                      message: 'Anything using this key stops working immediately. This cannot be undone.',
                      confirmLabel: 'Revoke key',
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await api.revokeApiKey(k.id);
                      toastOk('Key revoked.');
                      load();
                    } catch (err) { toastError(err.message); }
                  },
                }, ['Revoke', el('span', { class: 'visually-hidden' }, ` ${k.name}`)])
              : el('span', { class: 'muted' }, '—'),
          },
        ],
        rows: response.data,
        emptyMessage: 'No API keys yet.',
      }));
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load API keys' }));
    }
  };

  container.append(
    el('p', { class: 'breadcrumb' }, [el('a', { href: '#/settings' }, 'Settings'), ' / API keys']),
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'API keys' }),
        el('p', { text: 'For other systems that need to read from or write to this loaner pool.' }),
      ]),
      el('div', { class: 'btn-group' }, [
        el('a', { class: 'btn', href: '/api/v1/openapi.json', target: '_blank', rel: 'noopener' }, 'OpenAPI spec'),
        can('apikeys.write') && session.user?.role === 'admin'
          ? el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openKeyDialog(load) }, 'Create key')
          : null,
      ]),
    ]),
    results,
  );

  load();
  return container;
}

async function openKeyDialog(onDone) {
  const nameField = field({
    name: 'name', label: 'What is this key for?', required: true,
    help: 'For example: "Case management system" or "Nightly reporting job".',
  });

  const scopeField = field({
    name: 'scopes', label: 'Access level', type: 'select', value: 'read',
    options: [
      { value: 'read', label: 'Read only — can list and view' },
      { value: 'write', label: 'Read and write — can also check devices in and out' },
      { value: 'admin', label: 'Full access — including settings and staff' },
    ],
    help: 'Choose the least access the integration actually needs.',
  });

  const expiryField = field({
    name: 'expires_in_days', label: 'Expires after (days)', type: 'number', min: 1, max: 3650,
    help: 'Leave blank for a key that never expires.',
  });

  return modal({
    title: 'Create an API key',
    body: el('div', {}, [nameField, scopeField, expiryField]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Create key',
        class: 'btn-primary',
        onClick: async (close) => {
          nameField.setError(null);
          const name = nameField.control.value.trim();
          if (!name) {
            nameField.setError('Give the key a name so you can recognise it later.');
            nameField.control.focus();
            return;
          }

          try {
            const result = await api.createApiKey({
              name,
              scopes: [scopeField.control.value],
              expires_in_days: expiryField.control.value ? Number(expiryField.control.value) : null,
            });
            close(true);
            showKeyOnce(result);
            onDone?.();
          } catch (err) { toastError(err.message); }
        },
      },
    ],
  });
}

/** The one and only time the plaintext key can be shown. */
function showKeyOnce(result) {
  const keyBox = el('p', { class: 'key-reveal', text: result.key });

  modal({
    title: 'Copy this key now',
    body: el('div', {}, [
      alertBox(result.warning, { type: 'warn', title: 'It cannot be shown again' }),
      el('p', { class: 'label' }, `Key for "${result.api_key.name}"`),
      keyBox,
      el('button', {
        type: 'button', class: 'btn',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(result.key);
            toastOk('Key copied to the clipboard.');
          } catch {
            // Clipboard access can be blocked; the key is selectable either way.
            toastWarn('Could not copy automatically — select the key and copy it manually.');
          }
        },
      }, 'Copy to clipboard'),
      el('h3', { text: 'How to use it' }),
      el('p', { class: 'mono key-reveal' },
        `curl -H "Authorization: Bearer ${result.key.slice(0, 14)}…" \\\n  ${window.location.origin}/api/v1/devices`),
    ]),
    actions: [{ label: 'I have copied it', class: 'btn-primary', value: true }],
  });

  announce('API key created. Copy it now — it cannot be shown again.', { assertive: true });
}
