/**
 * Kits, waitlist and repairs.
 */

import { api, allPages } from '../api.js';
import {
  el, clear, mount, field, dataTable, dateCell, pill, emptyState, pagination, modal,
  toastOk, toastError, toastWarn, announce, debounce, loadingBlock,
  alert as alertBox, formatDate, confirmDialog, withBusy,
} from '../ui.js';
import { can, session } from '../app.js';
import { photoPicker } from '../capture.js';

// ===========================================================================
// Kits
// ===========================================================================

export async function renderKits() {
  const container = el('div');
  const results = el('div');

  const load = async () => {
    clear(results).append(loadingBlock('Loading kits…'));
    try {
      const response = await api.kits({ include_inactive: true });

      if (!response.data.length) {
        clear(results).append(emptyState({
          icon: '🧰',
          title: 'No kits yet',
          message:
            'A kit bundles several tracked devices that normally go out together — an assessment ' +
            'set, for example. Checking one out issues a loan for each device under a single reference.',
          action: can('devices.write')
            ? el('button', {
                type: 'button', class: 'btn btn-primary', onClick: () => openKitDialog(null, load),
              }, 'Create the first kit')
            : null,
        }));
        return;
      }

      clear(results).append(...response.data.map((kit) => kitCard(kit, load)));
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load kits' }));
    }
  };

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Kits' }),
        el('p', {
          text:
            'Bundles of devices that go out together. Each device keeps its own barcode, history and ' +
            'loan record — the kit just issues and returns them in one action.',
        }),
      ]),
      can('devices.write')
        ? el('button', {
            type: 'button', class: 'btn btn-primary', onClick: () => openKitDialog(null, load),
          }, 'Create kit')
        : null,
    ]),
    results,
  );

  load();
  return container;
}

function kitCard(kit, reload) {
  const outCount = kit.items.filter((i) => i.active_loan_id).length;

  return el('section', { class: 'card', 'aria-labelledby': `kit-${kit.id}` }, [
    el('div', { class: 'card-header' }, [
      el('div', {}, [
        el('h2', { id: `kit-${kit.id}`, style: { margin: 0 } }, kit.name),
        kit.description ? el('p', { class: 'muted', style: { margin: '2px 0 0' }, text: kit.description }) : null,
      ]),
      el('div', { class: 'row' }, [
        kit.active
          ? el('span', { class: `pill ${kit.can_check_out ? 'pill-ok' : 'pill-warn'}` },
              kit.can_check_out ? 'Ready to lend' : `${outCount} of ${kit.item_count} out`)
          : el('span', { class: 'pill pill-neutral' }, 'Inactive'),
        can('loans.write') && kit.can_check_out
          ? el('button', {
              type: 'button', class: 'btn btn-primary btn-sm',
              onClick: () => openKitCheckoutDialog(kit, reload),
            }, ['Check out kit', el('span', { class: 'visually-hidden' }, ` ${kit.name}`)])
          : null,
        can('devices.write')
          ? el('button', {
              type: 'button', class: 'btn btn-sm', onClick: () => openKitDialog(kit, reload),
            }, ['Edit', el('span', { class: 'visually-hidden' }, ` ${kit.name}`)])
          : null,
      ]),
    ]),

    dataTable({
      caption: `Devices in ${kit.name}`,
      columns: [
        {
          key: 'name', label: 'Device',
          render: (item) => el('a', { href: `#/devices/${item.device_id}` }, [
            item.name,
            el('span', { class: 'cell-sub mono', text: item.barcode }),
          ]),
        },
        { key: 'category', label: 'Category', render: (item) => item.category || '—' },
        { key: 'status', label: 'Status', render: (item) => pill(item.status) },
        {
          key: 'loan', label: 'Current loan',
          render: (item) => item.active_loan_id
            ? el('a', { class: 'mono', href: `#/loans/${item.active_loan_id}` }, item.active_loan_reference)
            : el('span', { class: 'muted' }, '—'),
        },
      ],
      rows: kit.items,
      emptyMessage: 'This kit has no devices in it yet.',
    }),
  ]);
}

