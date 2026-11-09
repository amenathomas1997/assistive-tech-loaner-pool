/**
 * Audit log and usage reports.
 *
 * Charts are inline SVG built here rather than pulled from a charting library:
 * the app ships no external scripts, and every figure is also present as text
 * in an adjacent table, so nothing depends on being able to see the chart.
 */

import { api, downloadUrl } from '../api.js';
import {
  el, clear, mount, field, dataTable, dateCell, pill, emptyState, pagination,
  announce, debounce, loadingBlock, alert as alertBox, formatDate,
} from '../ui.js';
import { can } from '../app.js';

// ===========================================================================
// Audit log
// ===========================================================================

export async function renderAudit() {
  const container = el('div');
  const results = el('div');
  const state = { page: 1, search: '', actionPrefix: '', from: '', to: '' };

  const actions = await api.auditActions();
  const groups = [...new Set(actions.data.map((a) => a.group))].sort();

  const searchField = field({ name: 'search', label: 'Search', type: 'search', placeholder: 'Anything in the summary' });
  searchField.classList.add('field-grow');

  const groupField = field({
    name: 'group', label: 'Activity type', type: 'select',
    options: [{ value: '', label: 'Everything' },
      // In the order a person reads them, not the order of the internal keys.
      ...groups
        .map((g) => ({ value: g, label: groupLabel(g) }))
        .sort((a, b) => a.label.localeCompare(b.label))],
  });

  const fromField = field({ name: 'from', label: 'From', type: 'date' });
  const toField = field({ name: 'to', label: 'To', type: 'date' });

  const load = async () => {
    clear(results).append(loadingBlock('Loading the audit log…'));
    try {
      const response = await api.audit({
        page: state.page, per_page: 50, search: state.search,
        action_prefix: state.actionPrefix, from: state.from, to: state.to,
      });

      clear(results).append(
        dataTable({
          caption: 'Everything that has happened in this system',
          columns: [
            { key: 'when', label: 'When', render: (r) => dateCell(r.created_at, { withTime: true }) },
            {
              key: 'who', label: 'Who',
              render: (r) => el('span', {}, [
                r.actor_name || r.actor_label || 'System',
                r.actor_type === 'api_key' ? el('span', { class: 'cell-sub', text: 'via API key' }) : null,
              ]),
            },
            { key: 'action', label: 'Action', render: (r) => el('span', { class: 'mono' }, r.action) },
            { key: 'summary', label: 'What happened', render: (r) => r.summary || '—' },
          ],
          rows: response.data,
          emptyMessage: 'Nothing matches these filters.',
        }),
        pagination(response.meta, (page) => { state.page = page; load(); }),
      );

      announce(`${response.meta.total} audit entries found.`);
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load the audit log' }));
    }
  };

  // The export gives you what you are looking at. It used to ignore every
  // filter and hand back the newest 10,000 entries regardless, so narrowing
  // to one week of sign-ins and pressing Export produced something else.
  const exportLink = el('a', { class: 'btn', href: downloadUrl('/audit/export.csv', {}) }, 'Export CSV');
  const syncExport = () => {
    exportLink.href = downloadUrl('/audit/export.csv', {
      search: state.search, action_prefix: state.actionPrefix, from: state.from, to: state.to,
    });
  };

  const runFilter = debounce(() => { state.page = 1; load(); });
  searchField.control.addEventListener('input', (e) => { state.search = e.target.value; syncExport(); runFilter(); });
  groupField.control.addEventListener('change', (e) => { state.actionPrefix = e.target.value; state.page = 1; syncExport(); load(); });
  fromField.control.addEventListener('change', (e) => { state.from = e.target.value; state.page = 1; syncExport(); load(); });
  toField.control.addEventListener('change', (e) => { state.to = e.target.value; state.page = 1; syncExport(); load(); });

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Audit log' }),
        el('p', {
          text:
            'An append-only record of every change. Nothing in this system edits or deletes these ' +
            'entries, including administrators.',
        }),
      ]),
      exportLink,
    ]),

    el('form', {
      class: 'filters', role: 'search', 'aria-label': 'Filter the audit log',
      onSubmit: (e) => e.preventDefault(),
    }, [searchField, groupField, fromField, toField]),

    results,
  );

  load();
  return container;
}

