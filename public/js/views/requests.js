/**
 * Loan requests: the counselor's view of asking for equipment, and the
 * technician's view of approving and delivering it.
 */

import { api } from '../api.js';
import {
  el, clear, field, dataTable, dateCell, pill, emptyState, pagination, modal,
  toastOk, toastError, announce, debounce, loadingBlock, alert as alertBox, formatDate,
} from '../ui.js';
import { can, navigate, session } from '../app.js';

const FULFILMENT_ORDER = ['pending', 'provisioning', 'in_transit', 'ready_pickup', 'delivered'];

const FULFILMENT_LABELS = {
  pending: 'Not started',
  provisioning: 'Being provisioned',
  in_transit: 'On its way',
  ready_pickup: 'Ready for pickup',
  delivered: 'Delivered',
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function renderRequests() {
  const container = el('div');
  const results = el('div');

  const initialStatus = new URLSearchParams(window.location.hash.split('?')[1] || '').get('status') || '';
  const state = { page: 1, search: '', status: initialStatus, open: !initialStatus };

  const searchField = field({ name: 'search', label: 'Search', type: 'search', placeholder: 'Reference, client, item…' });
  searchField.classList.add('field-grow');

  const statusField = field({
    name: 'status', label: 'Show', type: 'select', value: initialStatus,
    options: [
      { value: '', label: 'Open requests' },
      { value: 'submitted', label: 'Awaiting review' },
      { value: 'approved', label: 'Approved' },
      { value: 'fulfilled', label: 'Delivered' },
      { value: 'denied', label: 'Declined' },
      { value: 'cancelled', label: 'Cancelled' },
    ],
  });

  const load = async () => {
    clear(results).append(loadingBlock('Loading requests…'));
    try {
      const response = await api.requests({
        page: state.page, per_page: 25, search: state.search,
        status: state.status || null, open: state.status ? null : true,
      });

      clear(results).append(
        dataTable({
          caption: 'Loan requests',
          columns: [
            {
              key: 'reference', label: 'Reference',
              render: (r) => el('a', { class: 'mono', href: `#/requests/${r.id}` }, r.reference),
            },
            { key: 'client', label: 'Client', render: (r) => r.client_name || '—' },
            {
              key: 'item', label: 'Wanted',
              render: (r) => el('span', {}, [
                r.device_name || r.requested_category || 'See details',
                r.program_name ? el('span', { class: 'cell-sub', text: r.program_name }) : null,
              ]),
            },
            { key: 'by', label: 'Requested by', render: (r) => r.requester_name },
            { key: 'status', label: 'Status', render: (r) => pill(r.status, 'request') },
            { key: 'progress', label: 'Progress', render: (r) => r.tracking_summary },
            { key: 'needed', label: 'Needed by', align: 'right', render: (r) => dateCell(r.needed_by) },
          ],
          rows: response.data,
          emptyMessage: 'No requests match these filters.',
        }),
        pagination(response.meta, (page) => { state.page = page; load(); }),
      );

      announce(`${response.meta.total} request${response.meta.total === 1 ? '' : 's'} found.`);
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load requests' }));
    }
  };

  const runFilter = debounce(() => { state.page = 1; load(); });
  searchField.control.addEventListener('input', (e) => { state.search = e.target.value; runFilter(); });
  statusField.control.addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Loan requests' }),
        el('p', {
          text: session.user?.role === 'vrc'
            ? 'Requests you have submitted, and where each one has got to.'
            : 'Requests from counselors, and what still needs doing.',
        }),
      ]),
      can('requests.write')
        ? el('a', { class: 'btn btn-primary', href: '#/requests/new' }, 'New request')
        : null,
    ]),

    el('form', {
      class: 'filters', role: 'search', 'aria-label': 'Filter requests',
      onSubmit: (e) => e.preventDefault(),
    }, [searchField, statusField]),

    results,
  );

  load();
  return container;
}

// ---------------------------------------------------------------------------
// New request
// ---------------------------------------------------------------------------