async function openKitDialog(kit, onDone) {
  const devicesResponse = await allPages(api.devices, { sort: 'name' });

  const nameField = field({ name: 'name', label: 'Kit name', required: true, value: kit?.name || '' });
  const descriptionField = field({
    name: 'description', label: 'Description', type: 'textarea', value: kit?.description || '',
  });

  const selected = new Set((kit?.items || []).map((i) => i.device_id));

  const list = el('div', {
    style: { maxHeight: '280px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '7px', padding: '10px' },
  }, devicesResponse.data.map((device) => {
    const id = `kit-dev-${device.id}`;
    return el('label', { class: 'checkbox', for: id }, [
      el('input', {
        type: 'checkbox', id, checked: selected.has(device.id),
        onChange: (e) => {
          if (e.target.checked) selected.add(device.id);
          else selected.delete(device.id);
        },
      }),
      el('span', {}, [
        device.name,
        el('span', { class: 'option-help' }, `${device.barcode}${device.category ? ` · ${device.category}` : ''}`),
      ]),
    ]);
  }));

  const activeBox = el('input', { type: 'checkbox', id: 'kit-active', checked: kit ? Boolean(kit.active) : true });

  return modal({
    title: kit ? `Edit ${kit.name}` : 'Create a kit',
    wide: true,
    body: el('div', {}, [
      nameField,
      descriptionField,
      el('p', { class: 'label' }, 'Devices in this kit'),
      list,
      kit ? el('label', { class: 'checkbox', for: 'kit-active', style: { marginTop: '10px' } }, [
        activeBox, el('span', {}, 'Offer this kit for check-out'),
      ]) : null,
      kit ? el('div', { class: 'row', style: { marginTop: '12px' } }, [
        el('button', {
          type: 'button', class: 'btn btn-danger btn-sm',
          onClick: async (event) => {
            // Found now: the event forgets its target once this function waits.
            const dialog = event.currentTarget.closest('dialog');

            const ok = await confirmDialog({
              title: `Delete "${kit.name}"?`,
              message: 'The kit is removed. The devices in it are unaffected and keep their history.',
              confirmLabel: 'Delete kit',
              danger: true,
            });
            if (!ok) return;
            try {
              await api.deleteKit(kit.id);
              toastOk('Kit deleted. Its devices are unaffected.');
              // Closed, or the form for a kit that no longer exists stays on
              // screen with a "Save kit" button that can only fail.
              dialog?.close();
              onDone?.();
            } catch (err) { toastError(err.message); }
          },
        }, 'Delete this kit'),
      ]) : null,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: kit ? 'Save kit' : 'Create kit',
        class: 'btn-primary',
        onClick: async (close) => {
          nameField.setError(null);
          const name = nameField.control.value.trim();
          if (!name) {
            nameField.setError('Give the kit a name.');
            nameField.control.focus();
            return;
          }

          const body = {
            name,
            description: descriptionField.control.value || null,
            device_ids: [...selected],
          };
          if (kit) body.active = activeBox.checked;

          try {
            if (kit) await api.updateKit(kit.id, body);
            else await api.createKit(body);
            toastOk(kit ? 'Kit saved.' : 'Kit created.');
            close(true);
            onDone?.();
          } catch (err) {
            if (err.field === 'name') {
              nameField.setError(err.message);
              nameField.control.focus();
            } else { toastError(err.message); }
          }
        },
      },
    ],
  });
}

async function openKitCheckoutDialog(kit, onDone) {
  const [periods, clients, programs, techs] = await Promise.all([
    api.loanPeriods(),
    can('clients.read') ? allPages(api.clients) : Promise.resolve({ data: [] }),
    can('programs.read') ? api.programs() : Promise.resolve({ data: [] }),
    can('users.read') ? api.users({ role: 'tech' }) : Promise.resolve({ data: [] }),
  ]);

  const defaultPeriod = periods.data.find((p) => p.is_default) || periods.data[0];

  const clientField = field({
    name: 'client_id', label: 'Client', type: 'select',
    options: [{ value: '', label: 'No client' },
      ...clients.data.map((c) => ({ value: c.id, label: c.full_name }))],
  });
  const techField = field({
    name: 'tech_id', label: 'Technician', type: 'select',
    options: [{ value: '', label: 'No technician' },
      ...techs.data.map((u) => ({ value: u.id, label: u.full_name }))],
  });
  const programField = field({
    name: 'program_id', label: 'Program', type: 'select',
    options: [{ value: '', label: 'No program' },
      ...programs.data.map((p) => ({ value: p.id, label: p.name }))],
  });
  const periodField = field({
    name: 'loan_period_id', label: 'Loan period', type: 'select',
    value: defaultPeriod?.id || '',
    options: periods.data.map((p) => ({
      value: p.id, label: `${p.name} — ${p.days === 0 ? 'no due date' : `${p.days} days`}`,
    })),
  });
  const notesField = field({ name: 'notes', label: 'Notes', type: 'textarea' });

  return modal({
    title: `Check out ${kit.name}`,
    wide: true,
    body: el('div', {}, [
      alertBox(
        `${kit.item_count} device(s) will be issued together under one group reference. ` +
        'Each keeps its own loan record and can be returned separately if needed.',
        { type: 'info' },
      ),
      el('ul', {}, kit.items.map((item) => el('li', {}, `${item.name} (${item.barcode})`))),
      el('div', { class: 'form-grid' }, [clientField, techField]),
      programField,
      periodField,
      notesField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Check out the kit',
        class: 'btn-primary',
        onClick: async (close) => {
          if (!clientField.control.value && !techField.control.value && !programField.control.value) {
            toastError('Choose at least one of client, technician or program.');
            return;
          }
          try {
            const result = await api.checkOutKit(kit.id, {
              client_id: clientField.control.value || null,
              tech_id: techField.control.value || null,
              program_id: programField.control.value || null,
              loan_period_id: periodField.control.value || null,
              notes: notesField.control.value || null,
            });

            if (result.complete) {
              toastOk(`${result.loans.length} device(s) issued as ${result.group_ref}.`);
            } else {
              toastWarn(
                `${result.loans.length} issued as ${result.group_ref}, but ${result.skipped.length} ` +
                `could not go out: ${result.skipped.map((s) => s.name).join(', ')}.`,
                'Kit partly issued',
              );
            }
            announce(`Kit checked out as ${result.group_ref}.`, { assertive: true });
            close(result);
            onDone?.();
          } catch (err) { toastError(err.message); }
        },
      },
    ],
  });
}

// ===========================================================================
// Waitlist
// ===========================================================================

export async function renderWaitlist() {
  const container = el('div');
  const results = el('div');
  const state = { page: 1, status: '' };

  const statusField = field({
    name: 'status', label: 'Show', type: 'select',
    options: [
      { value: '', label: 'Open entries' },
      { value: 'ready', label: 'Ready to collect' },
      { value: 'waiting', label: 'Still waiting' },
      { value: 'fulfilled', label: 'Fulfilled' },
      { value: 'expired', label: 'Expired' },
      { value: 'cancelled', label: 'Cancelled' },
    ],
  });

  const load = async () => {
    clear(results).append(loadingBlock('Loading the waitlist…'));
    try {
      const response = await api.reservations({
        page: state.page, per_page: 25,
        status: state.status || null,
        open: state.status ? null : true,
      });

      clear(results).append(
        dataTable({
          caption: 'Waitlist entries',
          columns: [
            {
              key: 'position', label: '#', align: 'right',
              render: (r) => r.queue_position
                ? el('span', { class: 'queue-position' }, String(r.queue_position))
                : el('span', { class: 'muted' }, '—'),
            },
            { key: 'reference', label: 'Reference', render: (r) => el('span', { class: 'mono' }, r.reference) },
            {
              key: 'wants', label: 'Waiting for',
              render: (r) => el('span', {}, [
                r.wants,
                r.device_id ? el('span', { class: 'cell-sub' }, 'Specific device') : el('span', { class: 'cell-sub' }, 'Any in this category'),
              ]),
            },
            { key: 'client', label: 'For', render: (r) => r.client_name || '—' },
            { key: 'by', label: 'Requested by', render: (r) => r.requester_name },
            {
              key: 'status', label: 'Status',
              render: (r) => el('span', {}, [
                el('span', {
                  class: `pill ${r.status === 'ready' ? 'pill-ok' : r.status === 'waiting' ? 'pill-warn' : 'pill-neutral'}`,
                }, r.status === 'ready' ? 'Ready to collect' : r.status.charAt(0).toUpperCase() + r.status.slice(1)),
                r.status === 'ready' && r.claim_expires_in_hours !== null
                  ? el('span', { class: 'cell-sub' }, `Held for ${r.claim_expires_in_hours}h more`)
                  : null,
              ]),
            },
            { key: 'since', label: 'Waiting since', align: 'right', render: (r) => dateCell(r.created_at) },
            {
              key: 'actions', label: 'Actions', align: 'right',
              render: (r) => ['waiting', 'ready'].includes(r.status)
                ? el('button', {
                    type: 'button', class: 'btn btn-sm',
                    onClick: async () => {
                      const ok = await confirmDialog({
                        title: `Cancel ${r.reference}?`,
                        message: r.status === 'ready'
                          ? 'The device being held will be offered to the next person in the queue.'
                          : 'This entry is removed from the queue.',
                        confirmLabel: 'Cancel entry',
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await api.cancelReservation(r.id, {});
                        toastOk('Waitlist entry cancelled.');
                        load();
                      } catch (err) { toastError(err.message); }
                    },
                  }, ['Cancel', el('span', { class: 'visually-hidden' }, ` ${r.reference}`)])
                : el('span', { class: 'muted' }, '—'),
            },
          ],
          rows: response.data,
          rowClass: (r) => (r.status === 'ready' ? 'row-ready' : null),
          emptyMessage: 'Nobody is waiting for anything right now.',
        }),
        pagination(response.meta, (page) => { state.page = page; load(); }),
      );

      announce(`${response.meta.total} waitlist entr${response.meta.total === 1 ? 'y' : 'ies'}.`);
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load the waitlist' }));
    }
  };

  statusField.control.addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Waitlist' }),
        el('p', {
          text:
            'Who is waiting for equipment that is currently out. When a device is checked in, the ' +
            'next person in the queue is notified automatically and it is held for them.',
        }),
      ]),
      can('requests.write')
        ? el('button', {
            type: 'button', class: 'btn btn-primary', onClick: () => openReservationDialog(load),
          }, 'Add to waitlist')
        : null,
    ]),
    el('form', { class: 'filters', onSubmit: (e) => e.preventDefault() }, [statusField]),
    results,
  );

  load();
  return container;
}