function groupLabel(group) {
  return {
    auth: 'Sign-ins', device: 'Devices', loan: 'Loans', request: 'Requests',
    client: 'Clients', program: 'Programs', user: 'Staff accounts',
    settings: 'Settings', period: 'Loan periods', apikey: 'API keys',
    email: 'Email', install: 'Installation',
    agreement: 'Loan agreements', attachment: 'Photos and files', backup: 'Backups',
    kit: 'Kits', repair: 'Repairs', reservation: 'Waitlist', retention: 'Data retention',
    site: 'Sites and transfers', sms: 'Text messages',
  }[group] || group;
}

// ===========================================================================
// Reports
// ===========================================================================

export async function renderReports() {
  const container = el('div');
  const body = el('div');
  const state = { from: '', to: '' };

  const fromField = field({ name: 'from', label: 'From', type: 'date' });
  const toField = field({ name: 'to', label: 'To', type: 'date' });

  const load = async () => {
    clear(body).append(loadingBlock('Building reports…'));
    try {
      const report = await api.report({ from: state.from, to: state.to });
      const [funding, repairs] = await Promise.all([
        api.fundingReport({ from: state.from, to: state.to }).catch(() => null),
        api.repairSummary({ from: state.from, to: state.to }).catch(() => null),
      ]);

      mount(clear(body),
        headlineStats(report),
        el('div', { class: 'grid grid-2' }, [
          trendCard(report.trend),
          returnPerformanceCard(report.return_performance, report.request_performance),
        ]),
        funding ? fundingCard(funding, { from: state.from, to: state.to }) : null,
        repairs ? repairsCard(repairs) : null,
        categoryCard(report.categories),
        el('div', { class: 'grid grid-2' }, [
          activityCard('Clients', report.activity.clients),
          activityCard('Programs', report.activity.programs),
        ]),
        activityCard('Technicians', report.activity.techs),
        idleCard(report.idle_devices),
        scanAdoptionCard(report.scan_adoption),
      );
      announce('Reports updated.');
    } catch (err) {
      clear(body).append(alertBox(err.message, { type: 'danger', title: 'Could not build reports' }));
    }
  };

  // Exports cover the dates on screen, not all time.
  const usageExport = el('a', { class: 'btn', href: downloadUrl('/reports/devices.csv', {}) }, 'Export device usage');
  const syncExport = () => {
    usageExport.href = downloadUrl('/reports/devices.csv', { from: state.from, to: state.to });
  };

  fromField.control.addEventListener('change', (e) => { state.from = e.target.value; syncExport(); load(); });
  toField.control.addEventListener('change', (e) => { state.to = e.target.value; syncExport(); load(); });

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Reports' }),
        el('p', { text: 'How often equipment is used, what is in demand, and what never moves.' }),
      ]),
      usageExport,
    ]),

    el('form', {
      class: 'filters', 'aria-label': 'Report date range',
      onSubmit: (e) => e.preventDefault(),
    }, [
      fromField, toField,
      el('div', { class: 'field' }, [
        el('span', { class: 'label' }, ' '),
        el('button', {
          type: 'button', class: 'btn',
          onClick: () => {
            state.from = ''; state.to = '';
            fromField.control.value = ''; toField.control.value = '';
            load();
          },
        }, 'All time'),
      ]),
    ]),

    body,
  );

  load();
  return container;
}

function headlineStats(report) {
  const s = report.summary;
  const tiles = [
    { label: 'Devices', value: s.devices.total, note: `${s.devices.available} available` },
    { label: 'Utilisation', value: `${s.devices.utilisation_percent}%`, note: 'of the lendable pool is out' },
    { label: 'Loans all time', value: s.loans.total, note: `${s.loans.active} active now` },
    {
      label: 'Returned on time',
      value: report.return_performance.on_time_rate_percent === null
        ? '—'
        : `${report.return_performance.on_time_rate_percent}%`,
      note: `${report.return_performance.completed_loans} completed loans`,
    },
  ];

  return el('div', { class: 'grid grid-4' }, tiles.map((tile) =>
    el('div', { class: 'stat is-info' }, [
      el('span', { class: 'stat-label', text: tile.label }),
      el('span', { class: 'stat-value', text: String(tile.value) }),
      el('span', { class: 'stat-note', text: tile.note }),
    ])));
}

