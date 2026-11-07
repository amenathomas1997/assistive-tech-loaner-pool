/**
 * Dashboard: the state of the pool at a glance, plus the things that need
 * someone to act today.
 */

import { api } from '../api.js';
import { el, dataTable, dateCell, pill, emptyState } from '../ui.js';
import { can, session } from '../app.js';

export async function renderDashboard() {
  const summary = can('reports.read') ? await api.summary() : null;

  const overdue = can('loans.read')
    ? await api.loans({ status: 'overdue', per_page: 10 })
    : { data: [] };

  const dueSoon = can('loans.read')
    ? await api.loans({ status: 'due_soon', per_page: 10 })
    : { data: [] };

  const openRequests = can('requests.read')
    ? await api.requests({ open: true, per_page: 10, sort: 'created_at' })
    : { data: [] };

  return el('div', {}, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: `Good day, ${firstName(session.user?.full_name)}` }),
        el('p', { text: session.organization?.name || '' }),
      ]),
      el('div', { class: 'btn-group' }, [
        can('scan.use') ? el('a', { class: 'btn btn-primary', href: '#/scan' }, 'Open scan station') : null,
        can('requests.write') ? el('a', { class: 'btn', href: '#/requests/new' }, 'Request a loan') : null,
      ]),
    ]),

    summary ? statTiles(summary) : null,

    el('div', { class: 'grid grid-2', style: { marginTop: '18px' } }, [
      overdueCard(overdue.data),
      dueSoonCard(dueSoon.data),
    ]),

    can('requests.read') ? requestsCard(openRequests.data) : null,
  ]);
}

function firstName(full) {
  return String(full || '').split(/\s+/)[0] || 'there';
}

function statTiles(summary) {
  const tiles = [
    {
      label: 'Devices',
      value: summary.devices.total,
      note: `${summary.devices.available} available now`,
      href: '#/devices',
      tone: 'is-info',
    },
    {
      label: 'On loan',
      value: summary.devices.checked_out,
      note: `${summary.devices.utilisation_percent}% of the lendable pool`,
      href: '#/loans?status=active',
      tone: 'is-info',
    },
    {
      label: 'Overdue',
      value: summary.loans.overdue,
      note: summary.loans.overdue === 0 ? 'Nothing is late' : 'Needs chasing',
      href: '#/loans?status=overdue',
      tone: summary.loans.overdue > 0 ? 'is-danger' : 'is-ok',
    },
    {
      label: 'Awaiting review',
      value: summary.requests.awaiting_review,
      note: summary.requests.awaiting_review === 0 ? 'No new requests' : 'Requests to look at',
      href: '#/requests?status=submitted',
      tone: summary.requests.awaiting_review > 0 ? 'is-warn' : 'is-ok',
    },
  ];

  const secondary = [
    { label: 'Due within 7 days', value: summary.loans.due_within_7_days },
    { label: 'Being provisioned', value: summary.requests.provisioning },
    { label: 'Ready for pickup', value: summary.requests.ready_pickup },
    { label: 'In maintenance', value: summary.devices.maintenance },
  ];

  return el('div', {}, [
    el('h2', { class: 'visually-hidden' }, 'Summary'),
    el('div', { class: 'grid grid-4' }, tiles.map((tile) =>
      el('a', { class: `stat ${tile.tone}`, href: tile.href }, [
        el('span', { class: 'stat-label', text: tile.label }),
        el('span', { class: 'stat-value', text: String(tile.value) }),
        el('span', { class: 'stat-note', text: tile.note }),
      ]))),

    el('div', { class: 'grid grid-4', style: { marginTop: '12px' } }, secondary.map((tile) =>
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat-label', text: tile.label }),
        el('span', { class: 'stat-value', style: { fontSize: '1.4rem' }, text: String(tile.value) }),
      ]))),
  ]);
}

function overdueCard(loans) {
  return el('section', { class: 'card', 'aria-labelledby': 'overdue-heading' }, [
    el('div', { class: 'card-header' }, [
      el('h2', { id: 'overdue-heading', text: 'Overdue loans' }),
      loans.length ? el('a', { class: 'btn btn-sm', href: '#/loans?status=overdue' }, 'See all') : null,
    ]),
    loans.length
      ? dataTable({
          caption: 'Loans that are past their due date',
          columns: [
            {
              key: 'device', label: 'Device',
              render: (loan) => el('a', { href: `#/loans/${loan.id}` }, [
                loan.device_name,
                el('span', { class: 'cell-sub mono', text: loan.device_barcode }),
              ]),
            },
            { key: 'holder', label: 'Held by', render: (loan) => loan.holder_summary },
            {
              key: 'due', label: 'Due', align: 'right',
              render: (loan) => el('span', {}, [
                dateCell(loan.due_at),
                el('span', { class: 'cell-sub', text: `${loan.days_overdue} days late` }),
              ]),
            },
          ],
          rows: loans,
          rowClass: () => 'row-danger',
        })
      : emptyState({ icon: '✓', title: 'Nothing is overdue', message: 'Every loan is within its return date.' }),
  ]);
}

function dueSoonCard(loans) {
  return el('section', { class: 'card', 'aria-labelledby': 'duesoon-heading' }, [
    el('div', { class: 'card-header' }, [
      el('h2', { id: 'duesoon-heading', text: 'Due back soon' }),
      loans.length ? el('a', { class: 'btn btn-sm', href: '#/loans?status=due_soon' }, 'See all') : null,
    ]),
    loans.length
      ? dataTable({
          caption: 'Loans approaching their due date',
          columns: [
            {
              key: 'device', label: 'Device',
              render: (loan) => el('a', { href: `#/loans/${loan.id}` }, [
                loan.device_name,
                el('span', { class: 'cell-sub mono', text: loan.device_barcode }),
              ]),
            },
            { key: 'holder', label: 'Held by', render: (loan) => loan.holder_summary },
            { key: 'due', label: 'Due', align: 'right', render: (loan) => dateCell(loan.due_at, { relative: true }) },
          ],
          rows: loans,
        })
      : emptyState({ icon: '🗓', title: 'Nothing due imminently', message: 'No loans are due back in the next few days.' }),
  ]);
}

function requestsCard(requests) {
  return el('section', { class: 'card', 'aria-labelledby': 'requests-heading' }, [
    el('div', { class: 'card-header' }, [
      el('h2', { id: 'requests-heading', text: 'Open loan requests' }),
      el('a', { class: 'btn btn-sm', href: '#/requests' }, 'See all'),
    ]),
    requests.length
      ? dataTable({
          caption: 'Requests that are not yet delivered',
          columns: [
            {
              key: 'reference', label: 'Reference',
              render: (r) => el('a', { class: 'mono', href: `#/requests/${r.id}` }, r.reference),
            },
            { key: 'client', label: 'Client', render: (r) => r.client_name || '—' },
            { key: 'what', label: 'Wanted', render: (r) => r.device_name || r.requested_category || r.requested_details || '—' },
            { key: 'status', label: 'Status', render: (r) => pill(r.status, 'request') },
            { key: 'progress', label: 'Progress', render: (r) => r.tracking_summary },
            { key: 'needed', label: 'Needed by', align: 'right', render: (r) => dateCell(r.needed_by) },
          ],
          rows: requests,
        })
      : emptyState({ icon: '📭', title: 'No open requests', message: 'Nothing is waiting for review or delivery.' }),
  ]);
}