export async function renderNewRequest() {
  const [clientsResponse, programsResponse, periodsResponse, devicesResponse] = await Promise.all([
    api.clients({ per_page: 200 }),
    api.programs(),
    api.loanPeriods(),
    api.devices({ status: 'available', per_page: 200 }),
  ]);

  const fields = {
    client_id: field({
      name: 'client_id', label: 'Client', type: 'select',
      options: [{ value: '', label: 'No specific client' },
        ...clientsResponse.data.map((c) => ({ value: c.id, label: c.full_name }))],
      help: 'Leave blank if the equipment is for a program rather than an individual.',
    }),
    program_id: field({
      name: 'program_id', label: 'Program', type: 'select',
      options: [{ value: '', label: 'No program' },
        ...programsResponse.data.map((p) => ({ value: p.id, label: p.name }))],
    }),
    requested_category: field({
      name: 'requested_category', label: 'What kind of equipment?',
      help: 'For example: Laptop, Magnifier, Braille display.',
    }),
    device_id: field({
      name: 'device_id', label: 'A specific device (optional)', type: 'select',
      options: [{ value: '', label: 'No preference — any suitable device' },
        ...devicesResponse.data.map((d) => ({ value: d.id, label: `${d.name} (${d.barcode})` }))],
    }),
    requested_details: field({
      name: 'requested_details', label: 'Details of what is needed', type: 'textarea',
      help: 'Anything that helps the technician pick the right equipment.',
    }),
    justification: field({
      name: 'justification', label: 'Why is it needed?', type: 'textarea',
    }),
    needed_by: field({ name: 'needed_by', label: 'Needed by', type: 'date' }),
    loan_period_id: field({
      name: 'loan_period_id', label: 'How long for?', type: 'select',
      options: [{ value: '', label: 'Whatever is standard' },
        ...periodsResponse.data.map((p) => ({
          value: p.id, label: `${p.name} — ${p.days === 0 ? 'no due date' : `${p.days} days`}`,
        }))],
    }),
    delivery_mode: field({
      name: 'delivery_mode', label: 'How should it reach the client?', type: 'select',
      value: 'vrc_pickup',
      options: [
        { value: 'vrc_pickup', label: 'I will collect it' },
        { value: 'deliver_to_client', label: 'Deliver it to the client' },
        { value: 'client_pickup', label: 'The client will collect it' },
      ],
    }),
  };

  const errorRegion = el('div', { role: 'alert' });
  const submitButton = el('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, 'Submit request');

  const form = el('form', {
    novalidate: true,
    onSubmit: async (event) => {
      event.preventDefault();
      clear(errorRegion);
      for (const f of Object.values(fields)) f.setError(null);

      const body = {};
      for (const [key, f] of Object.entries(fields)) {
        const value = f.control.value;
        body[key] = value === '' ? null : value;
      }

      if (!body.device_id && !body.requested_category && !body.requested_details) {
        fields.requested_category.setError(
          'Say what is needed — a category, a description, or a specific device.',
        );
        fields.requested_category.control.focus();
        return;
      }

      try {
        const result = await api.createRequest(body);
        toastOk(`Request ${result.request.reference} submitted. A technician will review it.`);
        announce(`Request ${result.request.reference} submitted.`, { assertive: true });
        navigate(`requests/${result.request.id}`);
      } catch (err) {
        if (err.field && fields[err.field]) {
          fields[err.field].setError(err.message);
          fields[err.field].control.focus();
        } else {
          errorRegion.append(alertBox(err.message, { type: 'danger', title: 'Could not submit' }));
        }
      }
    },
  }, [
    el('div', { class: 'card' }, [
      el('h2', { text: 'Who is it for?' }),
      el('div', { class: 'form-grid' }, [fields.client_id, fields.program_id]),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'What is needed?' }),
      fields.requested_category,
      fields.device_id,
      fields.requested_details,
      fields.justification,
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'When and how?' }),
      el('div', { class: 'form-grid' }, [fields.needed_by, fields.loan_period_id]),
      fields.delivery_mode,
    ]),

    errorRegion,
    el('div', { class: 'row' }, [
      submitButton,
      el('a', { class: 'btn btn-ghost', href: '#/requests' }, 'Cancel'),
    ]),
  ]);

  return el('div', {}, [
    el('p', { class: 'breadcrumb' }, [el('a', { href: '#/requests' }, 'Requests'), ' / New']),
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Request a loan' }),
        el('p', { text: 'Tell the loaner pool team what your client needs and when.' }),
      ]),
    ]),
    form,
  ]);
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function renderRequestDetail({ params }) {
  const { request } = await api.requestItem(params.id);
  const container = el('div');

  const rerender = async () => {
    container.replaceWith(await renderRequestDetail({ params }));
  };

  const canReview = can('requests.approve') && request.status === 'submitted';
  const canFulfil = can('requests.fulfill') && request.status === 'approved';

  container.append(
    el('p', { class: 'breadcrumb' }, [el('a', { href: '#/requests' }, 'Requests'), ' / ', request.reference]),

    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: `Request ${request.reference}` }),
        el('p', { text: request.tracking_summary }),
      ]),
      el('div', { class: 'btn-group' }, [
        canReview ? el('button', {
          type: 'button', class: 'btn btn-primary',
          onClick: () => openApproveDialog(request, rerender),
        }, 'Approve') : null,
        canReview ? el('button', {
          type: 'button', class: 'btn btn-danger',
          onClick: () => openDenyDialog(request, rerender),
        }, 'Decline') : null,
        // Must go through the fulfil endpoint, not the plain check-out dialog:
        // that is what links the loan to this request and closes it.
        canFulfil ? el('button', {
          type: 'button', class: 'btn btn-primary',
          onClick: () => openFulfilDialog(request, rerender),
        }, 'Hand it over') : null,
        request.can_be_cancelled ? el('button', {
          type: 'button', class: 'btn',
          onClick: () => openCancelDialog(request, rerender),
        }, 'Cancel request') : null,
      ]),
    ]),

    request.status === 'approved' ? tracker(request) : null,

    request.status === 'denied' && request.review_notes
      ? alertBox(request.review_notes, { type: 'danger', title: 'Why this was declined' })
      : null,

    canFulfil ? fulfilmentControls(request, rerender) : null,

    el('div', { class: 'grid grid-2' }, [
      el('section', { class: 'card', 'aria-labelledby': 'req-details' }, [
        el('h2', { id: 'req-details', text: 'Request' }),
        el('dl', { class: 'detail-list' }, [
          el('dt', { text: 'Status' }), el('dd', {}, pill(request.status, 'request')),
          el('dt', { text: 'Progress' }), val(request.fulfillment_label),
          el('dt', { text: 'Requested by' }), val(request.requester_name),
          el('dt', { text: 'Submitted' }), el('dd', {}, dateCell(request.created_at, { withTime: true })),
          el('dt', { text: 'Client' }), val(request.client_name),
          el('dt', { text: 'Program' }), val(request.program_name),
          el('dt', { text: 'Wanted' }), val(request.device_name || request.requested_category),
          el('dt', { text: 'Details' }), val(request.requested_details),
          el('dt', { text: 'Justification' }), val(request.justification),
          el('dt', { text: 'Needed by' }), el('dd', {}, dateCell(request.needed_by)),
          el('dt', { text: 'Loan period' }), val(request.period_name),
          el('dt', { text: 'Delivery' }), val(deliveryLabel(request.delivery_mode)),
        ]),
      ]),

      el('section', { class: 'card', 'aria-labelledby': 'req-handling' }, [
        el('h2', { id: 'req-handling', text: 'Handling' }),
        el('dl', { class: 'detail-list' }, [
          el('dt', { text: 'Assigned to' }), val(request.assigned_tech_name),
          el('dt', { text: 'Reviewed by' }), val(request.reviewer_name),
          el('dt', { text: 'Reviewed' }), el('dd', {}, dateCell(request.reviewed_at, { withTime: true })),
          el('dt', { text: 'Review notes' }), val(request.review_notes),
          el('dt', { text: 'Device' }),
          request.device_id
            ? el('dd', {}, el('a', { href: `#/devices/${request.device_id}` }, request.device_name))
            : el('dd', { class: 'muted' }, 'Not yet chosen'),
          el('dt', { text: 'Loan' }),
          request.loan_id
            ? el('dd', {}, el('a', { class: 'mono', href: `#/loans/${request.loan_id}` }, request.loan_reference))
            : el('dd', { class: 'muted' }, 'Not yet issued'),
          el('dt', { text: 'Due back' }), el('dd', {}, dateCell(request.loan_due_at)),
        ]),
      ]),
    ]),
  );

  return container;
}

