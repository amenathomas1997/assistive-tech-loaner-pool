/**
 * Loans: browsing, the loan record with its timeline, and the check-out /
 * check-in dialogs shared with the device list and the scan station.
 */

import { api, downloadUrl } from '../api.js';
import {
  el, clear, mount, field, dataTable, dateCell, pill, emptyState, pagination, modal,
  toastOk, toastError, toastWarn, announce, debounce, loadingBlock,
  alert as alertBox, formatDate, relativeDays, confirmDialog,
} from '../ui.js';
import { can } from '../app.js';
import { photoPicker, signaturePad } from '../capture.js';

const LOAN_FILTERS = [
  { value: '', label: 'All loans' },
  { value: 'active', label: 'Currently out' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'due_soon', label: 'Due soon' },
  { value: 'returned', label: 'Returned' },
  { value: 'cancelled', label: 'Cancelled' },
];

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function renderLoans() {
  const container = el('div');
  const results = el('div');

  // Deep links like #/loans?status=overdue come from the dashboard tiles.
  const initialStatus = new URLSearchParams(window.location.hash.split('?')[1] || '').get('status') || 'active';
  const state = { page: 1, search: '', status: initialStatus };

  const searchField = field({
    name: 'search', label: 'Search', type: 'search',
    placeholder: 'Reference, device, client, technician…',
  });
  searchField.classList.add('field-grow');

  const statusField = field({
    name: 'status', label: 'Show', type: 'select', value: state.status, options: LOAN_FILTERS,
  });

  const load = async () => {
    clear(results).append(loadingBlock('Loading loans…'));
    try {
      const response = await api.loans({
        page: state.page, per_page: 25, search: state.search, status: state.status,
      });

      clear(results).append(
        dataTable({
          caption: 'Loan records',
          columns: [
            {
              key: 'reference', label: 'Reference',
              render: (loan) => el('a', { class: 'mono', href: `#/loans/${loan.id}` }, loan.reference),
            },
            {
              key: 'device', label: 'Device',
              render: (loan) => el('span', {}, [
                loan.device_name,
                el('span', { class: 'cell-sub mono', text: loan.device_barcode }),
              ]),
            },
            { key: 'holder', label: 'Held by', render: (loan) => loan.holder_summary },
            {
              key: 'out', label: 'Taken out', render: (loan) => dateCell(loan.checked_out_at),
            },
            {
              key: 'due', label: 'Due back',
              render: (loan) => loan.due_at
                ? el('span', {}, [
                    dateCell(loan.due_at),
                    loan.status === 'active'
                      ? el('span', {
                          class: 'cell-sub',
                          text: loan.is_overdue ? `${loan.days_overdue} days late` : relativeDays(loan.due_at),
                        })
                      : null,
                  ])
                : el('span', { class: 'muted' }, 'Open ended'),
            },
            {
              key: 'status', label: 'Status',
              render: (loan) => pill(loan.is_overdue ? 'overdue' : loan.status, 'loan'),
            },
            {
              key: 'actions', label: 'Actions', align: 'right',
              render: (loan) => loan.status === 'active' && can('loans.write')
                ? el('button', {
                    type: 'button', class: 'btn btn-sm',
                    onClick: () => openCheckinDialog({ loan, onDone: load }),
                  }, ['Check in', el('span', { class: 'visually-hidden' }, ` ${loan.device_name}`)])
                : el('span', { class: 'muted' }, '—'),
            },
          ],
          rows: response.data,
          rowClass: (loan) => (loan.is_overdue ? 'row-danger' : null),
          emptyMessage: 'No loans match these filters.',
        }),
        pagination(response.meta, (page) => { state.page = page; load(); }),
      );

      announce(`${response.meta.total} loan${response.meta.total === 1 ? '' : 's'} found.`);
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load loans' }));
    }
  };

  const runFilter = debounce(() => { state.page = 1; load(); });
  searchField.control.addEventListener('input', (e) => { state.search = e.target.value; runFilter(); });
  statusField.control.addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Loans' }),
        el('p', { text: 'Every device that has gone out, and when it is due back.' }),
      ]),
      el('div', { class: 'btn-group' }, [
        el('a', { class: 'btn', href: downloadUrl('/loans/export.csv', { status: state.status }) }, 'Export CSV'),
        can('loans.write') ? el('a', { class: 'btn btn-primary', href: '#/scan' }, 'Check out / in') : null,
      ]),
    ]),

    el('form', {
      class: 'filters', role: 'search', 'aria-label': 'Filter loans',
      onSubmit: (e) => e.preventDefault(),
    }, [searchField, statusField]),

    results,
  );

  load();
  return container;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function renderLoanDetail({ params }) {
  const { loan } = await api.loan(params.id);

  const [agreement, attachments, groupLoans] = await Promise.all([
    api.agreement(loan.id).then((r) => r.agreement).catch(() => null),
    api.loanAttachments(loan.id).then((r) => r.data).catch(() => []),
    loan.group_ref ? api.loanGroup(loan.group_ref).then((r) => r.loans).catch(() => []) : Promise.resolve([]),
  ]);

  const container = el('div');

  const rerender = async () => {
    container.replaceWith(await renderLoanDetail({ params }));
  };

  const isActive = loan.status === 'active';

  mount(container,
    el('p', { class: 'breadcrumb' }, [el('a', { href: '#/loans' }, 'Loans'), ' / ', loan.reference]),

    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: loan.device_name }),
        el('p', { class: 'mono', text: `${loan.reference} · ${loan.device_barcode}` }),
      ]),
      el('div', { class: 'btn-group' }, isActive && can('loans.write') ? [
        el('button', {
          type: 'button', class: 'btn btn-primary',
          onClick: () => openCheckinDialog({ loan, onDone: rerender }),
        }, 'Check in'),
        el('button', {
          type: 'button', class: 'btn',
          onClick: () => openAdjustDialog({ loan, mode: 'extend', onDone: rerender }),
        }, 'Extend'),
        el('button', {
          type: 'button', class: 'btn',
          onClick: () => openAdjustDialog({ loan, mode: 'reduce', onDone: rerender }),
        }, 'Bring forward'),
        can('loans.cancel') ? el('button', {
          type: 'button', class: 'btn btn-danger',
          onClick: async () => {
            const reason = await promptReason(
              'Cancel this loan?',
              'Cancelling means this loan should not have happened — the device returns to the pool ' +
              'and the loan is not counted in usage figures. To record a normal return, use Check in instead.',
            );
            if (reason === null) return;
            try {
              await api.cancelLoan(loan.id, { reason });
              toastOk('Loan cancelled and the device returned to the pool.');
              rerender();
            } catch (err) { toastError(err.message); }
          },
        }, 'Cancel loan') : null,
      ] : []),
    ]),

    loan.is_overdue
      ? alertBox(
          `This loan is ${loan.days_overdue} day${loan.days_overdue === 1 ? '' : 's'} overdue. ` +
          `It was due back on ${formatDate(loan.due_at)}.`,
          { type: 'danger', title: 'Overdue' })
      : null,

    el('div', { class: 'grid grid-2' }, [
      el('section', { class: 'card', 'aria-labelledby': 'loan-details' }, [
        el('h2', { id: 'loan-details', text: 'Loan' }),
        el('dl', { class: 'detail-list' }, [
          el('dt', { text: 'Status' }),
          el('dd', {}, pill(loan.is_overdue ? 'overdue' : loan.status, 'loan')),
          el('dt', { text: 'Device' }),
          el('dd', {}, el('a', { href: `#/devices/${loan.device_id}` }, loan.device_name)),
          el('dt', { text: 'Client' }), detailValue(loan.client_name),
          el('dt', { text: 'Technician' }), detailValue(loan.tech_name),
          el('dt', { text: 'Program' }), detailValue(loan.program_name),
          el('dt', { text: 'Loan period' }),
          detailValue(loan.period_name ? `${loan.period_name}${loan.period_days ? ` (${loan.period_days} days)` : ''}` : 'Custom'),
          el('dt', { text: 'Taken out' }), el('dd', {}, dateCell(loan.checked_out_at, { withTime: true })),
          el('dt', { text: 'Due back' }),
          loan.due_at ? el('dd', {}, dateCell(loan.due_at)) : el('dd', { class: 'muted' }, 'Open ended'),
          el('dt', { text: 'Returned' }), el('dd', {}, dateCell(loan.returned_at, { withTime: true })),
          el('dt', { text: 'Extensions used' }),
          detailValue(`${loan.extension_count}${loan.period_max_extensions ? ` of ${loan.period_max_extensions}` : ''}`),
          el('dt', { text: 'Issued by' }), detailValue(loan.checked_out_by_name),
          el('dt', { text: 'Checked in by' }), detailValue(loan.checked_in_by_name),
          el('dt', { text: 'Condition out' }), detailValue(loan.condition_out),
          el('dt', { text: 'Condition in' }), detailValue(loan.condition_in),
          el('dt', { text: 'Notes' }), detailValue(loan.notes),
        ]),
      ]),

      el('section', { class: 'card', 'aria-labelledby': 'loan-agreement' }, [
        el('div', { class: 'card-header' }, [
          el('h2', { id: 'loan-agreement', text: 'Loan agreement' }),
          agreement
            ? el('a', {
                class: 'btn btn-sm', target: '_blank', rel: 'noopener',
                href: `/api/v1/agreements/${loan.id}/print`,
              }, 'Print')
            : can('loans.write')
              ? el('button', {
                  type: 'button', class: 'btn btn-sm btn-primary',
                  onClick: () => openAgreementDialog({ loan, onDone: rerender }),
                }, 'Capture signature')
              : null,
        ]),
        agreement
          ? el('div', {}, [
              el('dl', { class: 'detail-list' }, [
                el('dt', { text: 'Signed by' }), el('dd', { text: agreement.signed_by_name }),
                el('dt', { text: 'Signing as' }), el('dd', { text: agreement.signed_by_role }),
                el('dt', { text: 'Method' }), el('dd', { text: agreement.signature_method }),
                el('dt', { text: 'Signed' }), el('dd', {}, dateCell(agreement.signed_at, { withTime: true })),
                el('dt', { text: 'Witnessed by' }), el('dd', { text: agreement.witness_name || '—' }),
              ]),
              agreement.was_waived
                ? alertBox(
                    `Went out without a signature: ${agreement.waived_reason}`,
                    { type: 'warn', title: 'Signature waived' })
                : null,
              agreement.signature_url
                ? el('img', {
                    class: 'signature-preview',
                    src: agreement.signature_url,
                    alt: `Signature of ${agreement.signed_by_name}`,
                  })
                : agreement.typed_signature
                  ? el('p', { class: 'key-reveal', text: agreement.typed_signature })
                  : null,
            ])
          : el('p', { class: 'muted' },
              'No agreement has been captured for this loan.'),
      ]),

      el('section', { class: 'card', 'aria-labelledby': 'loan-timeline' }, [
        el('h2', { id: 'loan-timeline', text: 'Timeline' }),
        el('ol', { class: 'timeline' }, (loan.timeline || []).map((event) =>
          el('li', { class: timelineClass(event.event_type) }, [
            el('strong', { text: describeEvent(event) }),
            el('div', { class: 'timeline-time' },
              `${formatDate(event.created_at, { withTime: true })}${event.actor_name ? ` · ${event.actor_name}` : ''}`),
            event.notes ? el('p', { class: 'muted', style: { margin: '4px 0 0' }, text: event.notes }) : null,
          ]))),
      ]),
    ]),

    // --- Kit group ---------------------------------------------------------
    groupLoans.length > 1
      ? el('section', { class: 'card', 'aria-labelledby': 'group-heading' }, [
          el('div', { class: 'card-header' }, [
            el('h2', { id: 'group-heading', text: 'Issued together as a kit' }),
            can('loans.write') && groupLoans.some((l) => l.status === 'active')
              ? el('button', {
                  type: 'button', class: 'btn btn-sm btn-primary',
                  onClick: async () => {
                    try {
                      const result = await api.checkInGroup(loan.group_ref, {});
                      toastOk(`${result.returned.length} device(s) checked in.`);
                      rerender();
                    } catch (err) { toastError(err.message); }
                  },
                }, 'Check the whole kit in')
              : null,
          ]),
          el('p', { class: 'muted mono', text: loan.group_ref }),
          dataTable({
            caption: 'Devices issued in this group',
            columns: [
              { key: 'reference', label: 'Loan', render: (l) => el('a', { class: 'mono', href: `#/loans/${l.id}` }, l.reference) },
              { key: 'device_name', label: 'Device' },
              { key: 'status', label: 'Status', render: (l) => pill(l.status, 'loan') },
              { key: 'due_at', label: 'Due', render: (l) => dateCell(l.due_at) },
              { key: 'returned_at', label: 'Returned', render: (l) => dateCell(l.returned_at) },
            ],
            rows: groupLoans,
          }),
        ])
      : null,

    // --- Condition photos --------------------------------------------------
    attachments.filter((a) => a.kind === 'condition_photo').length
      ? el('section', { class: 'card', 'aria-labelledby': 'photos-heading' }, [
          el('h2', { id: 'photos-heading', text: 'Condition photos' }),
          ...['out', 'in'].map((phase) => {
            const forPhase = attachments.filter((a) => a.kind === 'condition_photo' && a.phase === phase);
            if (!forPhase.length) return null;
            return el('div', {}, [
              el('h3', { text: phase === 'out' ? 'When it went out' : 'When it came back' }),
              el('ul', { class: 'thumb-list' }, forPhase.map((a) =>
                el('li', {}, [
                  el('a', { href: a.url, target: '_blank', rel: 'noopener' },
                    el('img', {
                      src: a.url,
                      alt: a.caption || `Condition photo taken at check-${phase} by ${a.uploaded_by_name || 'staff'}`,
                    })),
                ]))),
            ]);
          }),
        ])
      : null,
  );

  return container;
}