/**
 * Bar chart of loans per month.
 *
 * The SVG is aria-hidden and the same numbers follow in a real table — a
 * chart that a screen reader narrates as a list of path coordinates is worse
 * than no chart at all.
 */
function trendCard(trend) {
  if (!trend.length) {
    return el('section', { class: 'card' }, [
      el('h2', { text: 'Loans over time' }),
      emptyState({ icon: '📈', title: 'No loans yet', message: 'Once devices start going out, the trend appears here.' }),
    ]);
  }

  const max = Math.max(...trend.map((t) => t.checked_out), 1);
  const width = 100;
  const height = 40;
  const barWidth = width / trend.length;

  const bars = trend.map((point, index) => {
    const barHeight = (point.checked_out / max) * (height - 4);
    return `<rect x="${(index * barWidth + barWidth * 0.15).toFixed(2)}" ` +
           `y="${(height - barHeight).toFixed(2)}" ` +
           `width="${(barWidth * 0.7).toFixed(2)}" height="${barHeight.toFixed(2)}" ` +
           `rx="0.6" fill="currentColor" />`;
  }).join('');

  return el('section', { class: 'card', 'aria-labelledby': 'trend-heading' }, [
    el('h2', { id: 'trend-heading', text: 'Loans over time' }),
    el('div', {
      style: { color: 'var(--brand)', marginBottom: '12px' },
      'aria-hidden': 'true',
      html: `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:120px" preserveAspectRatio="none">${bars}</svg>`,
    }),
    dataTable({
      caption: 'Loans issued and returned each month',
      columns: [
        { key: 'period', label: 'Month' },
        { key: 'checked_out', label: 'Issued', align: 'right', render: (t) => String(t.checked_out) },
        { key: 'returned', label: 'Returned', align: 'right', render: (t) => String(t.returned) },
        {
          key: 'late', label: 'Returned late', align: 'right',
          render: (t) => t.late_rate_percent === null
            ? '—'
            : `${t.returned_late} (${t.late_rate_percent}%)`,
        },
      ],
      rows: trend,
    }),
  ]);
}

function returnPerformanceCard(returns, requests) {
  return el('section', { class: 'card', 'aria-labelledby': 'returns-heading' }, [
    el('h2', { id: 'returns-heading', text: 'Returns and requests' }),
    el('h3', { text: 'Returns' }),
    el('dl', { class: 'detail-list' }, [
      el('dt', { text: 'Completed loans' }), el('dd', { text: String(returns.completed_loans) }),
      el('dt', { text: 'On time' }), el('dd', { text: String(returns.on_time) }),
      el('dt', { text: 'Late' }), el('dd', { text: String(returns.late) }),
      el('dt', { text: 'On-time rate' }),
      el('dd', { text: returns.on_time_rate_percent === null ? '—' : `${returns.on_time_rate_percent}%` }),
      el('dt', { text: 'Average loan length' }), el('dd', { text: `${returns.avg_loan_days} days` }),
      el('dt', { text: 'Average days late' }), el('dd', { text: `${returns.avg_days_late} days` }),
      el('dt', { text: 'Worst overrun' }), el('dd', { text: `${returns.max_days_late} days` }),
    ]),
    el('hr', { class: 'divider' }),
    el('h3', { text: 'Requests' }),
    el('dl', { class: 'detail-list' }, [
      el('dt', { text: 'Total' }), el('dd', { text: String(requests.total) }),
      el('dt', { text: 'Approved' }), el('dd', { text: String(requests.approved) }),
      el('dt', { text: 'Declined' }), el('dd', { text: String(requests.denied) }),
      el('dt', { text: 'Delivered' }), el('dd', { text: String(requests.fulfilled) }),
      el('dt', { text: 'Still awaiting review' }), el('dd', { text: String(requests.awaiting_review) }),
      el('dt', { text: 'Average time to review' }), el('dd', { text: `${requests.avg_hours_to_review} hours` }),
      el('dt', { text: 'Average time to deliver' }), el('dd', { text: `${requests.avg_hours_to_fulfil} hours` }),
    ]),
  ]);
}

