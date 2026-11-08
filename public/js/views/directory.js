/**
 * Clients, programs and staff accounts.
 */

import { api } from '../api.js';
import {
  el, clear, field, dataTable, dateCell, pill, emptyState, pagination, modal,
  toastOk, toastError, announce, debounce, loadingBlock, alert as alertBox, confirmDialog,
} from '../ui.js';
import { can, session } from '../app.js';

// ===========================================================================
// Clients
// ===========================================================================

export async function renderClients() {
  const container = el('div');
  const results = el('div');
  const state = { page: 1, search: '' };

  const searchField = field({
    name: 'search', label: 'Search clients', type: 'search',
    placeholder: 'Name, reference, email or phone',
  });
  searchField.classList.add('field-grow');

  const load = async () => {
    clear(results).append(loadingBlock('Loading clients…'));
    try {
      const response = await api.clients({ page: state.page, per_page: 25, search: state.search });

      clear(results).append(
        dataTable({
          caption: 'Clients',
          columns: [
            {
              key: 'name', label: 'Name',
              render: (c) => el('span', {}, [
                c.full_name,
                c.external_ref ? el('span', { class: 'cell-sub mono', text: c.external_ref }) : null,
              ]),
            },
            { key: 'counselor', label: 'Counselor', render: (c) => c.counselor_name || '—' },
            { key: 'program', label: 'Program', render: (c) => c.program_name || '—' },
            {
              key: 'loans', label: 'On loan', align: 'right',
              render: (c) => el('span', {}, [
                String(c.active_loan_count),
                c.overdue_loan_count > 0
                  ? el('span', { class: 'cell-sub', style: { color: 'var(--danger)' } },
                      `${c.overdue_loan_count} overdue`)
                  : null,
              ]),
            },
            { key: 'contact', label: 'Contact', render: (c) => c.email || c.phone || '—' },
            {
              key: 'actions', label: 'Actions', align: 'right',
              render: (c) => can('clients.write')
                ? el('button', {
                    type: 'button', class: 'btn btn-sm',
                    onClick: () => openClientDialog(c, load),
                  }, ['Edit', el('span', { class: 'visually-hidden' }, ` ${c.full_name}`)])
                : el('span', { class: 'muted' }, '—'),
            },
          ],
          rows: response.data,
          rowClass: (c) => (c.overdue_loan_count > 0 ? 'row-danger' : null),
          emptyMessage: state.search ? 'No clients match that search.' : 'No clients yet.',
        }),
        pagination(response.meta, (page) => { state.page = page; load(); }),
      );

      announce(`${response.meta.total} client${response.meta.total === 1 ? '' : 's'} found.`);
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load clients' }));
    }
  };

  const runSearch = debounce(() => { state.page = 1; load(); });
  searchField.control.addEventListener('input', (e) => { state.search = e.target.value; runSearch(); });

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Clients' }),
        el('p', {
          text: session.user?.role === 'vrc'
            ? 'The clients on your caseload.'
            : 'People that equipment is loaned to.',
        }),
      ]),
      can('clients.write')
        ? el('button', {
            type: 'button', class: 'btn btn-primary', onClick: () => openClientDialog(null, load),
          }, 'Add client')
        : null,
    ]),
    el('form', {
      class: 'filters', role: 'search', 'aria-label': 'Search clients',
      onSubmit: (e) => e.preventDefault(),
    }, [searchField]),
    results,
  );

  load();
  return container;
}