const detailValue = (value) =>
  el('dd', value ? { text: String(value) } : { class: 'muted', text: '—' });

function timelineClass(type) {
  if (['cancel', 'overdue_notice'].includes(type)) return 'is-danger';
  if (['checkin'].includes(type)) return 'is-ok';
  return null;
}

function describeEvent(event) {
  switch (event.event_type) {
    case 'checkout': return 'Checked out';
    case 'checkin': return 'Checked in';
    case 'extend': return `Extended to ${formatDate(event.new_due_at)}`;
    case 'reduce': return `Return brought forward to ${formatDate(event.new_due_at)}`;
    case 'cancel': return 'Loan cancelled';
    case 'transfer': return 'Transferred to a new holder';
    case 'due_soon_notice': return 'Reminder sent';
    case 'overdue_notice': return 'Overdue notice sent';
    default: return event.event_type;
  }
}

// ---------------------------------------------------------------------------
// Check-out dialog
// ---------------------------------------------------------------------------

/**
 * `device` may be a full device object (from a list or a scan) or null, in
 * which case the barcode field is shown for typing or scanning into.
 */
export async function openCheckoutDialog({ device = null, onDone = null } = {}) {
  const [periodsResponse, clientsResponse, programsResponse, usersResponse, settings, agreementSettings] =
    await Promise.all([
      api.loanPeriods(),
      can('clients.read') ? api.clients({ per_page: 200 }) : Promise.resolve({ data: [] }),
      can('programs.read') ? api.programs() : Promise.resolve({ data: [] }),
      can('users.read') ? api.users({ role: 'tech' }) : Promise.resolve({ data: [] }),
      api.settings().catch(() => ({ settings: {} })),
      api.agreementSettings().catch(() => ({ enabled: false })),
    ]);

  const config = settings.settings || {};
  const photosEnabled = Boolean(config['photos.enabled'] && config['photos.prompt_on_checkout']);

  // The accessory checklist only exists once a device is known.
  const accessories = device ? await api.accessories(device.id).then((r) => r.data).catch(() => []) : [];

  const periods = periodsResponse.data;
  const defaultPeriod = periods.find((p) => p.is_default) || periods[0];

  const barcodeField = field({
    name: 'device', label: 'Device barcode', required: true,
    value: device?.barcode || '',
    help: 'Scan the label, or type the barcode.',
    autocomplete: 'off',
  });

  const clientField = field({
    name: 'client_id', label: 'Client', type: 'select',
    options: [{ value: '', label: 'No client' },
      ...clientsResponse.data.map((c) => ({ value: c.id, label: `${c.full_name}${c.external_ref ? ` (${c.external_ref})` : ''}` }))],
  });

  const techField = field({
    name: 'tech_id', label: 'Technician', type: 'select',
    options: [{ value: '', label: 'No technician' },
      ...usersResponse.data.map((u) => ({ value: u.id, label: u.full_name }))],
  });

  const programField = field({
    name: 'program_id', label: 'Program', type: 'select',
    options: [{ value: '', label: 'No program' },
      ...programsResponse.data.map((p) => ({ value: p.id, label: p.name }))],
  });

  const periodField = field({
    name: 'loan_period_id', label: 'Loan period', type: 'select',
    value: defaultPeriod?.id || '',
    options: [
      ...periods.map((p) => ({
        value: p.id,
        label: `${p.name} — ${p.days === 0 ? 'no due date' : `${p.days} days`}`,
      })),
      { value: 'custom', label: 'Custom length…' },
    ],
  });

  const customDaysField = field({
    name: 'custom_days', label: 'Custom length in days', type: 'number', min: 0, max: 3650,
    value: 14, help: 'Enter 0 for a loan with no return date.',
  });
  customDaysField.hidden = true;

  periodField.control.addEventListener('change', (e) => {
    customDaysField.hidden = e.target.value !== 'custom';
    if (!customDaysField.hidden) customDaysField.control.focus();
  });

  const conditionField = field({ name: 'condition_out', label: 'Condition going out', value: 'Good' });
  const notesField = field({ name: 'notes', label: 'Notes', type: 'textarea' });

  // --- Accessory checklist -------------------------------------------------
  const accessoryBoxes = {};
  const accessorySection = accessories.length
    ? el('fieldset', {}, [
        el('legend', {}, 'What is going out with it?'),
        el('p', {
          class: 'field-help',
          style: { marginBottom: '8px' },
          text: 'Tick what physically leaves. Anything ticked here is checked again on return.',
        }),
        ...accessories.map((accessory) => {
          const id = `acc-out-${accessory.id}`;
          const box = el('input', { type: 'checkbox', id, checked: Boolean(accessory.required) });
          accessoryBoxes[accessory.name] = box;
          return el('label', { class: 'checkbox', for: id }, [
            box,
            el('span', {}, [
              accessory.name,
              accessory.required
                ? el('span', { class: 'option-help' }, 'Normally goes out with this device')
                : null,
            ]),
          ]);
        }),
      ])
    : null;

  // --- Optional condition photos -------------------------------------------
  const photos = photosEnabled
    ? photoPicker({
        label: 'Condition photos (optional)',
        max: Number(config['photos.max_per_phase']) || 4,
        help: 'Optional. A photo of the equipment as it leaves settles most damage questions later.',
      })
    : null;

  const holderWarning = el('div');

  const validateHolders = () => {
    clear(holderWarning);
    const none = !clientField.control.value && !techField.control.value && !programField.control.value;
    if (none) {
      holderWarning.append(alertBox(
        'Choose at least one of client, technician or program — a loan needs someone responsible for it.',
        { type: 'warn' },
      ));
    }
    return !none;
  };

  for (const f of [clientField, techField, programField]) {
    f.control.addEventListener('change', validateHolders);
  }

  return modal({
    title: device ? `Check out ${device.name}` : 'Check out a device',
    wide: true,
    body: el('div', {}, [
      device
        ? el('div', { class: 'card', style: { background: 'var(--surface-alt)', marginBottom: '14px' } }, [
            el('strong', { text: device.name }),
            el('p', { class: 'mono', style: { margin: '2px 0 0' }, text: device.barcode }),
          ])
        : barcodeField,
      el('h3', { text: 'Who is taking it?' }),
      el('p', {
        class: 'field-help',
        style: { marginBottom: '10px' },
        text: 'A device can be assigned to any combination of these — for example a client and a technician at once.',
      }),
      el('div', { class: 'form-grid' }, [clientField, techField]),
      programField,
      holderWarning,
      el('h3', { text: 'For how long?' }),
      periodField,
      customDaysField,
      el('div', { class: 'form-grid' }, [conditionField]),
      accessorySection,
      photos,
      notesField,
      agreementSettings.enabled
        ? alertBox(
            agreementSettings.required
              ? 'A loan agreement is required. You will be asked to capture a signature once the loan is created.'
              : 'You can capture a signed loan agreement after creating this loan.',
            { type: 'info', title: 'Loan agreement' })
        : null,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Check out',
        class: 'btn-primary',
        onClick: async (close) => {
          if (!validateHolders()) {
            clientField.control.focus();
            return;
          }

          const body = {
            device: device ? device.barcode : barcodeField.control.value.trim(),
            client_id: clientField.control.value || null,
            tech_id: techField.control.value || null,
            program_id: programField.control.value || null,
            condition_out: conditionField.control.value || null,
            notes: notesField.control.value || null,
            scanned: Boolean(device),
          };

          if (periodField.control.value === 'custom') {
            body.custom_days = Number(customDaysField.control.value);
          } else {
            body.loan_period_id = periodField.control.value || null;
          }

          if (!body.device) {
            barcodeField.setError('Scan or type a device barcode.');
            barcodeField.control.focus();
            return;
          }

          if (accessories.length) {
            body.accessories = Object.fromEntries(
              Object.entries(accessoryBoxes).map(([name, box]) => [name, box.checked]),
            );
          }

          try {
            const result = await api.checkOut(body);
            const due = result.loan.due_at
              ? `Due back ${formatDate(result.loan.due_at)}.`
              : 'No return date (open-ended loan).';

            toastOk(`${result.loan.device_name} checked out. ${due}`, result.loan.reference);
            announce(`Checked out ${result.loan.device_name}. ${due}`, { assertive: true });

            // Photos are attached after the loan exists, and never block it:
            // the device has already gone out by this point.
            if (photos && photos.count()) {
              try {
                await api.attachPhotos(result.loan.id, 'out', photos.getImages());
              } catch (err) {
                toastWarn(`The loan was recorded, but the photos did not attach: ${err.message}`);
              }
            }

            if (result.notification && !result.notification.sent && result.notification.reason
                && !result.notification.reason.includes('switched off')) {
              toastWarn(`The loan was recorded, but no email was sent: ${result.notification.reason}`);
            }

            close(result.loan);

            if (agreementSettings.enabled) {
              await openAgreementDialog({
                loan: result.loan,
                required: agreementSettings.required,
                allowWaive: agreementSettings.allowWaive,
              });
            }

            onDone?.(result.loan);
          } catch (err) {
            if (err.field === 'device' || err.code === 'not_found') {
              barcodeField.setError?.(err.message);
              barcodeField.control?.focus();
            }
            toastError(err.message);
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Loan agreement
// ---------------------------------------------------------------------------

/**
 * Capture a signature against a loan that already exists.
 *
 * Shown after check-out, and reachable again from the loan screen if it was
 * skipped. Never blocks the loan itself — the equipment has already changed
 * hands by the time this opens, and refusing to record that would be worse
 * than an unsigned agreement.
 */
export async function openAgreementDialog({ loan, required = false, allowWaive = true, onDone = null }) {
  let preview;
  try {
    preview = await api.agreementPreview(loan.id);
  } catch (err) {
    toastError(`Could not load the agreement wording: ${err.message}`);
    return null;
  }

  const nameField = field({
    name: 'signed_by_name', label: 'Who is signing?', required: true,
    value: loan.client_name || '', autocomplete: 'name',
  });

  const roleField = field({
    name: 'signed_by_role', label: 'Signing as', type: 'select', value: 'client',
    options: [
      { value: 'client', label: 'The client' },
      { value: 'guardian', label: 'A parent or guardian' },
      { value: 'counselor', label: 'The counselor' },
      { value: 'technician', label: 'A technician' },
      { value: 'other', label: 'Someone else' },
    ],
  });

  const pad = signaturePad({ allowWaive, signerName: loan.client_name || '' });

  const result = await modal({
    title: `Loan agreement — ${loan.reference}`,
    wide: true,
    body: el('div', {}, [
      required
        ? alertBox('This organisation requires a signed agreement for every loan.', { type: 'warn' })
        : null,
      el('h3', { text: 'Agreement' }),
      el('div', {
        class: 'key-reveal',
        style: { whiteSpace: 'pre-wrap', fontFamily: 'inherit', maxHeight: '220px', overflowY: 'auto' },
        text: preview.text,
      }),
      preview.accessories?.length
        ? el('p', { class: 'field-help' },
            `Includes: ${preview.accessories.map((a) => a.name).join(', ')}.`)
        : null,
      el('hr', { class: 'divider' }),
      el('div', { class: 'form-grid' }, [nameField, roleField]),
      pad,
    ]),
    actions: [
      { label: required ? 'Skip for now' : 'Not now', class: 'btn-ghost', value: null },
      {
        label: 'Record agreement',
        class: 'btn-primary',
        onClick: async (close) => {
          nameField.setError(null);

          const name = nameField.control.value.trim();
          if (!name) {
            nameField.setError('Enter the name of the person signing.');
            nameField.control.focus();
            return;
          }

          let signature;
          try {
            signature = pad.value();
          } catch (err) {
            toastError(err.message);
            return;
          }

          try {
            const response = await api.signAgreement(loan.id, {
              signed_by_name: name,
              signed_by_role: roleField.control.value,
              ...signature,
            });
            toastOk(
              signature.signature_method === 'waived'
                ? 'Recorded that this loan went out without a signature.'
                : 'Agreement signed and stored against the loan.',
            );
            close(response.agreement);
            onDone?.(response.agreement);
          } catch (err) {
            toastError(err.message);
          }
        },
      },
    ],
  });

  if (!result && required) {
    toastWarn(
      `Loan ${loan.reference} has no signed agreement. You can capture one from the loan screen at any time.`,
      'Agreement still needed',
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Check-in dialog
// ---------------------------------------------------------------------------

export async function openCheckinDialog({ device = null, loan = null, onDone = null } = {}) {
  const conditionField = field({
    name: 'condition_in', label: 'Condition coming back', value: 'Good',
    help: 'Note any damage here — it stays on the device record.',
  });

  const needsRepairBox = el('input', { type: 'checkbox', id: 'needs-repair' });
  const notesField = field({ name: 'notes', label: 'Notes', type: 'textarea' });

  const title = device?.name || loan?.device_name || 'this device';
  const deviceId = device?.id || loan?.device_id;

  const [settingsResponse, accessories] = await Promise.all([
    api.settings().catch(() => ({ settings: {} })),
    deviceId ? api.accessories(deviceId).then((r) => r.data).catch(() => []) : Promise.resolve([]),
  ]);

  const config = settingsResponse.settings || {};
  const photosEnabled = Boolean(config['photos.enabled'] && config['photos.prompt_on_checkin']);

  // What went out, so the check-in list defaults to those items.
  const wentOut = (() => {
    try { return loan?.accessories_out ? JSON.parse(loan.accessories_out) : null; } catch { return null; }
  })();

  const accessoryBoxes = {};
  const accessorySection = accessories.length
    ? el('fieldset', {}, [
        el('legend', {}, 'What came back?'),
        el('p', {
          class: 'field-help', style: { marginBottom: '8px' },
          text: 'Anything left unticked that went out is recorded as not returned.',
        }),
        ...accessories.map((accessory) => {
          const id = `acc-in-${accessory.id}`;
          const expected = wentOut ? Boolean(wentOut[accessory.name]) : Boolean(accessory.required);
          const box = el('input', { type: 'checkbox', id, checked: expected });
          accessoryBoxes[accessory.name] = box;
          return el('label', { class: 'checkbox', for: id }, [
            box,
            el('span', {}, [
              accessory.name,
              expected ? el('span', { class: 'option-help' }, 'Went out with the device') : null,
            ]),
          ]);
        }),
      ])
    : null;

  const photos = photosEnabled
    ? photoPicker({
        label: 'Condition photos (optional)',
        max: Number(config['photos.max_per_phase']) || 4,
        help: 'Optional. Photograph any damage now, while the device is in front of you.',
      })
    : null;

  return modal({
    title: `Check in ${title}`,
    body: el('div', {}, [
      loan?.due_at && new Date(loan.due_at) < new Date()
        ? alertBox(
            `This device is coming back late — it was due on ${formatDate(loan.due_at)}.`,
            { type: 'warn', title: 'Returned late' })
        : null,
      conditionField,
      accessorySection,
      el('label', { class: 'checkbox', for: 'needs-repair' }, [
        needsRepairBox,
        el('span', {}, [
          'Send to maintenance instead of back on the shelf',
          el('span', { class: 'option-help' }, 'Use this if the device is damaged or needs servicing before it goes out again.'),
        ]),
      ]),
      photos,
      notesField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Check in',
        class: 'btn-primary',
        onClick: async (close) => {
          try {
            const body = {
              device: device?.barcode || null,
              loan_id: loan?.id || null,
              condition_in: conditionField.control.value || null,
              notes: notesField.control.value || null,
              device_status: needsRepairBox.checked ? 'maintenance' : 'available',
              scanned: Boolean(device),
            };

            if (accessories.length) {
              body.accessories = Object.fromEntries(
                Object.entries(accessoryBoxes).map(([name, box]) => [name, box.checked]),
              );
            }

            const result = await api.checkIn(body);

            const message = result.wasOverdue
              ? `Checked in — it was ${result.daysLate} day(s) late.`
              : 'Checked in.';

            toastOk(`${result.device.name}. ${message}`);
            announce(`${result.device.name} checked in. ${message}`, { assertive: true });

            if (result.warning) toastWarn(result.warning, 'Accessories missing');

            // Someone was waiting for this device, and has just been told.
            if (result.promoted_reservation) {
              toastOk(
                `${result.promoted_reservation.requester_name} was next on the waitlist and has been ` +
                'notified. The device is being held for them.',
                'Waitlist',
              );
            }

            if (photos && photos.count() && result.loan?.id) {
              try {
                await api.attachPhotos(result.loan.id, 'in', photos.getImages());
              } catch (err) {
                toastWarn(`The return was recorded, but the photos did not attach: ${err.message}`);
              }
            }

            close(result);
            onDone?.(result);
          } catch (err) {
            toastError(err.message);
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Extend / reduce
// ---------------------------------------------------------------------------

async function openAdjustDialog({ loan, mode, onDone }) {
  const isExtend = mode === 'extend';

  const daysField = field({
    name: 'days', label: isExtend ? 'Extend by (days)' : 'Bring forward by (days)',
    type: 'number', min: 1, max: 3650, value: isExtend ? 14 : 7,
  });
  const reasonField = field({ name: 'reason', label: 'Reason', type: 'textarea' });

  return modal({
    title: isExtend ? `Extend ${loan.reference}` : `Bring forward ${loan.reference}`,
    body: el('div', {}, [
      el('p', {
        text: loan.due_at
          ? `Currently due back on ${formatDate(loan.due_at)}.`
          : 'This loan currently has no return date.',
      }),
      isExtend && loan.period_max_extensions
        ? el('p', {
            class: 'field-help',
            text: `${loan.extension_count} of ${loan.period_max_extensions} extensions used for this loan period.`,
          })
        : null,
      daysField,
      reasonField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: isExtend ? 'Extend loan' : 'Bring forward',
        class: 'btn-primary',
        onClick: async (close) => {
          const body = { days: Number(daysField.control.value), reason: reasonField.control.value || null };
          try {
            const result = isExtend
              ? await api.extendLoan(loan.id, body)
              : await api.reduceLoan(loan.id, body);

            toastOk(`Now due back ${formatDate(result.loan.due_at)}.`);
            close(true);
            onDone?.();
          } catch (err) {
            toastError(err.message);
          }
        },
      },
    ],
  });
}

/** Small prompt for a free-text reason. Returns null if dismissed. */
async function promptReason(title, message) {
  const reasonField = field({ name: 'reason', label: 'Reason', type: 'textarea', required: true });

  return modal({
    title,
    body: el('div', {}, [el('p', { text: message }), reasonField]),
    actions: [
      { label: 'Keep the loan', class: 'btn-ghost', value: null },
      {
        label: 'Cancel the loan',
        class: 'btn-danger',
        onClick: (close) => {
          const value = reasonField.control.value.trim();
          if (!value) {
            reasonField.setError('Give a reason so the audit log explains what happened.');
            reasonField.control.focus();
            return;
          }
          close(value);
        },
      },
    ],
  });
}