/**
 * Funding and grant reporting.
 *
 * "Cost per loan" and "cost per client" are the figures funders actually ask
 * for. Both are null rather than zero when no purchase cost is recorded, so a
 * missing price never masquerades as free equipment.
 */
function fundingCard(funding, range = {}) {
  return el('section', { class: 'card', 'aria-labelledby': 'funding-heading' }, [
    el('div', { class: 'card-header' }, [
      el('h2', { id: 'funding-heading', text: 'Funding and grant reporting' }),
      el('a', { class: 'btn btn-sm', href: downloadUrl('/reports/funding.csv', range) }, 'Export CSV'),
    ]),
    el('p', {
      class: 'muted',
      text:
        'What each funding source bought, how hard it has worked, and how many people it reached. ' +
        'Cost figures are blank where no purchase price was recorded.',
    }),
    dataTable({
      caption: 'Utilisation and spend by funding source',
      columns: [
        { key: 'funding_source', label: 'Funding source' },
        { key: 'device_count', label: 'Devices', align: 'right', render: (r) => String(r.device_count) },
        {
          key: 'total_cost', label: 'Spend', align: 'right',
          render: (r) => (r.total_cost ? r.total_cost.toFixed(2) : '—'),
        },
        { key: 'loan_count', label: 'Loans', align: 'right', render: (r) => String(r.loan_count) },
        { key: 'clients_served', label: 'People reached', align: 'right', render: (r) => String(r.clients_served) },
        {
          key: 'loans_per_device', label: 'Loans per device', align: 'right',
          render: (r) => r.loans_per_device === null ? '—' : String(r.loans_per_device),
        },
        {
          key: 'cost_per_loan', label: 'Cost per loan', align: 'right',
          render: (r) => (r.cost_per_loan === null ? '—' : r.cost_per_loan.toFixed(2)),
        },
        {
          key: 'cost_per_client', label: 'Cost per person', align: 'right',
          render: (r) => (r.cost_per_client === null ? '—' : r.cost_per_client.toFixed(2)),
        },
        {
          key: 'losses', label: 'Retired / lost', align: 'right',
          render: (r) => `${r.retired_count} / ${r.lost_count}`,
        },
      ],
      rows: funding.by_funding_source,
      emptyMessage: 'No devices recorded yet.',
    }),

    el('h3', { text: 'By program', style: { marginTop: '18px' } }),
    dataTable({
      caption: 'Loan activity by program',
      columns: [
        { key: 'program', label: 'Program' },
        { key: 'loan_count', label: 'Loans', align: 'right', render: (r) => String(r.loan_count) },
        { key: 'clients_served', label: 'People reached', align: 'right', render: (r) => String(r.clients_served) },
        { key: 'devices_used', label: 'Devices used', align: 'right', render: (r) => String(r.devices_used) },
        {
          key: 'avg_loan_days', label: 'Average loan', align: 'right',
          render: (r) => r.avg_loan_days === null ? '—' : `${r.avg_loan_days} days`,
        },
      ],
      rows: funding.by_program,
      emptyMessage: 'No program activity yet.',
    }),
  ]);
}

