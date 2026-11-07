/**
 * Outbound email via Microsoft Graph.
 *
 * Uses the client-credentials flow: an Azure app registration with the
 * application permission Mail.Send, admin-consented, sending as a specific
 * mailbox. There is no user sign-in, so notifications keep working overnight
 * and unattended.
 *
 * Configuration is entered by an administrator in the app's settings screen
 * (tenant id, client id, client secret, sender mailbox); nothing here reads
 * environment variables, so a fresh install needs no shell access.
 *
 * Every send is journalled to email_log — including failures and skips — so
 * "did the client get told?" has an answer that does not depend on the
 * recipient's word.
 */

import { execute, query, queryOne } from '../db.js';
import { getSettings, parseRecipients } from './settings.js';
import { escapeHtml, HttpError } from './util.js';
import { recordAudit, AUDIT_ACTIONS } from './audit.js';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const TOKEN_HOST = 'https://login.microsoftonline.com';
const GRAPH_HOST = 'https://graph.microsoft.com/v1.0';

/**
 * Access tokens live ~60 minutes. Cached per organisation and refreshed 5
 * minutes early, so a burst of overdue notices does not mean a token request
 * per email.
 */
const tokenCache = new Map();

function cacheKey(organizationId, clientId) {
  return `${organizationId}:${clientId}`;
}

async function getAccessToken(organizationId, config) {
  const key = cacheKey(organizationId, config.clientId);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 300000) return cached.token;

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: GRAPH_SCOPE,
    grant_type: 'client_credentials',
  });

  let response;
  try {
    response = await fetch(`${TOKEN_HOST}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new HttpError(502, 'graph_unreachable',
      `Could not reach Microsoft's sign-in service: ${err.message}. ` +
      'Check that this server has outbound HTTPS access.');
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Azure's error descriptions are genuinely useful; pass them through
    // rather than replacing them with a generic message.
    throw new HttpError(400, 'graph_auth_failed',
      describeAzureError(payload, response.status),
      { azure_error: payload.error, azure_description: payload.error_description });
  }

  const token = payload.access_token;
  if (!token) {
    throw new HttpError(502, 'graph_auth_failed', 'Microsoft returned no access token.', payload);
  }

  tokenCache.set(key, {
    token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
  });

  return token;
}

function describeAzureError(payload, status) {
  const code = payload?.error || '';
  const description = payload?.error_description || '';

  if (description.includes('AADSTS7000215')) {
    return 'The client secret is wrong or has expired. Generate a new secret in Azure and paste it in again.';
  }
  if (description.includes('AADSTS700016') || code === 'unauthorized_client') {
    return 'That application (client) ID was not found in this tenant. Check both the tenant ID and the client ID.';
  }
  if (description.includes('AADSTS90002')) {
    return 'That tenant ID does not exist. Use the Directory (tenant) ID from the app registration Overview page.';
  }
  if (code === 'invalid_scope' || description.includes('AADSTS70011')) {
    return 'The app registration is missing the Mail.Send application permission, or admin consent has not been granted.';
  }
  return description || `Microsoft rejected the sign-in request (HTTP ${status}).`;
}

/** Read Graph configuration, returning why it is unusable rather than just false. */
export async function getMailConfig(organizationId) {
  const settings = await getSettings(organizationId);

  const config = {
    enabled: Boolean(settings['graph.enabled']),
    tenantId: settings['graph.tenant_id'],
    clientId: settings['graph.client_id'],
    clientSecret: settings['graph.client_secret'],
    sender: settings['graph.sender'],
    replyTo: settings['graph.reply_to'],
  };

  const missing = [];
  if (!config.tenantId) missing.push('Directory (tenant) ID');
  if (!config.clientId) missing.push('Application (client) ID');
  if (!config.clientSecret) missing.push('Client secret');
  if (!config.sender) missing.push('Sender mailbox');

  return {
    ...config,
    missing,
    usable: config.enabled && missing.length === 0,
    reason: !config.enabled
      ? 'Email notifications are switched off in settings.'
      : missing.length
        ? `Graph is not fully configured. Missing: ${missing.join(', ')}.`
        : null,
  };
}