export async function openReservationDialog(onDone, { device = null } = {}) {
  const [clients, programs, facets] = await Promise.all([
    allPages(api.clients),
    api.programs(),
    api.deviceFacets(),
  ]);

  const modeField = field({
    name: 'mode', label: 'What are they waiting for?', type: 'select',
    value: device ? 'device' : 'category',
    options: [
      { value: 'category', label: 'The next available device of a type' },
      { value: 'device', label: 'One specific device' },
    ],
  });

  const categoryField = field({
    name: 'category', label: 'Category', type: 'select',
    options: facets.categories.map((c) => ({ value: c.value, label: `${c.value} (${c.count})` })),
  });

  const deviceField = field({
    name: 'device_id', label: 'Device', type: 'select',
    value: device?.id || '',
    options: [
      { value: '', label: 'Choose a device…' },
      // The device this dialog was opened for is offered straight away, so it
      // is already chosen before the full list has arrived.
      ...(device ? [{ value: device.id, label: `${device.name} (${device.barcode})` }] : []),
    ],
  });

  // Populated lazily so the dialog opens fast even with a large inventory.
  allPages(api.devices, { sort: 'name' }).then((response) => {
    // Whatever is chosen now stays chosen. The list used to replace the
    // "Choose a device…" line as well, which left the first device in the
    // inventory selected without anybody having picked it.
    const chosen = deviceField.control.value;
    const rows = response.data.slice();

    if (device && !rows.some((d) => String(d.id) === String(device.id))) rows.unshift(device);

    clear(deviceField.control).append(
      el('option', { value: '' }, 'Choose a device…'),
      ...rows.map((d) => el('option', { value: d.id }, `${d.name} (${d.barcode})`)),
    );
    deviceField.control.value = chosen;
  }).catch(() => {});

  const clientField = field({
    name: 'client_id', label: 'For which client?', type: 'select',
    options: [{ value: '', label: 'No specific client' },
      ...clients.data.map((c) => ({ value: c.id, label: c.full_name }))],
  });

  const programField = field({
    name: 'program_id', label: 'Program', type: 'select',
    options: [{ value: '', label: 'No program' },
      ...programs.data.map((p) => ({ value: p.id, label: p.name }))],
  });

  const neededByField = field({ name: 'needed_from', label: 'Needed from', type: 'date' });
  const notesField = field({ name: 'notes', label: 'Notes', type: 'textarea' });

  const applyMode = () => {
    const isDevice = modeField.control.value === 'device';
    deviceField.hidden = !isDevice;
    categoryField.hidden = isDevice;
  };
  modeField.control.addEventListener('change', applyMode);
  applyMode();

  return modal({
    title: 'Add to the waitlist',
    body: el('div', {}, [
      modeField, categoryField, deviceField, clientField, programField, neededByField, notesField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Join the queue',
        class: 'btn-primary',
        onClick: async (close) => {
          const isDevice = modeField.control.value === 'device';
          try {
            const result = await api.createReservation({
              device_id: isDevice ? deviceField.control.value || null : null,
              category: isDevice ? null : categoryField.control.value || null,
              client_id: clientField.control.value || null,
              program_id: programField.control.value || null,
              needed_from: neededByField.control.value || null,
              notes: notesField.control.value || null,
            });

            // Queueing for something already on the shelf is almost certainly
            // not what was wanted, so say so rather than leaving them waiting.
            if (result.available_now) {
              toastWarn(
                `${result.available_now.name} (${result.available_now.barcode}) is actually available ` +
                'right now — you can check it out instead of waiting.',
                'Already available',
              );
            } else {
              toastOk(`Added to the waitlist at position ${result.reservation.queue_position}.`);
            }

            close(result);
            onDone?.();
          } catch (err) { toastError(err.message); }
        },
      },
    ],
  });
}