function repairsCard(repairs) {
  return el('section', { class: 'card', 'aria-labelledby': 'repairs-report-heading' }, [
    el('h2', { id: 'repairs-report-heading', text: 'Repairs and downtime' }),
    el('div', { class: 'grid grid-4' }, [
      statTile('Open now', repairs.open, repairs.open > 0 ? 'is-warn' : 'is-ok'),
      statTile('Repaired', repairs.repaired, 'is-ok'),
      statTile('Beyond repair', repairs.unrepairable, repairs.unrepairable > 0 ? 'is-danger' : ''),
      statTile('Total spend', repairs.total_cost.toFixed(2), 'is-info'),
    ]),
    el('p', {
      class: 'muted', style: { marginTop: '10px' },
      text:
        `Average ${repairs.avg_days_to_close} days to close a ticket. ` +
        `${repairs.out_of_warranty_cost.toFixed(2)} of the spend was outside warranty.`,
    }),
    repairs.repeat_offenders.length
      ? el('div', {}, [
          el('h3', { text: 'Devices repaired more than once' }),
          el('p', { class: 'muted', text: 'Candidates for replacement rather than another repair.' }),
          dataTable({
            caption: 'Devices with repeated repairs',
            columns: [
              {
                key: 'name', label: 'Device',
                render: (d) => el('a', { href: `#/devices/${d.id}` }, [
                  d.name, el('span', { class: 'cell-sub mono', text: d.barcode }),
                ]),
              },
              { key: 'repair_count', label: 'Repairs', align: 'right', render: (d) => String(d.repair_count) },
              { key: 'total_cost', label: 'Spent', align: 'right', render: (d) => d.total_cost.toFixed(2) },
            ],
            rows: repairs.repeat_offenders,
          }),
        ])
      : null,
    repairs.by_vendor.length
      ? dataTable({
          caption: 'Repair spend by vendor',
          columns: [
            { key: 'vendor', label: 'Vendor' },
            { key: 'tickets', label: 'Tickets', align: 'right', render: (v) => String(v.tickets) },
            { key: 'cost', label: 'Spend', align: 'right', render: (v) => v.cost.toFixed(2) },
            { key: 'avg_days', label: 'Average turnaround', align: 'right', render: (v) => `${v.avg_days} days` },
          ],
          rows: repairs.by_vendor,
        })
      : null,
  ]);
}

function statTile(label, value, tone = '') {
  return el('div', { class: `stat ${tone}`.trim() }, [
    el('span', { class: 'stat-label', text: label }),
    el('span', { class: 'stat-value', style: { fontSize: '1.5rem' }, text: String(value) }),
  ]);
}

function categoryCard(categories) {
  return el('section', { class: 'card', 'aria-labelledby': 'category-heading' }, [
    el('h2', { id: 'category-heading', text: 'Demand by category' }),
    el('p', {
      class: 'muted',
      text:
        '"Turns per device" is how many loans each unit in the category has served. A high number ' +
        'with nothing available suggests you need more of it.',
    }),
    dataTable({
      caption: 'How heavily each category of equipment is used',
      columns: [
        { key: 'category', label: 'Category' },
        { key: 'device_count', label: 'Units', align: 'right', render: (c) => String(c.device_count) },
        { key: 'loan_count', label: 'Loans', align: 'right', render: (c) => String(c.loan_count) },
        {
          key: 'turns_per_device', label: 'Turns per device', align: 'right',
          // Null where the category has no units left to divide by — a
          // retired-only category. String(null) printed the word "null".
          render: (c) => c.turns_per_device === null ? '—' : String(c.turns_per_device),
        },
        {
          key: 'avg_loan_days', label: 'Average loan', align: 'right',
          render: (c) => c.avg_loan_days === null ? '—' : `${c.avg_loan_days} days`,
        },
        {
          key: 'availability', label: 'Available now', align: 'right',
          render: (c) => el('span', {}, [
            `${c.currently_available} of ${c.device_count}`,
            c.currently_available === 0 && c.device_count > 0
              ? el('span', { class: 'cell-sub', style: { color: 'var(--warn)' } }, 'None spare')
              : null,
          ]),
        },
      ],
      rows: categories,
      emptyMessage: 'No categories yet.',
    }),
  ]);
}