/**
 * Send one message.
 *
 * Returns { sent: boolean, reason } rather than throwing when email is simply
 * not configured — a loan check-out must not fail because nobody has set up
 * Graph yet. Genuine send failures are recorded and returned, also without
 * throwing, for the same reason.
 */
export async function sendMail(ctx, organizationId, message) {
  const {
    to, subject, html, text = null, eventType = 'manual',
    loanId = null, requestId = null, cc = [],
  } = message;

  const recipients = (Array.isArray(to) ? to : parseRecipients(to)).filter(Boolean);

  if (!recipients.length) {
    await logEmail(organizationId, {
      eventType, recipient: '(none)', subject, status: 'skipped',
      error: 'No recipient address available.', loanId, requestId,
    });
    return { sent: false, reason: 'No recipient address available.' };
  }

  const config = await getMailConfig(organizationId);
  if (!config.usable) {
    await logEmail(organizationId, {
      eventType, recipient: recipients.join(', '), subject, status: 'skipped',
      error: config.reason, loanId, requestId,
    });
    return { sent: false, reason: config.reason };
  }

  const payload = {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
      ...(cc.length ? { ccRecipients: cc.map((address) => ({ emailAddress: { address } })) } : {}),
      ...(config.replyTo
        ? { replyTo: [{ emailAddress: { address: config.replyTo } }] }
        : {}),
    },
    saveToSentItems: true,
  };

  try {
    const token = await getAccessToken(organizationId, config);

    const response = await fetch(
      `${GRAPH_HOST}/users/${encodeURIComponent(config.sender)}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      },
    );

    if (response.status === 202) {
      await logEmail(organizationId, {
        eventType, recipient: recipients.join(', '), subject, status: 'sent',
        bodyPreview: text || stripHtml(html), loanId, requestId,
      });
      await recordAudit(ctx, {
        organizationId,
        action: AUDIT_ACTIONS.EMAIL_SENT,
        entityType: 'email',
        entityLabel: eventType,
        summary: `Sent "${subject}" to ${recipients.join(', ')}`,
        detail: { event_type: eventType, recipients, loan_id: loanId, request_id: requestId },
      });
      return { sent: true };
    }

    const errorBody = await response.json().catch(() => ({}));
    const reason = describeGraphSendError(errorBody, response.status, config.sender);

    await logEmail(organizationId, {
      eventType, recipient: recipients.join(', '), subject, status: 'failed',
      error: reason, loanId, requestId,
    });
    await recordAudit(ctx, {
      organizationId,
      action: AUDIT_ACTIONS.EMAIL_FAILED,
      entityType: 'email',
      entityLabel: eventType,
      summary: `Failed to send "${subject}": ${reason}`,
      detail: { event_type: eventType, recipients, status: response.status, error: errorBody },
    });

    return { sent: false, reason };
  } catch (err) {
    const reason = err instanceof HttpError ? err.message : `Unexpected error sending mail: ${err.message}`;
    await logEmail(organizationId, {
      eventType, recipient: recipients.join(', '), subject, status: 'failed',
      error: reason, loanId, requestId,
    });
    return { sent: false, reason };
  }
}

function describeGraphSendError(body, status, sender) {
  const code = body?.error?.code || '';
  const message = body?.error?.message || '';

  if (status === 404 || code === 'ResourceNotFound') {
    return `The sender mailbox "${sender}" was not found in this tenant. It must be a real, licensed mailbox.`;
  }
  if (status === 403 || code === 'ErrorAccessDenied') {
    return 'Access denied. The app registration needs the Mail.Send *application* permission with admin consent granted ' +
      '(delegated permissions do not work for unattended sending).';
  }
  if (status === 429) {
    return 'Microsoft is rate limiting this mailbox. The message was not sent; try again shortly.';
  }
  return message || `Microsoft Graph rejected the message (HTTP ${status}).`;
}

async function logEmail(organizationId, entry) {
  try {
    await execute(
      `INSERT INTO email_log
         (organization_id, event_type, recipient, subject, body_preview, loan_id, request_id,
          status, error_message, attempts, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        organizationId, entry.eventType, String(entry.recipient).slice(0, 500),
        String(entry.subject).slice(0, 255),
        entry.bodyPreview ? String(entry.bodyPreview).slice(0, 2000) : null,
        entry.loanId, entry.requestId, entry.status, entry.error ?? null,
        entry.status === 'sent' ? new Date() : null,
      ],
    );
  } catch (err) {
    console.error('[mailer] could not write email_log entry:', err.message);
  }
}