// ===========================================================================
// Repairs
// ===========================================================================

export async function renderRepairs() {
  const container = el('div');
  const results = el('div');
  const state = { page: 1, search: '', status: '' };

  const meta = await api.repairMeta();

  const searchField = field({ name: 'search', label: 'Search', type: 'search', placeholder: 'Reference, fault or device' });
  searchField.classList.add('field-grow');

  const statusField = field({
    name: 'status', label: 'Show', type: 'select',
    options: [{ value: '', label: 'Open repairs' }, ...meta.statuses.map((s) => ({ value: s.value, label: s.label }))],
  });

  const load = async () => {
    clear(results).append(loadingBlock('Loading repairs…'));
    try {
      const response = await api.repairs({
        page: state.page, per_page: 25, search: state.search,
        status: state.status || null, open: state.status ? null : true,
      });

      clear(results).append(
        dataTable({
          caption: 'Repair tickets',
          columns: [
            { key: 'reference', label: 'Reference', render: (r) => el('a', { class: 'mono', href: `#/repairs/${r.id}` }, r.reference) },
            {
              key: 'device', label: 'Device',
              render: (r) => el('span', {}, [r.device_name, el('span', { class: 'cell-sub mono', text: r.device_barcode })]),
            },
            { key: 'fault', label: 'Fault', render: (r) => el('span', { class: 'truncate' }, r.fault) },
            {
              key: 'status', label: 'Status',
              render: (r) => el('span', { class: `pill ${r.is_open ? 'pill-warn' : 'pill-ok'}` }, r.status_label),
            },
            { key: 'vendor', label: 'Vendor', render: (r) => r.vendor || 'In house' },
            { key: 'cost', label: 'Cost', align: 'right', render: (r) => (r.cost === null ? '—' : r.cost.toFixed(2)) },
            { key: 'days', label: 'Days open', align: 'right', render: (r) => String(r.days_open) },
          ],
          rows: response.data,
          emptyMessage: 'No repairs match these filters.',
        }),
        pagination(response.meta, (page) => { state.page = page; load(); }),
      );
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load repairs' }));
    }
  };

  const runFilter = debounce(() => { state.page = 1; load(); });
  searchField.control.addEventListener('input', (e) => { state.search = e.target.value; runFilter(); });
  statusField.control.addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Repairs' }),
        el('p', {
          text:
            'Equipment on the bench or with a vendor. Opening a repair takes the device out of the ' +
            'lendable pool; closing it puts the device back, or retires it if it is beyond repair.',
        }),
      ]),
      can('devices.write')
        ? el('button', {
            type: 'button', class: 'btn btn-primary', onClick: () => openRepairDialog(null, load),
          }, 'Report a fault')
        : null,
    ]),
    el('form', { class: 'filters', role: 'search', 'aria-label': 'Filter repairs', onSubmit: (e) => e.preventDefault() },
      [searchField, statusField]),
    results,
  );

  load();
  return container;
}