function activityCard(title, rows) {
  return el('section', { class: 'card', 'aria-labelledby': `activity-${title.toLowerCase()}` }, [
    el('h2', { id: `activity-${title.toLowerCase()}`, text: `Most active ${title.toLowerCase()}` }),
    dataTable({
      caption: `Loan activity by ${title.toLowerCase()}`,
      columns: [
        { key: 'name', label: title.replace(/s$/, '') },
        { key: 'loan_count', label: 'Loans', align: 'right', render: (r) => String(r.loan_count) },
        { key: 'active_count', label: 'Out now', align: 'right', render: (r) => String(r.active_count) },
        {
          key: 'overdue_count', label: 'Overdue', align: 'right',
          render: (r) => r.overdue_count > 0
            ? el('span', { class: 'pill pill-danger' }, String(r.overdue_count))
            : '0',
        },
        {
          key: 'avg_loan_days', label: 'Average loan', align: 'right',
          render: (r) => r.avg_loan_days === null ? '—' : `${r.avg_loan_days} days`,
        },
        { key: 'last_loan_at', label: 'Last loan', align: 'right', render: (r) => dateCell(r.last_loan_at) },
      ],
      rows,
      emptyMessage: `No ${title.toLowerCase()} have borrowed anything yet.`,
    }),
  ]);
}

function idleCard(devices) {
  return el('section', { class: 'card', 'aria-labelledby': 'idle-heading' }, [
    el('h2', { id: 'idle-heading', text: 'Equipment that is not moving' }),
    el('p', {
      class: 'muted',
      text: 'Devices never loaned, or not loaned in the last six months. Candidates for redeployment.',
    }),
    dataTable({
      caption: 'Devices that have not been loaned recently',
      columns: [
        {
          key: 'name', label: 'Device',
          render: (d) => el('a', { href: `#/devices/${d.id}` }, [
            d.name, el('span', { class: 'cell-sub mono', text: d.barcode }),
          ]),
        },
        { key: 'category', label: 'Category', render: (d) => d.category || '—' },
        { key: 'location', label: 'Location', render: (d) => d.location || '—' },
        { key: 'lifetime_loans', label: 'Loans ever', align: 'right', render: (d) => String(d.lifetime_loans) },
        {
          key: 'last', label: 'Last loaned', align: 'right',
          render: (d) => d.never_loaned
            ? el('span', { class: 'pill pill-warn' }, 'Never')
            : el('span', {}, [
                dateCell(d.last_out_at),
                el('span', { class: 'cell-sub', text: `${d.days_idle} days ago` }),
              ]),
        },
      ],
      rows: devices,
      emptyMessage: 'Everything has been out recently.',
    }),
  ]);
}

function scanAdoptionCard(adoption) {
  return el('section', { class: 'card', 'aria-labelledby': 'scan-heading' }, [
    el('h2', { id: 'scan-heading', text: 'How transactions are being recorded' }),
    el('p', {
      class: 'muted',
      text: 'Whether barcode scanning is actually being used, or people are falling back to manual entry.',
    }),
    el('div', { class: 'grid grid-2' }, [
      el('div', {}, [
        el('h3', { text: 'Check-outs' }),
        el('dl', { class: 'detail-list' }, [
          el('dt', { text: 'By scan' }),
          el('dd', { text: `${adoption.check_out.scanned} (${adoption.check_out.scan_percent}%)` }),
          el('dt', { text: 'Manually' }), el('dd', { text: String(adoption.check_out.manual) }),
          el('dt', { text: 'From a request' }), el('dd', { text: String(adoption.check_out.request) }),
          el('dt', { text: 'Via the API' }), el('dd', { text: String(adoption.check_out.api) }),
        ]),
      ]),
      el('div', {}, [
        el('h3', { text: 'Check-ins' }),
        el('dl', { class: 'detail-list' }, [
          el('dt', { text: 'By scan' }),
          el('dd', { text: `${adoption.check_in.scanned} (${adoption.check_in.scan_percent}%)` }),
          el('dt', { text: 'Manually' }), el('dd', { text: String(adoption.check_in.manual) }),
          el('dt', { text: 'Via the API' }), el('dd', { text: String(adoption.check_in.api) }),
        ]),
      ]),
    ]),
  ]);
}