const val = (value) => el('dd', value ? { text: String(value) } : { class: 'muted', text: '—' });

function deliveryLabel(mode) {
  return {
    vrc_pickup: 'Counselor will collect it',
    deliver_to_client: 'Deliver to the client',
    client_pickup: 'Client will collect it',
  }[mode] || mode;
}

/** Progress bar. Each step carries a glyph as well as a colour. */
function tracker(request) {
  const currentIndex = FULFILMENT_ORDER.indexOf(request.fulfillment_state);

  return el('section', { class: 'card', 'aria-labelledby': 'tracker-heading' }, [
    el('h2', { id: 'tracker-heading', text: 'Where it has got to' }),
    el('ol', { class: 'tracker' }, FULFILMENT_ORDER.map((state, index) => {
      const isDone = index < currentIndex;
      const isCurrent = index === currentIndex;
      return el('li', {
        class: isDone ? 'is-done' : isCurrent ? 'is-current' : null,
        'aria-current': isCurrent ? 'step' : null,
      }, [
        FULFILMENT_LABELS[state],
        el('span', { class: 'visually-hidden' },
          isDone ? ' — done' : isCurrent ? ' — current step' : ' — not started'),
      ]);
    })),
  ]);
}

function fulfilmentControls(request, onDone) {
  const next = request.next_states.filter((s) => s !== 'delivered');

  return el('section', { class: 'card', 'aria-labelledby': 'fulfil-heading' }, [
    el('h2', { id: 'fulfil-heading', text: 'Move this along' }),
    el('p', {
      class: 'muted',
      text: 'The counselor sees these updates, so keep them current. Handing the device over is the last step.',
    }),
    el('div', { class: 'btn-group' }, [
      ...next.map((state) => el('button', {
        type: 'button', class: 'btn',
        onClick: async () => {
          try {
            await api.setFulfillment(request.id, { state });
            toastOk(`Marked as "${FULFILMENT_LABELS[state]}".`);
            onDone();
          } catch (err) { toastError(err.message); }
        },
      }, `Mark as ${FULFILMENT_LABELS[state].toLowerCase()}`)),

      el('button', {
        type: 'button', class: 'btn btn-primary',
        onClick: () => openFulfilDialog(request, onDone),
      }, 'Hand over and create the loan'),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

async function openApproveDialog(request, onDone) {
  const [devicesResponse, usersResponse, periodsResponse] = await Promise.all([
    api.devices({ status: 'available', per_page: 200 }),
    can('users.read') ? api.users({ role: 'tech' }) : Promise.resolve({ data: [] }),
    api.loanPeriods(),
  ]);

  const deviceField = field({
    name: 'device_id', label: 'Reserve a device', type: 'select',
    value: request.device_id || '',
    options: [{ value: '', label: 'Decide later' },
      ...devicesResponse.data.map((d) => ({ value: d.id, label: `${d.name} (${d.barcode})` }))],
    help: 'Reserving marks the device so nobody else lends it out in the meantime.',
  });

  const techField = field({
    name: 'assigned_tech_id', label: 'Assign to technician', type: 'select',
    value: request.assigned_tech_id || session.user?.id || '',
    options: [{ value: '', label: 'Unassigned' },
      ...usersResponse.data.map((u) => ({ value: u.id, label: u.full_name }))],
  });

  const periodField = field({
    name: 'loan_period_id', label: 'Loan period', type: 'select',
    value: request.loan_period_id || '',
    options: [{ value: '', label: 'Standard' },
      ...periodsResponse.data.map((p) => ({
        value: p.id, label: `${p.name} — ${p.days === 0 ? 'no due date' : `${p.days} days`}`,
      }))],
  });

  const notesField = field({
    name: 'notes', label: 'Notes for the counselor', type: 'textarea',
    help: 'Included in the approval email.',
  });

  return modal({
    title: `Approve ${request.reference}`,
    body: el('div', {}, [
      el('p', { text: `For ${request.client_name || 'no specific client'} — ${request.requested_category || request.requested_details || 'see details'}.` }),
      deviceField, techField, periodField, notesField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Approve request',
        class: 'btn-primary',
        onClick: async (close) => {
          try {
            await api.approveRequest(request.id, {
              device_id: deviceField.control.value || null,
              assigned_tech_id: techField.control.value || null,
              loan_period_id: periodField.control.value || null,
              notes: notesField.control.value || null,
            });
            toastOk('Request approved and the counselor notified.');
            close(true);
            onDone();
          } catch (err) { toastError(err.message); }
        },
      },
    ],
  });
}

async function openDenyDialog(request, onDone) {
  const notesField = field({
    name: 'notes', label: 'Reason', type: 'textarea', required: true,
    help: 'The counselor sees this, so explain what they could do instead.',
  });

  return modal({
    title: `Decline ${request.reference}`,
    body: el('div', {}, [
      el('p', { text: 'A reason is required — a bare refusal leaves the counselor with nowhere to go.' }),
      notesField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Decline request',
        class: 'btn-danger',
        onClick: async (close) => {
          const notes = notesField.control.value.trim();
          if (!notes) {
            notesField.setError('Give a reason.');
            notesField.control.focus();
            return;
          }
          try {
            await api.denyRequest(request.id, { notes });
            toastOk('Request declined and the counselor notified.');
            close(true);
            onDone();
          } catch (err) { toastError(err.message); }
        },
      },
    ],
  });
}

async function openFulfilDialog(request, onDone) {
  const barcodeField = field({
    name: 'device', label: 'Device barcode', required: true,
    value: request.device_barcode || '',
    help: 'Scan the label on the device actually being handed over.',
    autocomplete: 'off',
  });
  const conditionField = field({ name: 'condition_out', label: 'Condition going out', value: 'Good' });
  const notesField = field({ name: 'notes', label: 'Notes', type: 'textarea' });

  return modal({
    title: `Hand over ${request.reference}`,
    body: el('div', {}, [
      el('p', {
        text:
          'This creates the loan record and closes the request. The client and technician on the ' +
          'request are carried over automatically.',
      }),
      barcodeField, conditionField, notesField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Create the loan',
        class: 'btn-primary',
        onClick: async (close) => {
          const device = barcodeField.control.value.trim();
          if (!device) {
            barcodeField.setError('Scan or type the device barcode.');
            barcodeField.control.focus();
            return;
          }
          try {
            const result = await api.fulfilRequest(request.id, {
              device,
              condition_out: conditionField.control.value || null,
              notes: notesField.control.value || null,
            });
            toastOk(
              `Loan ${result.loan.reference} created. ` +
              (result.loan.due_at ? `Due back ${formatDate(result.loan.due_at)}.` : 'No return date.'),
            );
            close(true);
            onDone();
          } catch (err) {
            barcodeField.setError(err.message);
            barcodeField.control.focus();
          }
        },
      },
    ],
  });
}

async function openCancelDialog(request, onDone) {
  const reasonField = field({ name: 'reason', label: 'Reason', type: 'textarea' });

  return modal({
    title: `Cancel ${request.reference}`,
    body: el('div', {}, [
      el('p', { text: 'Any device reserved for this request goes back into the pool.' }),
      reasonField,
    ]),
    actions: [
      { label: 'Keep the request', class: 'btn-ghost', value: null },
      {
        label: 'Cancel request',
        class: 'btn-danger',
        onClick: async (close) => {
          try {
            await api.cancelRequest(request.id, { reason: reasonField.control.value || null });
            toastOk('Request cancelled.');
            close(true);
            onDone();
          } catch (err) { toastError(err.message); }
        },
      },
    ],
  });
}