export async function renderRepairDetail({ params }) {
  const { repair } = await api.repair(params.id);
  document.title = `Repair ${repair.reference} — Loaner Pool`;
  const meta = await api.repairMeta();
  const container = el('div');

  const rerender = async () => { container.replaceWith(await renderRepairDetail({ params })); };

  mount(
    container,
    el('p', { class: 'breadcrumb' }, [el('a', { href: '#/repairs' }, 'Repairs'), ' / ', repair.reference]),

    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: `${repair.device_name}` }),
        el('p', { class: 'mono', text: `${repair.reference} · ${repair.device_barcode}` }),
      ]),
      el('div', { class: 'btn-group' }, [
        repair.is_open && can('devices.write')
          ? el('button', {
              type: 'button', class: 'btn btn-primary',
              onClick: () => openRepairUpdateDialog(repair, meta, rerender),
            }, 'Update repair')
          : null,
        el('a', { class: 'btn', href: `#/devices/${repair.device_id}` }, 'Open device record'),
      ]),
    ]),

    repair.under_warranty
      ? alertBox('This repair is covered by warranty, so its cost is reported as covered rather than paid.', { type: 'info', title: 'Warranty' })
      : null,

    el('div', { class: 'grid grid-2' }, [
      el('section', { class: 'card' }, [
        el('h2', { text: 'Details' }),
        el('dl', { class: 'detail-list' }, [
          el('dt', { text: 'Status' }),
          el('dd', {}, el('span', { class: `pill ${repair.is_open ? 'pill-warn' : 'pill-ok'}` }, repair.status_label)),
          el('dt', { text: 'Fault' }), el('dd', { text: repair.fault }),
          el('dt', { text: 'Diagnosis' }), el('dd', { text: repair.diagnosis || '—' }),
          el('dt', { text: 'Resolution' }), el('dd', { text: repair.resolution || '—' }),
          el('dt', { text: 'Vendor' }), el('dd', { text: repair.vendor || 'In house' }),
          el('dt', { text: 'Vendor reference' }), el('dd', { text: repair.vendor_ref || '—' }),
          el('dt', { text: 'Cost' }), el('dd', { text: repair.cost === null ? '—' : Number(repair.cost).toFixed(2) }),
          el('dt', { text: 'Reported by' }), el('dd', { text: repair.reported_by_name || '—' }),
          el('dt', { text: 'Assigned to' }), el('dd', { text: repair.assigned_to_name || 'Unassigned' }),
          el('dt', { text: 'Opened' }), el('dd', {}, dateCell(repair.created_at, { withTime: true })),
          el('dt', { text: 'Sent to vendor' }), el('dd', {}, dateCell(repair.sent_at, { withTime: true })),
          el('dt', { text: 'Closed' }), el('dd', {}, dateCell(repair.closed_at, { withTime: true })),
          el('dt', { text: 'Days open' }), el('dd', { text: String(repair.days_open) }),
        ]),
      ]),

      el('section', { class: 'card' }, [
        el('h2', { text: 'History' }),
        el('ol', { class: 'timeline' }, (repair.events ?? []).map((event) =>
          el('li', {}, [
            el('strong', {
              text: event.event_type === 'opened'
                ? 'Reported'
                : event.to_status
                  ? `Status → ${event.to_status.replace(/_/g, ' ')}`
                  : 'Note added',
            }),
            el('div', { class: 'timeline-time' },
              `${formatDate(event.created_at, { withTime: true })}${event.actor_name ? ` · ${event.actor_name}` : ''}`),
            event.notes ? el('p', { class: 'muted', style: { margin: '4px 0 0' }, text: event.notes }) : null,
          ]))),
      ]),
    ]),

    repair.attachments?.length
      ? el('section', { class: 'card' }, [
          el('h2', { text: 'Photos' }),
          el('ul', { class: 'thumb-list' }, repair.attachments.map((a) =>
            el('li', {}, el('img', { src: a.url, alt: a.caption || 'Repair photo' })))),
        ])
      : null,
  );

  return container;
}

