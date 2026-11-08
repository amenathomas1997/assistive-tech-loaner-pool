/**
 * Device inventory: browsing, editing, spreadsheet import, labels, and the
 * manual (no-scanner) check-out and check-in paths.
 */

import { api, ApiError, downloadUrl } from '../api.js';
import {
  el, clear, mount, field, dataTable, dateCell, pill, emptyState, pagination, modal,
  confirmDialog, toastOk, toastError, toastWarn, announce, debounce, withBusy,
  alert as alertBox, loadingBlock, formatDate,
} from '../ui.js';
import { can, navigate, session } from '../app.js';
import { openCheckoutDialog, openCheckinDialog } from './loans.js';
import { openRepairDialog, openReservationDialog } from './workshop.js';

const DEVICE_STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'available', label: 'Available' },
  { value: 'checked_out', label: 'On loan' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'retired', label: 'Retired' },
  { value: 'lost', label: 'Lost' },
];

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function renderDevices() {
  const container = el('div');
  const results = el('div', { id: 'device-results' });

  const state = { page: 1, search: '', status: '', category: '', sort: 'name' };
  const facets = await api.deviceFacets();

  // Selection for bulk actions. Held across pagination deliberately: a user
  // ticking items on page 1 and paging to page 2 expects the first lot to
  // still be selected.
  const selected = new Set();
  const bulkBar = el('div', { class: 'filters', hidden: true, role: 'region', 'aria-label': 'Bulk actions' });

  const refreshBulkBar = () => {
    if (!selected.size || !can('devices.write')) {
      bulkBar.hidden = true;
      return;
    }

    bulkBar.hidden = false;
    clear(bulkBar).append(
      el('strong', {}, `${selected.size} device${selected.size === 1 ? '' : 's'} selected`),
      el('div', { class: 'btn-group' }, [
        can('loans.write')
          ? el('button', {
              type: 'button', class: 'btn btn-sm btn-primary',
              onClick: () => openBulkCheckinDialog([...selected], () => { selected.clear(); load(); }),
            }, 'Check in selected')
          : null,
        el('button', {
          type: 'button', class: 'btn btn-sm',
          onClick: () => openBulkStatusDialog([...selected], () => { selected.clear(); load(); }),
        }, 'Change status'),
        el('a', {
          class: 'btn btn-sm', target: '_blank', rel: 'noopener',
          href: downloadUrl('/devices/labels', { ids: [...selected].join(',') }),
        }, 'Print labels'),
        el('button', {
          type: 'button', class: 'btn btn-sm btn-ghost',
          onClick: () => { selected.clear(); load(); },
        }, 'Clear selection'),
      ]),
    );
  };

  const searchField = field({
    name: 'search', label: 'Search', type: 'search',
    placeholder: 'Name, barcode, serial, asset tag…',
    help: 'Searches every identifying field.',
  });
  searchField.classList.add('field-grow');

  const statusField = field({ name: 'status', label: 'Status', type: 'select', options: DEVICE_STATUSES });
  const categoryField = field({
    name: 'category', label: 'Category', type: 'select',
    options: [{ value: '', label: 'Any category' },
      ...facets.categories.map((c) => ({ value: c.value, label: `${c.value} (${c.count})` }))],
  });

  const load = async () => {
    clear(results).append(loadingBlock('Loading devices…'));
    try {
      const response = await api.devices({
        page: state.page, per_page: 25, search: state.search,
        status: state.status, category: state.category, sort: state.sort,
      });

      clear(results).append(
        dataTable({
          caption: 'Devices in the loaner pool',
          columns: deviceColumns(load, { selected, onSelectionChange: refreshBulkBar }),
          rows: response.data,
          rowClass: (device) => (device.is_overdue ? 'row-danger' : null),
          emptyMessage: state.search || state.status || state.category
            ? 'No devices match these filters.'
            : 'There are no devices yet.',
        }),
        pagination(response.meta, (page) => { state.page = page; load(); }),
      );

      refreshBulkBar();
      announce(`${response.meta.total} device${response.meta.total === 1 ? '' : 's'} found.`);
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load devices' }));
    }
  };

  const runFilter = debounce(() => { state.page = 1; load(); });

  searchField.control.addEventListener('input', (e) => { state.search = e.target.value; runFilter(); });
  statusField.control.addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });
  categoryField.control.addEventListener('change', (e) => { state.category = e.target.value; state.page = 1; load(); });

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Devices' }),
        el('p', { text: 'Everything in the loaner pool, and who has it.' }),
      ]),
      el('div', { class: 'btn-group' }, [
        can('devices.import') ? el('a', { class: 'btn', href: '#/devices/import' }, 'Import spreadsheet') : null,
        el('a', {
          class: 'btn', target: '_blank', rel: 'noopener',
          href: downloadUrl('/devices/labels', {}),
        }, 'Print labels'),
        el('a', { class: 'btn', href: downloadUrl('/devices/export.csv', {}) }, 'Export CSV'),
        can('devices.write')
          ? el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openDeviceDialog(null, load) }, 'Add device')
          : null,
      ]),
    ]),

    el('form', {
      class: 'filters', role: 'search', 'aria-label': 'Filter devices',
      onSubmit: (e) => e.preventDefault(),
    }, [searchField, statusField, categoryField]),

    bulkBar,
    results,
  );

  load();
  return container;
}