async function openClientDialog(client, onDone) {
  const [usersResponse, programsResponse] = await Promise.all([
    can('users.read') ? api.users({ role: 'vrc' }) : Promise.resolve({ data: [] }),
    api.programs(),
  ]);

  const fields = {
    first_name: field({ name: 'first_name', label: 'First name', required: true, value: client?.first_name || '', autocomplete: 'off' }),
    last_name: field({ name: 'last_name', label: 'Last name', required: true, value: client?.last_name || '', autocomplete: 'off' }),
    external_ref: field({
      name: 'external_ref', label: 'Case reference', value: client?.external_ref || '',
      help: 'Your own case or file number, if you use one.',
    }),
    email: field({ name: 'email', label: 'Email address', type: 'email', value: client?.email || '' }),
    phone: field({ name: 'phone', label: 'Phone', type: 'tel', value: client?.phone || '' }),
    counselor_id: field({
      name: 'counselor_id', label: 'Counselor', type: 'select',
      value: client?.counselor_id || (session.user?.role === 'vrc' ? session.user.id : ''),
      options: [{ value: '', label: 'Unassigned' },
        ...usersResponse.data.map((u) => ({ value: u.id, label: u.full_name }))],
    }),
    program_id: field({
      name: 'program_id', label: 'Program', type: 'select',
      value: client?.program_id || '',
      options: [{ value: '', label: 'None' },
        ...programsResponse.data.map((p) => ({ value: p.id, label: p.name }))],
    }),
    notes: field({ name: 'notes', label: 'Notes', type: 'textarea', value: client?.notes || '' }),
  };

  return modal({
    title: client ? `Edit ${client.full_name}` : 'Add a client',
    wide: true,
    body: el('div', {}, [
      el('div', { class: 'form-grid' }, [fields.first_name, fields.last_name]),
      el('div', { class: 'form-grid' }, [fields.external_ref, fields.email]),
      el('div', { class: 'form-grid' }, [fields.phone, fields.counselor_id]),
      fields.program_id,
      fields.notes,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: client ? 'Save changes' : 'Add client',
        class: 'btn-primary',
        onClick: async (close) => {
          for (const f of Object.values(fields)) f.setError(null);

          const body = {};
          for (const [key, f] of Object.entries(fields)) {
            const value = f.control.value.trim?.() ?? f.control.value;
            body[key] = value === '' ? null : value;
          }

          try {
            if (client) await api.updateClient(client.id, body);
            else await api.createClient(body);
            toastOk(client ? 'Client updated.' : 'Client added.');
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
// Programs
// ===========================================================================

export async function renderPrograms() {
  const container = el('div');
  const results = el('div');

  const load = async () => {
    clear(results).append(loadingBlock('Loading programs…'));
    try {
      const response = await api.programs({ include_inactive: true });

      clear(results).append(dataTable({
        caption: 'Programs and activities',
        columns: [
          {
            key: 'name', label: 'Program',
            render: (p) => el('span', {}, [
              p.name,
              p.description ? el('span', { class: 'cell-sub truncate', text: p.description }) : null,
            ]),
          },
          { key: 'code', label: 'Code', render: (p) => p.code ? el('span', { class: 'mono' }, p.code) : '—' },
          { key: 'devices', label: 'Devices', align: 'right', render: (p) => String(p.device_count) },
          { key: 'active_loans', label: 'On loan now', align: 'right', render: (p) => String(p.active_loan_count) },
          // loan_count, not total_loan_count: no endpoint has ever returned the
          // latter, so this column printed the word "undefined" in every row.
          // The clients list uses loan_count for the same figure.
          { key: 'total_loans', label: 'Loans ever', align: 'right', render: (p) => String(p.loan_count) },
          {
            key: 'status', label: 'Status',
            render: (p) => p.active
              ? el('span', { class: 'pill pill-ok' }, 'Active')
              : el('span', { class: 'pill pill-neutral' }, 'Inactive'),
          },
          {
            key: 'actions', label: 'Actions', align: 'right',
            render: (p) => can('programs.write')
              ? el('button', {
                  type: 'button', class: 'btn btn-sm',
                  onClick: () => openProgramDialog(p, load),
                }, ['Edit', el('span', { class: 'visually-hidden' }, ` ${p.name}`)])
              : el('span', { class: 'muted' }, '—'),
          },
        ],
        rows: response.data,
        emptyMessage: 'No programs yet.',
      }));

      announce(`${response.data.length} program${response.data.length === 1 ? '' : 's'}.`);
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load programs' }));
    }
  };

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Programs' }),
        el('p', { text: 'Activities and services a loan can be attributed to — LEAP, Retreat, and so on.' }),
      ]),
      can('programs.write')
        ? el('button', {
            type: 'button', class: 'btn btn-primary', onClick: () => openProgramDialog(null, load),
          }, 'Add program')
        : null,
    ]),
    results,
  );

  load();
  return container;
}

async function openProgramDialog(program, onDone) {
  const fields = {
    name: field({ name: 'name', label: 'Program name', required: true, value: program?.name || '' }),
    code: field({ name: 'code', label: 'Short code', value: program?.code || '', help: 'Optional. Must be unique.' }),
    description: field({ name: 'description', label: 'Description', type: 'textarea', value: program?.description || '' }),
    contact_email: field({ name: 'contact_email', label: 'Contact email', type: 'email', value: program?.contact_email || '' }),
    default_loan_days: field({
      name: 'default_loan_days', label: 'Typical loan length (days)', type: 'number', min: 0, max: 3650,
      value: program?.default_loan_days ?? '',
      help: 'Optional. Used as guidance when issuing equipment for this program.',
    }),
  };

  const activeBox = el('input', { type: 'checkbox', id: 'program-active', checked: program ? Boolean(program.active) : true });

  return modal({
    title: program ? `Edit ${program.name}` : 'Add a program',
    body: el('div', {}, [
      fields.name,
      el('div', { class: 'form-grid' }, [fields.code, fields.default_loan_days]),
      fields.contact_email,
      fields.description,
      program ? el('label', { class: 'checkbox', for: 'program-active' }, [
        activeBox,
        el('span', {}, [
          'Active',
          el('span', { class: 'option-help' }, 'Inactive programs stay on historic loans but are not offered for new ones.'),
        ]),
      ]) : null,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: program ? 'Save changes' : 'Add program',
        class: 'btn-primary',
        onClick: async (close) => {
          for (const f of Object.values(fields)) f.setError(null);

          const body = {};
          for (const [key, f] of Object.entries(fields)) {
            const value = f.control.value.trim?.() ?? f.control.value;
            body[key] = value === '' ? null : value;
          }
          if (program) body.active = activeBox.checked;

          try {
            if (program) await api.updateProgram(program.id, body);
            else await api.createProgram(body);
            toastOk(program ? 'Program updated.' : 'Program added.');
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
// Staff
// ===========================================================================

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Administrator — full control' },
  { value: 'tech', label: 'Technician — devices, loans, approvals' },
  { value: 'vrc', label: 'Counselor — requests loans for their clients' },
  { value: 'viewer', label: 'Read only — can see, cannot change' },
];

export async function renderStaff() {
  const container = el('div');
  const results = el('div');

  const load = async () => {
    clear(results).append(loadingBlock('Loading staff…'));
    try {
      const response = await api.users({ include_inactive: true });

      clear(results).append(dataTable({
        caption: 'Staff accounts',
        columns: [
          {
            key: 'name', label: 'Name',
            render: (u) => el('span', {}, [u.full_name, el('span', { class: 'cell-sub', text: u.email })]),
          },
          { key: 'role', label: 'Role', render: (u) => el('span', { class: 'pill pill-info' }, u.role_label) },
          { key: 'loans', label: 'Holding', align: 'right', render: (u) => String(u.active_loan_count ?? 0) },
          { key: 'last_login', label: 'Last signed in', render: (u) => dateCell(u.last_login_at, { withTime: true }) },
          {
            key: 'status', label: 'Status',
            render: (u) => u.active
              ? el('span', { class: 'pill pill-ok' }, 'Active')
              : el('span', { class: 'pill pill-neutral' }, 'Deactivated'),
          },
          {
            key: 'actions', label: 'Actions', align: 'right',
            render: (u) => can('users.write')
              ? el('div', { class: 'table-actions' }, [
                  el('button', {
                    type: 'button', class: 'btn btn-sm',
                    onClick: () => openUserDialog(u, load),
                  }, ['Edit', el('span', { class: 'visually-hidden' }, ` ${u.full_name}`)]),
                  el('button', {
                    type: 'button', class: 'btn btn-sm',
                    onClick: () => openResetPasswordDialog(u),
                  }, ['Reset password', el('span', { class: 'visually-hidden' }, ` for ${u.full_name}`)]),
                ])
              : el('span', { class: 'muted' }, '—'),
          },
        ],
        rows: response.data,
        emptyMessage: 'No staff accounts.',
      }));
    } catch (err) {
      clear(results).append(alertBox(err.message, { type: 'danger', title: 'Could not load staff' }));
    }
  };

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Staff' }),
        el('p', { text: 'Technicians, counselors and administrators who can sign in.' }),
      ]),
      can('users.write')
        ? el('button', {
            type: 'button', class: 'btn btn-primary', onClick: () => openUserDialog(null, load),
          }, 'Add staff account')
        : null,
    ]),
    results,
  );

  load();
  return container;
}

async function openUserDialog(user, onDone) {
  const fields = {
    full_name: field({ name: 'full_name', label: 'Full name', required: true, value: user?.full_name || '', autocomplete: 'off' }),
    email: field({
      name: 'email', label: 'Email address', type: 'email', required: true, value: user?.email || '',
      help: 'This is the username they sign in with.', autocomplete: 'off',
    }),
    role: field({ name: 'role', label: 'Role', type: 'select', value: user?.role || 'tech', options: ROLE_OPTIONS }),
    phone: field({ name: 'phone', label: 'Phone', type: 'tel', value: user?.phone || '' }),
    employee_ref: field({ name: 'employee_ref', label: 'Staff reference', value: user?.employee_ref || '' }),
  };

  const passwordField = user ? null : field({
    name: 'password', label: 'Initial password', type: 'password', required: true,
    help: 'At least 12 characters. They will be asked to change it when they first sign in.',
    autocomplete: 'new-password',
  });

  const activeBox = el('input', { type: 'checkbox', id: 'user-active', checked: user ? Boolean(user.active) : true });

  return modal({
    title: user ? `Edit ${user.full_name}` : 'Add a staff account',
    body: el('div', {}, [
      fields.full_name,
      fields.email,
      fields.role,
      el('div', { class: 'form-grid' }, [fields.phone, fields.employee_ref]),
      passwordField,
      user ? el('label', { class: 'checkbox', for: 'user-active' }, [
        activeBox,
        el('span', {}, [
          'Active',
          el('span', { class: 'option-help' }, 'Deactivating signs them out immediately and blocks sign-in.'),
        ]),
      ]) : null,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: user ? 'Save changes' : 'Create account',
        class: 'btn-primary',
        onClick: async (close) => {
          for (const f of Object.values(fields)) f.setError(null);
          passwordField?.setError(null);

          const body = {};
          for (const [key, f] of Object.entries(fields)) {
            const value = f.control.value.trim?.() ?? f.control.value;
            body[key] = value === '' ? null : value;
          }
          if (passwordField) body.password = passwordField.control.value;
          if (user) body.active = activeBox.checked;

          try {
            if (user) await api.updateUser(user.id, body);
            else await api.createUser(body);
            toastOk(user ? 'Account updated.' : 'Account created.');
            close(true);
            onDone?.();
          } catch (err) {
            const target = err.field === 'password' ? passwordField : fields[err.field];
            if (target) {
              target.setError(err.message);
              target.control.focus();
            } else { toastError(err.message); }
          }
        },
      },
    ],
  });
}

async function openResetPasswordDialog(user) {
  const passwordField = field({
    name: 'password', label: 'New password', type: 'password', required: true,
    help: 'At least 12 characters. They will be asked to change it at their next sign-in.',
    autocomplete: 'new-password',
  });

  return modal({
    title: `Reset password for ${user.full_name}`,
    body: el('div', {}, [
      el('p', {
        text:
          'This signs them out of every device immediately. Tell them the new password through a ' +
          'channel you trust — not in the same message as their username.',
      }),
      passwordField,
    ]),
    actions: [
      { label: 'Cancel', class: 'btn-ghost', value: null },
      {
        label: 'Reset password',
        class: 'btn-danger',
        onClick: async (close) => {
          passwordField.setError(null);
          try {
            await api.resetUserPassword(user.id, { password: passwordField.control.value });
            toastOk(`Password reset. ${user.full_name} has been signed out everywhere.`);
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