async function openRepairDialog(device, onDone) {
  const devicesResponse = await allPages(api.devices, { sort: 'name' });
  const techs = can('users.read') ? await api.users({ role: 'tech' }) : { data: [] };

  const deviceField = field({
    name: 'device_id', label: 'Device', type: 'select', required: true,
    value: device?.id || '',
    options: [{ value: '', label: 'Choose a device…' },
      ...devicesResponse.data.map((d) => ({ value: d.id, label: `${d.name} (${d.barcode})` }))],
  });

  const faultField = field({
    name: 'fault', label: 'What is wrong?', type: 'textarea', required: true,
    help: 'Be specific — this is what the vendor or the next technician reads.',
  });
  const vendorField = field({ name: 'vendor', label: 'Vendor (if sending it away)' });
  const assignField = field({
    name: 'assigned_to', label: 'Assign to', type: 'select',
    options: [{ value: '', label: 'Unassigned' },
      ...techs.data.map((u) => ({ value: u.id, label: u.full_name }))],
  });

  return modal({
    title: 'Report a fault',
    body: el('div', {}, [
      alertBox(
        'Opening a repair moves the device out of the lendable pool until the repair is closed.',
        { type: 'info' },
      ),
      deviceField, faultField,
      el('div', { class: 'form-grid' }, [vendorField, assignField]),
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Open repair',
        class: 'btn-primary',
        onClick: async (close) => {
          deviceField.setError(null);
          faultField.setError(null);

          if (!deviceField.control.value) {
            deviceField.setError('Choose the device that needs repair.');
            deviceField.control.focus();
            return;
          }
          if (!faultField.control.value.trim()) {
            faultField.setError('Describe what is wrong.');
            faultField.control.focus();
            return;
          }

          try {
            await api.openRepair({
              device_id: Number(deviceField.control.value),
              fault: faultField.control.value.trim(),
              vendor: vendorField.control.value || null,
              assigned_to: assignField.control.value || null,
            });
            toastOk('Repair opened. The device has been taken out of the pool.');
            close(true);
            onDone?.();
          } catch (err) { toastError(err.message); }
        },
      },
    ],
  });
}