function deviceColumns(reload, { selected = null, onSelectionChange = null } = {}) {
  const columns = [];

  if (selected && can('devices.write')) {
    columns.push({
      key: 'select',
      label: 'Select',
      // Wrapped in a label so the target is 44px even though the tick is 24.
      // The label has no text of its own, so the checkbox keeps its own name.
      render: (device) => el('label', { class: 'row-select' }, el('input', {
        type: 'checkbox',
        checked: selected.has(device.id),
        // The visible column header reads "Select", which is not enough on its
        // own when a screen reader reaches the twentieth checkbox in a table.
        'aria-label': `Select ${device.name}, barcode ${device.barcode}`,
        onChange: (event) => {
          if (event.target.checked) selected.add(device.id);
          else selected.delete(device.id);
          onSelectionChange?.();
        },
      })),
    });
  }

  columns.push(
    {
      key: 'name', label: 'Device',
      render: (device) => el('a', { href: `#/devices/${device.id}` }, [
        device.name,
        el('span', { class: 'cell-sub' },
          [device.manufacturer, device.model].filter(Boolean).join(' ') || device.category || ''),
      ]),
    },
    {
      key: 'barcode', label: 'Barcode',
      render: (device) => el('span', { class: 'mono' }, [
        device.barcode,
        device.asset_tag ? el('span', { class: 'cell-sub', text: `Asset ${device.asset_tag}` }) : null,
      ]),
    },
    {
      key: 'status', label: 'Status',
      render: (device) => el('span', {}, [
        pill(device.is_overdue ? 'lost' : device.status),
        device.is_overdue ? el('span', { class: 'cell-sub', text: 'Overdue' }) : null,
      ]),
    },
    {
      key: 'holder', label: 'Held by',
      render: (device) => device.current_holder
        ? el('span', {}, [
            device.current_holder,
            device.active_loan_due_at
              ? el('span', { class: 'cell-sub', text: `Due ${formatDate(device.active_loan_due_at)}` })
              : null,
          ])
        : el('span', { class: 'muted' }, '—'),
    },
    { key: 'location', label: 'Location', render: (device) => device.location || '—' },
    {
      key: 'actions', label: 'Actions', align: 'right',
      render: (device) => el('div', { class: 'table-actions' }, [
        can('loans.write') && device.active_loan_id
          ? el('button', {
              type: 'button', class: 'btn btn-sm',
              onClick: () => openCheckinDialog({ device, onDone: reload }),
            }, [
              'Check in',
              el('span', { class: 'visually-hidden' }, ` ${device.name}`),
            ])
          : null,
        can('loans.write') && !device.active_loan_id && ['available', 'reserved'].includes(device.status)
          ? el('button', {
              type: 'button', class: 'btn btn-sm btn-primary',
              onClick: () => openCheckoutDialog({ device, onDone: reload }),
            }, [
              'Check out',
              el('span', { class: 'visually-hidden' }, ` ${device.name}`),
            ])
          : null,
      ]),
    },
  );

  return columns;
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

/**
 * Bulk operations report per-item outcomes rather than succeeding or failing
 * as a block: at the end of a program, twenty devices come back and one of
 * them turns out not to be on loan. Failing all twenty is unusable.
 */
async function openBulkCheckinDialog(deviceIds, onDone) {
  const conditionField = field({ name: 'condition_in', label: 'Condition coming back', value: 'Good' });
  const notesField = field({ name: 'notes', label: 'Notes for all of them', type: 'textarea' });
  const maintenanceBox = el('input', { type: 'checkbox', id: 'bulk-maintenance' });
  const resultArea = el('div');

  return modal({
    title: `Check in ${deviceIds.length} device(s)`,
    wide: true,
    body: el('div', {}, [
      el('p', {
        text:
          'Each device is checked in separately. Anything that is not currently on loan is reported ' +
          'and skipped, rather than stopping the rest.',
      }),
      conditionField,
      el('label', { class: 'checkbox', for: 'bulk-maintenance' }, [
        maintenanceBox,
        el('span', {}, 'Send all of them to maintenance instead of back on the shelf'),
      ]),
      notesField,
      resultArea,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Check them in',
        class: 'btn-primary',
        onClick: async (close, dialog) => {
          const button = dialog.querySelector('.modal-footer .btn-primary');

          await withBusy(button, 'Checking in…', async () => {
            clear(resultArea);
            try {
              const result = await api.bulkCheckIn({
                loan_ids: [],
                devices: deviceIds,
                condition_in: conditionField.control.value || null,
                notes: notesField.control.value || null,
                device_status: maintenanceBox.checked ? 'maintenance' : 'available',
              });

              if (result.failed_count === 0) {
                toastOk(`${result.checked_in} device(s) checked in.`);
                announce(`${result.checked_in} devices checked in.`, { assertive: true });
                close(result);
                onDone?.();
                return;
              }

              resultArea.append(
                alertBox(
                  `${result.checked_in} checked in, ${result.failed_count} could not be.`,
                  { type: 'warn', title: 'Partly done' },
                ),
                dataTable({
                  caption: 'Devices that could not be checked in',
                  columns: [
                    { key: 'identifier', label: 'Device' },
                    { key: 'reason', label: 'Why not' },
                  ],
                  rows: result.failed,
                }),
              );
              announce(
                `${result.checked_in} checked in. ${result.failed_count} could not be.`,
                { assertive: true },
              );
              onDone?.();
            } catch (err) {
              resultArea.append(alertBox(err.message, { type: 'danger', title: 'Bulk check-in failed' }));
            }
          });
        },
      },
    ],
  });
}

async function openBulkStatusDialog(deviceIds, onDone) {
  const statusField = field({
    name: 'status', label: 'Set status to', type: 'select', value: 'maintenance',
    options: [
      { value: 'available', label: 'Available' },
      { value: 'maintenance', label: 'Maintenance' },
      { value: 'reserved', label: 'Reserved' },
      { value: 'retired', label: 'Retired' },
      { value: 'lost', label: 'Lost' },
    ],
    help: 'Devices currently on loan are skipped and reported.',
  });
  const resultArea = el('div');

  return modal({
    title: `Change the status of ${deviceIds.length} device(s)`,
    wide: true,
    body: el('div', {}, [statusField, resultArea]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Change status',
        class: 'btn-primary',
        onClick: async (close) => {
          clear(resultArea);
          try {
            const result = await api.bulkDeviceStatus({
              device_ids: deviceIds,
              status: statusField.control.value,
            });

            if (result.failed_count === 0) {
              toastOk(`${result.changed} device(s) updated.`);
              close(result);
              onDone?.();
              return;
            }

            resultArea.append(
              alertBox(
                `${result.changed} changed, ${result.failed_count} skipped.`,
                { type: 'warn', title: 'Partly done' },
              ),
              dataTable({
                caption: 'Devices that were skipped',
                columns: [{ key: 'id', label: 'Device id' }, { key: 'reason', label: 'Why not' }],
                rows: result.failed,
              }),
            );
            onDone?.();
          } catch (err) {
            resultArea.append(alertBox(err.message, { type: 'danger', title: 'Bulk change failed' }));
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function renderDeviceDetail({ params }) {
  const { device, loan_history: history } = await api.device(params.id);
  const [accessories, waitlist, repairs] = await Promise.all([
    api.accessories(device.id).then((r) => r.data).catch(() => []),
    api.deviceWaitlist(device.id).then((r) => r.data).catch(() => []),
    api.repairs({ device_id: device.id, per_page: 10 }).then((r) => r.data).catch(() => []),
  ]);
  const container = el('div');

  const rerender = async () => {
    const fresh = await renderDeviceDetail({ params });
    container.replaceWith(fresh);
  };

  container.append(
    el('p', { class: 'breadcrumb' }, [el('a', { href: '#/devices' }, 'Devices'), ' / ', device.name]),

    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: device.name }),
        el('p', { class: 'mono', text: device.barcode }),
      ]),
      el('div', { class: 'btn-group' }, [
        can('loans.write') && device.active_loan_id
          ? el('button', {
              type: 'button', class: 'btn btn-primary',
              onClick: () => openCheckinDialog({ device, onDone: rerender }),
            }, 'Check in')
          : null,
        can('loans.write') && !device.active_loan_id && ['available', 'reserved'].includes(device.status)
          ? el('button', {
              type: 'button', class: 'btn btn-primary',
              onClick: () => openCheckoutDialog({ device, onDone: rerender }),
            }, 'Check out')
          : null,
        can('devices.write')
          ? el('button', { type: 'button', class: 'btn', onClick: () => openDeviceDialog(device, rerender) }, 'Edit')
          : null,
        el('a', {
          class: 'btn', target: '_blank', rel: 'noopener',
          href: downloadUrl('/devices/labels', { ids: device.id }),
        }, 'Print label'),
        can('devices.write') && !device.active_loan_id && device.status !== 'maintenance'
          ? el('button', {
              type: 'button', class: 'btn',
              onClick: () => openRepairDialog(device, rerender),
            }, 'Report a fault')
          : null,
        can('requests.write') && (device.active_loan_id || device.status !== 'available')
          ? el('button', {
              type: 'button', class: 'btn',
              onClick: () => openReservationDialog(rerender, { device }),
            }, 'Join the waitlist')
          : null,
      ]),
    ]),

    device.is_overdue
      ? alertBox(
          `This device is overdue. It was due back on ${formatDate(device.active_loan_due_at)}.`,
          { type: 'danger', title: 'Overdue' })
      : null,

    el('div', { class: 'grid grid-2' }, [
      el('section', { class: 'card', 'aria-labelledby': 'details-heading' }, [
        el('h2', { id: 'details-heading', text: 'Details' }),
        el('dl', { class: 'detail-list' }, [
          dt('Status'), el('dd', {}, pill(device.status)),
          dt('Asset tag'), dd(device.asset_tag),
          dt('Serial number'), dd(device.serial_number),
          dt('Category'), dd(device.category),
          dt('Manufacturer'), dd(device.manufacturer),
          dt('Model'), dd(device.model),
          dt('Condition'), dd(device.condition_note),
          dt('Location'), dd(device.location),
          dt('Program'), dd(device.program_name),
          dt('Purchased'), el('dd', {}, dateCell(device.purchase_date)),
          dt('Cost'), dd(device.purchase_cost ? `${device.purchase_cost}` : null),
          dt('Funding'), dd(device.funding_source),
          dt('Warranty ends'), el('dd', {}, dateCell(device.warranty_expires)),
          dt('Notes'), dd(device.notes),
        ]),
      ]),

      el('section', { class: 'card', 'aria-labelledby': 'barcode-heading' }, [
        el('h2', { id: 'barcode-heading', text: 'Barcode' }),
        el('div', { class: 'qr-holder' }, [
          el('img', {
            src: `/api/v1/devices/${device.id}/barcode.svg`,
            alt: `Barcode for ${device.name}, value ${device.barcode}`,
            width: 200, height: 200,
          }),
        ]),
        el('p', { class: 'mono center', style: { marginTop: '10px' }, text: device.barcode }),
        can('devices.write')
          ? el('button', {
              type: 'button', class: 'btn btn-sm btn-block',
              onClick: async () => {
                const ok = await confirmDialog({
                  title: 'Issue a new barcode?',
                  message:
                    'The current label will stop working immediately and must be replaced. ' +
                    'Only do this if the existing label is damaged or duplicated.',
                  confirmLabel: 'Issue new barcode',
                  danger: true,
                });
                if (!ok) return;
                try {
                  await api.reassignBarcode(device.id);
                  toastOk('A new barcode was issued. Print and apply the new label.');
                  rerender();
                } catch (err) { toastError(err.message); }
              },
            }, 'Issue a new barcode')
          : null,
      ]),
    ]),

    // --- Accessories -------------------------------------------------------
    el('section', { class: 'card', 'aria-labelledby': 'accessories-heading' }, [
      el('div', { class: 'card-header' }, [
        el('h2', { id: 'accessories-heading', text: 'Accessories' }),
        can('devices.write')
          ? el('button', {
              type: 'button', class: 'btn btn-sm',
              onClick: () => openAccessoriesDialog(device, accessories, rerender),
            }, 'Edit checklist')
          : null,
      ]),
      el('p', {
        class: 'muted',
        text:
          'Ticked off at check-out and again at check-in. Chargers and cases are what actually go ' +
          'missing, and they are not worth their own barcode.',
      }),
      accessories.length
        ? el('ul', {}, accessories.map((a) => el('li', {}, [
            a.name,
            a.required ? el('span', { class: 'muted' }, ' — normally goes out with the device') : null,
          ])))
        : el('p', { class: 'muted' }, 'No accessories listed for this device.'),
    ]),

    // --- Waitlist ----------------------------------------------------------
    waitlist.length
      ? el('section', { class: 'card', 'aria-labelledby': 'waitlist-heading' }, [
          el('h2', { id: 'waitlist-heading', text: `${waitlist.length} waiting for this` }),
          dataTable({
            caption: 'People waiting for this device',
            columns: [
              {
                key: 'position', label: '#', align: 'right',
                render: (r) => r.queue_position
                  ? el('span', { class: 'queue-position' }, String(r.queue_position))
                  : el('span', { class: 'pill pill-ok' }, 'Held'),
              },
              { key: 'client', label: 'For', render: (r) => r.client_name || '—' },
              { key: 'by', label: 'Requested by', render: (r) => r.requester_name },
              { key: 'since', label: 'Waiting since', render: (r) => dateCell(r.created_at) },
            ],
            rows: waitlist,
          }),
        ])
      : null,

    // --- Repairs -----------------------------------------------------------
    repairs.length
      ? el('section', { class: 'card', 'aria-labelledby': 'device-repairs-heading' }, [
          el('h2', { id: 'device-repairs-heading', text: 'Repair history' }),
          dataTable({
            caption: `Repairs for ${device.name}`,
            columns: [
              { key: 'reference', label: 'Reference', render: (r) => el('a', { class: 'mono', href: `#/repairs/${r.id}` }, r.reference) },
              { key: 'fault', label: 'Fault' },
              { key: 'status', label: 'Status', render: (r) => el('span', { class: `pill ${r.is_open ? 'pill-warn' : 'pill-ok'}` }, r.status_label) },
              { key: 'cost', label: 'Cost', align: 'right', render: (r) => (r.cost === null ? '—' : r.cost.toFixed(2)) },
              { key: 'opened', label: 'Opened', render: (r) => dateCell(r.created_at) },
            ],
            rows: repairs,
          }),
        ])
      : null,

    el('section', { class: 'card', 'aria-labelledby': 'history-heading' }, [
      el('h2', { id: 'history-heading', text: 'Loan history' }),
      history.length
        ? dataTable({
            caption: `Every loan of ${device.name}`,
            columns: [
              { key: 'reference', label: 'Reference', render: (l) => el('a', { class: 'mono', href: `#/loans/${l.id}` }, l.reference) },
              {
                key: 'holder', label: 'Held by',
                render: (l) => [l.client_first_name ? `${l.client_first_name} ${l.client_last_name}` : null,
                  l.tech_name, l.program_name].filter(Boolean).join(' / ') || '—',
              },
              { key: 'out', label: 'Out', render: (l) => dateCell(l.checked_out_at) },
              { key: 'due', label: 'Due', render: (l) => dateCell(l.due_at) },
              { key: 'back', label: 'Returned', render: (l) => dateCell(l.returned_at) },
              { key: 'status', label: 'Status', render: (l) => pill(l.status, 'loan') },
            ],
            rows: history,
          })
        : emptyState({ icon: '📄', title: 'Never loaned', message: 'This device has not been checked out yet.' }),
    ]),
  );

  return container;
}

/**
 * Edit the accessory checklist.
 *
 * Rows are added and removed with buttons and reordered with a number input —
 * there is no drag handle anywhere, so this satisfies WCAG 2.2 SC 2.5.7
 * without needing the "dragging is essential" exemption.
 */
async function openAccessoriesDialog(device, existing, onDone) {
  const rows = existing.length
    ? existing.map((a) => ({ name: a.name, required: Boolean(a.required) }))
    : [{ name: '', required: true }];

  const list = el('div', { class: 'stack' });

  const renderRows = () => {
    clear(list);

    rows.forEach((row, index) => {
      const nameInput = el('input', {
        type: 'text', value: row.name,
        'aria-label': `Name of accessory ${index + 1}`,
        placeholder: 'e.g. Charger',
        onInput: (e) => { row.name = e.target.value; },
      });
      const requiredBox = el('input', {
        type: 'checkbox', checked: row.required,
        'aria-label': `Accessory ${index + 1} normally goes out with the device`,
        onChange: (e) => { row.required = e.target.checked; },
      });

      list.append(el('div', { class: 'row' }, [
        el('div', { class: 'grow' }, nameInput),
        el('label', { class: 'checkbox', style: { marginBottom: 0 } }, [
          requiredBox, el('span', {}, 'Usually included'),
        ]),
        el('button', {
          type: 'button', class: 'btn btn-sm btn-ghost',
          onClick: () => {
            rows.splice(index, 1);
            if (!rows.length) rows.push({ name: '', required: true });
            renderRows();
            announce(`Removed accessory ${index + 1}.`);
          },
        }, ['Remove', el('span', { class: 'visually-hidden' }, ` accessory ${index + 1}`)]),
      ]));
    });
  };

  renderRows();

  return modal({
    title: `Accessories for ${device.name}`,
    wide: true,
    body: el('div', {}, [
      el('p', {
        text:
          'These are ticked off when the device goes out and again when it comes back. ' +
          'Anything that went out and did not return is flagged and recorded on the loan.',
      }),
      list,
      el('button', {
        type: 'button', class: 'btn btn-sm', style: { marginTop: '10px' },
        onClick: () => {
          rows.push({ name: '', required: true });
          renderRows();
          const inputs = list.querySelectorAll('input[type="text"]');
          inputs[inputs.length - 1]?.focus();
        },
      }, '+ Add another'),
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Save checklist',
        class: 'btn-primary',
        onClick: async (close) => {
          const accessories = rows
            .map((r) => ({ name: r.name.trim(), required: r.required }))
            .filter((r) => r.name);

          try {
            await api.setAccessories(device.id, accessories);
            toastOk(
              accessories.length
                ? `${accessories.length} accessory item(s) saved.`
                : 'Accessory checklist cleared.',
            );
            close(true);
            onDone?.();
          } catch (err) { toastError(err.message); }
        },
      },
    ],
  });
}

const dt = (label) => el('dt', { text: label });
const dd = (value) => el('dd', value ? { text: String(value) } : { class: 'muted', text: '—' });

// ---------------------------------------------------------------------------
// Create / edit dialog
// ---------------------------------------------------------------------------

export async function openDeviceDialog(device, onDone) {
  const programs = can('programs.read') ? (await api.programs()).data : [];

  const fields = {
    name: field({ name: 'name', label: 'Device name', required: true, value: device?.name || '' }),
    asset_tag: field({ name: 'asset_tag', label: 'Asset tag', value: device?.asset_tag || '' }),
    serial_number: field({ name: 'serial_number', label: 'Serial number', value: device?.serial_number || '' }),
    category: field({ name: 'category', label: 'Category', value: device?.category || '' }),
    manufacturer: field({ name: 'manufacturer', label: 'Manufacturer', value: device?.manufacturer || '' }),
    model: field({ name: 'model', label: 'Model', value: device?.model || '' }),
    status: field({
      name: 'status', label: 'Status', type: 'select',
      value: device?.status || 'available',
      options: DEVICE_STATUSES.filter((s) => s.value),
    }),
    condition_note: field({ name: 'condition_note', label: 'Condition', value: device?.condition_note || '' }),
    location: field({ name: 'location', label: 'Location', value: device?.location || '' }),
    owner_program_id: field({
      name: 'owner_program_id', label: 'Program', type: 'select',
      value: device?.owner_program_id || '',
      options: [{ value: '', label: 'None' }, ...programs.map((p) => ({ value: p.id, label: p.name }))],
    }),
    purchase_date: field({ name: 'purchase_date', label: 'Purchase date', type: 'date', value: device?.purchase_date?.slice(0, 10) || '' }),
    purchase_cost: field({ name: 'purchase_cost', label: 'Purchase cost', type: 'number', step: '0.01', value: device?.purchase_cost || '' }),
    funding_source: field({ name: 'funding_source', label: 'Funding source', value: device?.funding_source || '' }),
    notes: field({ name: 'notes', label: 'Notes', type: 'textarea', value: device?.notes || '' }),
  };

  await modal({
    title: device ? `Edit ${device.name}` : 'Add a device',
    wide: true,
    body: el('div', {}, [
      el('div', { class: 'form-grid' }, [fields.name, fields.category]),
      el('div', { class: 'form-grid' }, [fields.asset_tag, fields.serial_number]),
      el('div', { class: 'form-grid' }, [fields.manufacturer, fields.model]),
      el('div', { class: 'form-grid' }, [fields.status, fields.condition_note]),
      el('div', { class: 'form-grid' }, [fields.location, fields.owner_program_id]),
      el('div', { class: 'form-grid' }, [fields.purchase_date, fields.purchase_cost]),
      fields.funding_source,
      fields.notes,
      device ? null : el('p', {
        class: 'field-help',
        text: 'A unique barcode will be generated automatically when you save.',
      }),
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: device ? 'Save changes' : 'Add device',
        class: 'btn-primary',
        onClick: async (close) => {
          for (const f of Object.values(fields)) f.setError(null);

          const body = {};
          for (const [key, f] of Object.entries(fields)) {
            const value = f.control.value.trim?.() ?? f.control.value;
            body[key] = value === '' ? null : value;
          }

          try {
            if (device) await api.updateDevice(device.id, body);
            else await api.createDevice(body);

            toastOk(device ? 'Device updated.' : 'Device added and given a barcode.');
            close(true);
            onDone?.();
          } catch (err) {
            if (err.field && fields[err.field]) {
              fields[err.field].setError(err.message);
              fields[err.field].control.focus();
            } else {
              toastError(err.message);
            }
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Spreadsheet import
// ---------------------------------------------------------------------------

export async function renderImport() {
  const container = el('div');
  const stepArea = el('div');

  let fileText = null;
  let fileName = null;
  let preview = null;
  let mapping = {};

  const fileInput = el('input', {
    type: 'file',
    id: 'import-file',
    accept: '.csv,.tsv,.txt,text/csv,text/plain',
    'aria-describedby': 'import-file-help',
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    fileName = file.name;
    // Reading in the browser avoids upload middleware on the server, and means
    // nothing is written to disk anywhere until the import is committed.
    fileText = await file.text();

    clear(stepArea).append(loadingBlock('Reading the file…'));

    try {
      preview = await api.importPreview({ content: fileText });
      mapping = { ...preview.suggested_mapping };
      renderMapping();
    } catch (err) {
      clear(stepArea).append(alertBox(err.message, { type: 'danger', title: 'Could not read that file' }));
    }
  });

  function renderMapping() {
    const rows = preview.headers.map((header) => {
      const select = el('select', {
        'aria-label': `What does the column "${header}" contain?`,
        onChange: (e) => {
          if (e.target.value === '') delete mapping[header];
          else mapping[header] = e.target.value;
        },
      }, [
        el('option', { value: '' }, 'Ignore this column'),
        ...preview.importable_fields.map((f) =>
          el('option', { value: f, selected: mapping[header] === f }, fieldLabel(f))),
      ]);

      const sample = preview.sample_rows[0]?.[header];

      return el('tr', {}, [
        el('td', {}, el('code', { text: header })),
        el('td', { class: 'muted truncate' }, sample ? String(sample).slice(0, 60) : '—'),
        el('td', {}, select),
      ]);
    });

    const dryRunResult = el('div');

    clear(stepArea).append(
      alertBox(
        `Read ${preview.row_count} row${preview.row_count === 1 ? '' : 's'} from ${fileName}. ` +
        'Check the column mapping below, then run a test import.',
        { type: 'info', title: 'File read successfully' },
      ),

      el('div', { class: 'card' }, [
        el('h2', { text: 'Match your columns' }),
        el('p', {
          class: 'muted',
          text:
            'Columns left as "Ignore" are still kept against the device as extra information — ' +
            'nothing from your spreadsheet is thrown away.',
        }),
        el('div', { class: 'table-wrap' }, el('table', {}, [
          el('caption', { class: 'visually-hidden' }, 'Spreadsheet columns and what they map to'),
          el('thead', {}, el('tr', {}, [
            el('th', { scope: 'col' }, 'Column in your file'),
            el('th', { scope: 'col' }, 'First value'),
            el('th', { scope: 'col' }, 'Import as'),
          ])),
          el('tbody', {}, rows),
        ])),
      ]),

      el('div', { class: 'row' }, [
        el('button', {
          type: 'button', class: 'btn btn-primary',
          onClick: (e) => runImport(e.currentTarget, true, dryRunResult),
        }, 'Test import (changes nothing)'),
      ]),

      dryRunResult,
    );
  }

  async function runImport(button, dryRun, resultArea) {
    await withBusy(button, dryRun ? 'Testing…' : 'Importing…', async () => {
      clear(resultArea);
      try {
        const result = await api.importDevices({
          content: fileText, filename: fileName, mapping, dry_run: dryRun,
        });

        if (dryRun) {
          mount(resultArea,
            alertBox(
              `${result.to_create} device(s) would be created, ${result.to_update} updated, ` +
              `${result.error_count} row(s) rejected. Nothing has been changed yet.`,
              { type: result.error_count ? 'warn' : 'ok', title: 'Test import complete' },
            ),
            result.error_count ? errorTable(result.errors) : null,
            el('div', { class: 'row' }, [
              el('button', {
                type: 'button', class: 'btn btn-primary btn-lg',
                onClick: (e) => runImport(e.currentTarget, false, resultArea),
              }, `Import ${result.to_create + result.to_update} device(s) for real`),
            ]),
          );
          announce(`Test import complete. ${result.to_create} to create, ${result.to_update} to update, ${result.error_count} rejected.`);
        } else {
          resultArea.append(alertBox(
            `${result.created_count} device(s) created and ${result.updated_count} updated. ` +
            'Every new device has been given a barcode.',
            { type: 'ok', title: 'Import complete' },
          ), el('div', { class: 'row' }, [
            el('a', { class: 'btn btn-primary', href: '#/devices' }, 'View devices'),
            el('a', {
              class: 'btn', target: '_blank', rel: 'noopener',
              href: downloadUrl('/devices/labels', {}),
            }, 'Print labels'),
          ]));
          announce(`Import complete. ${result.created_count} created, ${result.updated_count} updated.`, { assertive: true });
        }
      } catch (err) {
        resultArea.append(alertBox(err.message, { type: 'danger', title: 'Import failed' }));
      }
    });
  }

  container.append(
    el('p', { class: 'breadcrumb' }, [el('a', { href: '#/devices' }, 'Devices'), ' / Import']),
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Import devices from a spreadsheet' }),
        el('p', {
          text:
            'Upload a CSV exported from Excel or Google Sheets. Every device that does not already ' +
            'exist will be created and given a unique barcode.',
        }),
      ]),
      el('a', { class: 'btn', href: downloadUrl('/devices/import/template.csv') }, 'Download template'),
    ]),

    el('div', { class: 'card' }, [
      el('div', { class: 'field' }, [
        el('label', { for: 'import-file' }, 'Choose a CSV file'),
        fileInput,
        el('p', {
          class: 'field-help', id: 'import-file-help',
          text:
            'In Excel, use File → Save As → "CSV UTF-8 (Comma delimited)". ' +
            'Existing devices are matched by barcode, then serial number, then asset tag, and updated rather than duplicated.',
        }),
      ]),
    ]),

    stepArea,
  );

  return container;
}

function errorTable(errors) {
  return el('div', { class: 'card' }, [
    el('h3', { text: 'Rows that will be skipped' }),
    el('div', { class: 'table-wrap' }, el('table', {}, [
      el('caption', { class: 'visually-hidden' }, 'Rows rejected by the importer and why'),
      el('thead', {}, el('tr', {}, [
        el('th', { scope: 'col' }, 'Line'),
        el('th', { scope: 'col' }, 'Device'),
        el('th', { scope: 'col' }, 'Problem'),
      ])),
      el('tbody', {}, errors.map((row) => el('tr', {}, [
        el('td', { class: 'mono', text: String(row.line) }),
        el('td', { text: row.row?.name || row.row?.asset_tag || '—' }),
        el('td', {}, el('ul', { style: { margin: 0, paddingLeft: '18px' } },
          row.errors.map((message) => el('li', { text: message })))),
      ]))),
    ])),
  ]);
}

function fieldLabel(name) {
  return name
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}
