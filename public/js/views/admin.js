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
              toastOk(`Test sent from ${result.sender} to ${result.recipient}. Check the inbox.`);
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
     'Prevents equipment leaving with nobody recorded as responsible.'],
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

  const policyButton = el('button', { type: 'submit', class: 'btn btn-primary', disabled: readOnly }, 'Save policy');

  const policyForm = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      await withBusy(policyButton, 'Saving…', async () => {
        const updates = {
          'loans.max_per_client': Number(maxPerClient.control.value),
          'scan.remote_enabled': remoteScan.checked,
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

    el('section', { class: 'card', 'aria-labelledby': 'notify-heading' }, [
      el('h2', { id: 'notify-heading', text: 'What triggers an email' }), notifyForm,
    ]),

    el('section', { class: 'card', 'aria-labelledby': 'policy-heading' }, [
      el('h2', { id: 'policy-heading', text: 'Loan policy' }), policyForm,
    ]),

    agreementsSection(settings, readOnly),
    photosSection(settings, readOnly),
    schedulerSection(),
  );

  return container;
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
    ['photos.enabled', 'Allow condition photos', 'Off by default. Photographing equipment is a data-protection decision to make deliberately.'],
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

function schedulerSection() {
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
          el('button', {
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
          el('button', {
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