function stripHtml(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Send a test message so an admin can verify configuration before relying on it. */
export async function sendTestEmail(ctx, organizationId, recipient) {
  const config = await getMailConfig(organizationId);
  if (config.missing.length) {
    throw new HttpError(400, 'graph_not_configured', config.reason, { missing: config.missing });
  }

  // Deliberately bypasses the `enabled` flag: an admin needs to be able to
  // test the connection before switching notifications on.
  const token = await getAccessToken(organizationId, config);

  const response = await fetch(
    `${GRAPH_HOST}/users/${encodeURIComponent(config.sender)}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: 'Loaner Pool — test message',
          body: {
            contentType: 'HTML',
            content: layout(
              'Test message',
              `<p>This is a test from your Loaner Pool installation.</p>
               <p>If you are reading this, Microsoft Graph is configured correctly and
                  notifications will be delivered from <strong>${escapeHtml(config.sender)}</strong>.</p>`,
            ),
          },
          toRecipients: [{ emailAddress: { address: recipient } }],
        },
        saveToSentItems: true,
      }),
      signal: AbortSignal.timeout(30000),
    },
  );

  if (response.status !== 202) {
    const body = await response.json().catch(() => ({}));
    throw new HttpError(400, 'graph_send_failed',
      describeGraphSendError(body, response.status, config.sender), body);
  }

  await logEmail(organizationId, {
    eventType: 'test', recipient, subject: 'Loaner Pool — test message', status: 'sent',
  });

  return { sent: true, sender: config.sender, recipient };
}

// ---------------------------------------------------------------------------
// Templates
//
// Inline styles only, and a table-free layout — Outlook strips <style> blocks
// and most webmail clients ignore external CSS entirely.
// ---------------------------------------------------------------------------

function layout(heading, bodyHtml, footer = '') {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:600px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border-radius:8px;padding:24px;border:1px solid #e1e3e6;">
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#0f4c81;">${escapeHtml(heading)}</h1>
      ${bodyHtml}
    </div>
    <p style="font-size:12px;color:#6b7280;margin:16px 0 0;text-align:center;">
      Sent automatically by Loaner Pool.${footer ? ` ${escapeHtml(footer)}` : ''}
    </p>
  </div>
</body></html>`;
}

function detailList(pairs) {
  const rows = pairs
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) =>
      `<tr>
         <td style="padding:6px 12px 6px 0;color:#6b7280;font-size:14px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
         <td style="padding:6px 0;font-size:14px;font-weight:600;">${escapeHtml(String(value))}</td>
       </tr>`)
    .join('');
  return `<table style="border-collapse:collapse;margin:16px 0;width:100%;">${rows}</table>`;
}

function formatDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export const templates = {
  requestSubmitted(request, { baseUrl = '' } = {}) {
    return {
      subject: `Loan request ${request.reference} submitted`,
      html: layout('A new loan request needs review', `
        <p>${escapeHtml(request.requester_name)} has submitted a loan request.</p>
        ${detailList([
          ['Reference', request.reference],
          ['Client', request.client_name],
          ['Program', request.program_name],
          ['Device', request.device_name || request.requested_category || request.requested_details],
          ['Needed by', formatDate(request.needed_by)],
          ['Delivery', deliveryLabel(request.delivery_mode)],
        ])}
        ${request.justification ? `<p style="background:#f9fafb;border-left:3px solid #0f4c81;padding:12px;font-size:14px;">${escapeHtml(request.justification)}</p>` : ''}
        ${linkButton(baseUrl, `/#/requests/${request.id}`, 'Review this request')}
      `),
    };
  },

  requestApproved(request, { baseUrl = '' } = {}) {
    return {
      subject: `Loan request ${request.reference} approved`,
      html: layout('Your loan request was approved', `
        <p>Request <strong>${escapeHtml(request.reference)}</strong> has been approved.</p>
        ${detailList([
          ['Client', request.client_name],
          ['Device', request.device_name],
          ['Status', request.tracking_summary],
          ['Reviewed by', request.reviewer_name],
        ])}
        ${request.review_notes ? `<p style="font-size:14px;">${escapeHtml(request.review_notes)}</p>` : ''}
        <p style="font-size:14px;color:#6b7280;">You will be notified again when the device is ready.</p>
        ${linkButton(baseUrl, `/#/requests/${request.id}`, 'Track this request')}
      `),
    };
  },

  requestDenied(request, { baseUrl = '' } = {}) {
    return {
      subject: `Loan request ${request.reference} was declined`,
      html: layout('Your loan request was declined', `
        <p>Request <strong>${escapeHtml(request.reference)}</strong> has been declined.</p>
        ${request.review_notes
          ? `<p style="background:#fef2f2;border-left:3px solid #b91c1c;padding:12px;font-size:14px;">${escapeHtml(request.review_notes)}</p>`
          : ''}
        ${detailList([['Client', request.client_name], ['Reviewed by', request.reviewer_name]])}
        <p style="font-size:14px;">If you think this was a mistake, reply to this message or speak to the loaner pool team.</p>
      `),
    };
  },

  readyForPickup(request, { baseUrl = '' } = {}) {
    return {
      subject: `Ready for pickup — ${request.reference}`,
      html: layout('Your device is ready for pickup', `
        <p>The device for request <strong>${escapeHtml(request.reference)}</strong> is staged and ready to collect.</p>
        ${detailList([
          ['Device', request.device_name],
          ['Barcode', request.device_barcode],
          ['Client', request.client_name],
        ])}
        ${linkButton(baseUrl, `/#/requests/${request.id}`, 'View request')}
      `),
    };
  },

  checkedOut(loan, { baseUrl = '' } = {}) {
    return {
      subject: `Device issued — ${loan.device_name} (${loan.reference})`,
      html: layout('A device has been issued', `
        <p><strong>${escapeHtml(loan.device_name)}</strong> has been checked out.</p>
        ${detailList([
          ['Loan reference', loan.reference],
          ['Barcode', loan.device_barcode],
          ['Issued to', loan.holder_summary],
          ['Due back', loan.due_at ? formatDate(loan.due_at) : 'No return date (open-ended loan)'],
        ])}
        ${loan.due_at ? '<p style="font-size:14px;">Please return the device by the date above. You will get a reminder before it is due.</p>' : ''}
      `),
    };
  },

  dueSoon(loan, { baseUrl = '' } = {}) {
    return {
      subject: `Due in ${loan.days_until_due} day${loan.days_until_due === 1 ? '' : 's'} — ${loan.device_name}`,
      html: layout('A loaned device is due back soon', `
        <p><strong>${escapeHtml(loan.device_name)}</strong> is due back
           ${escapeHtml(formatDate(loan.due_at) || 'soon')}.</p>
        ${detailList([
          ['Loan reference', loan.reference],
          ['Barcode', loan.device_barcode],
          ['Held by', loan.holder_summary],
        ])}
        <p style="font-size:14px;">If more time is needed, the loan can be extended — contact the loaner pool team before the due date.</p>
      `),
    };
  },

  overdue(loan, { baseUrl = '' } = {}) {
    return {
      subject: `Overdue by ${loan.days_overdue} day${loan.days_overdue === 1 ? '' : 's'} — ${loan.device_name}`,
      html: layout('A loaned device is overdue', `
        <p style="background:#fef2f2;border-left:3px solid #b91c1c;padding:12px;font-size:14px;">
          <strong>${escapeHtml(loan.device_name)}</strong> was due back
          ${escapeHtml(formatDate(loan.due_at) || '')} and has not been returned.
        </p>
        ${detailList([
          ['Loan reference', loan.reference],
          ['Barcode', loan.device_barcode],
          ['Held by', loan.holder_summary],
          ['Days overdue', loan.days_overdue],
        ])}
        <p style="font-size:14px;">Please return it, or contact the loaner pool team to extend the loan.</p>
      `),
    };
  },

  checkedIn(loan, { baseUrl = '' } = {}) {
    return {
      subject: `Returned — ${loan.device_name} (${loan.reference})`,
      html: layout('A device has been returned', `
        <p><strong>${escapeHtml(loan.device_name)}</strong> has been checked back in. Thank you.</p>
        ${detailList([
          ['Loan reference', loan.reference],
          ['Returned', formatDate(loan.returned_at)],
          ['Condition noted', loan.condition_in],
        ])}
      `),
    };
  },
};

function deliveryLabel(mode) {
  return {
    vrc_pickup: 'Counselor will collect',
    deliver_to_client: 'Deliver to client',
    client_pickup: 'Client will collect',
  }[mode] || mode;
}

function linkButton(baseUrl, path, label) {
  if (!baseUrl) return '';
  const href = `${String(baseUrl).replace(/\/$/, '')}${path}`;
  return `<p style="margin:24px 0 0;">
    <a href="${escapeHtml(href)}"
       style="display:inline-block;background:#0f4c81;color:#ffffff;text-decoration:none;
              padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;">${escapeHtml(label)}</a>
  </p>`;
}

/**
 * Fire a notification for an event, honouring the per-event toggles.
 * Never throws — notification failure must not roll back the operation that
 * triggered it.
 */
export async function notify(ctx, organizationId, eventType, payload, { baseUrl = '' } = {}) {
  try {
    const settings = await getSettings(organizationId);
    const toggleKey = `notify.${eventType}`;
    if (toggleKey in settings && !settings[toggleKey]) {
      return { sent: false, reason: `The "${eventType}" notification is switched off.` };
    }

    const builder = {
      request_submitted: () => templates.requestSubmitted(payload, { baseUrl }),
      request_approved: () => templates.requestApproved(payload, { baseUrl }),
      request_denied: () => templates.requestDenied(payload, { baseUrl }),
      ready_for_pickup: () => templates.readyForPickup(payload, { baseUrl }),
      checked_out: () => templates.checkedOut(payload, { baseUrl }),
      due_soon: () => templates.dueSoon(payload, { baseUrl }),
      overdue: () => templates.overdue(payload, { baseUrl }),
      checked_in: () => templates.checkedIn(payload, { baseUrl }),
    }[eventType];

    if (!builder) return { sent: false, reason: `Unknown notification type "${eventType}".` };

    const { subject, html } = builder();
    const recipients = resolveRecipients(eventType, payload, settings);

    return await sendMail(ctx, organizationId, {
      to: recipients,
      subject,
      html,
      eventType,
      loanId: payload.id && payload.device_barcode ? payload.id : null,
      requestId: payload.reference?.startsWith('RQ') ? payload.id : null,
    });
  } catch (err) {
    console.error(`[mailer] notify(${eventType}) failed:`, err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Who hears about what.
 *
 * Client addresses are included only for events the client is party to —
 * a client has no business receiving the internal "new request needs review"
 * message, which names other staff.
 */
function resolveRecipients(eventType, payload, settings) {
  const admins = parseRecipients(settings['notify.admin_recipients']);
  const out = new Set();

  const add = (value) => {
    for (const address of parseRecipients(value)) out.add(address);
  };

  switch (eventType) {
    case 'request_submitted':
      admins.forEach((a) => out.add(a));
      add(payload.assigned_tech_email);
      break;
    case 'request_approved':
    case 'request_denied':
    case 'ready_for_pickup':
      add(payload.requester_email);
      break;
    case 'checked_out':
    case 'due_soon':
    case 'overdue':
      add(payload.client_email);
      add(payload.tech_email);
      break;
    case 'checked_in':
      add(payload.tech_email);
      break;
    default:
      admins.forEach((a) => out.add(a));
  }

  return [...out];
}

/** Recent email activity, for the admin settings screen. */
export async function recentEmails(organizationId, limit = 25) {
  return query(
    `SELECT id, event_type, recipient, subject, status, error_message, sent_at, created_at
       FROM email_log WHERE organization_id = ?
      ORDER BY created_at DESC LIMIT ${Number(limit)}`,
    [organizationId],
  );
}