async function openRepairUpdateDialog(repair, meta, onDone) {
  const statusField = field({
    name: 'status', label: 'Status', type: 'select', value: repair.status,
    options: meta.statuses,
  });
  const diagnosisField = field({ name: 'diagnosis', label: 'Diagnosis', type: 'textarea', value: repair.diagnosis || '' });
  const resolutionField = field({ name: 'resolution', label: 'Resolution', type: 'textarea', value: repair.resolution || '' });
  const vendorField = field({ name: 'vendor', label: 'Vendor', value: repair.vendor || '' });
  const vendorRefField = field({ name: 'vendor_ref', label: 'Vendor reference', value: repair.vendor_ref || '' });
  const costField = field({
    name: 'cost', label: 'Cost', type: 'number', step: '0.01',
    value: repair.cost ?? '',
    help: 'Feeds the repair spend report.',
  });
  const notesField = field({ name: 'notes', label: 'Note for the history', type: 'textarea' });

  // The repair spend report splits cost into covered and paid by this flag,
  // and until this box existed nothing on screen could set it.
  const warrantyBox = el('input', {
    type: 'checkbox', id: `repair-warranty-${repair.id}`, checked: Boolean(Number(repair.under_warranty || 0)),
  });
  const warrantyField = el('label', { class: 'checkbox', for: `repair-warranty-${repair.id}` }, [
    warrantyBox,
    el('span', {}, [
      'Covered by warranty',
      el('span', {
        class: 'option-help',
        text: repair.warranty_active
          ? `The device was under warranty when this was reported${repair.warranty_expires ? ` (cover runs to ${formatDate(repair.warranty_expires)})` : ''}.`
          : 'Tick it if the manufacturer or vendor is paying for this repair.',
      }),
    ]),
  ]);

  const closeWarning = el('div');
  statusField.control.addEventListener('change', (e) => {
    clear(closeWarning);
    if (e.target.value === 'unrepairable') {
      closeWarning.append(alertBox(
        'Marking this beyond repair retires the device so it can never be lent again.',
        { type: 'warn' },
      ));
    } else if (['repaired', 'cancelled'].includes(e.target.value)) {
      closeWarning.append(alertBox('Closing this repair returns the device to the pool.', { type: 'info' }));
    }
  });

  return modal({
    title: `Update ${repair.reference}`,
    wide: true,
    body: el('div', {}, [
      statusField,
      closeWarning,
      diagnosisField,
      resolutionField,
      el('div', { class: 'form-grid' }, [vendorField, vendorRefField]),
      costField,
      warrantyField,
      notesField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Save update',
        class: 'btn-primary',
        onClick: async (close) => {
          try {
            await api.updateRepair(repair.id, {
              status: statusField.control.value,
              diagnosis: diagnosisField.control.value || null,
              resolution: resolutionField.control.value || null,
              vendor: vendorField.control.value || null,
              vendor_ref: vendorRefField.control.value || null,
              cost: costField.control.value === '' ? null : Number(costField.control.value),
              under_warranty: warrantyBox.checked,
              notes: notesField.control.value || null,
            });
            toastOk('Repair updated.');
            close(true);
            onDone?.();
          } catch (err) { toastError(err.message); }
        },
      },
    ],
  });
}

export { openRepairDialog };
