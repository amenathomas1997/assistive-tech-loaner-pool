/**
 * Loan agreements.
 *
 * Most VR agencies need something signed before equipment leaves the building.
 * This captures that at check-out and keeps it against the loan.
 *
 * Two decisions worth knowing about:
 *
 * 1. **The agreement text is snapshotted onto the loan**, not referenced. The
 *    wording an organisation uses today is not what someone signed two years
 *    ago, and it is the signed wording that matters if it is ever questioned.
 *
 * 2. **Three ways to sign, plus waive.** Drawing a signature is a dragging
 *    interaction, and WCAG 2.2 SC 2.5.7 only exempts dragging where it is
 *    essential. Rather than lean on that exemption, typing your name as an
 *    attestation and uploading an image of a wet signature are equally valid
 *    here — so someone who cannot use a pointer is not shut out of a step that
 *    gates receiving their equipment.
 */

import { transaction, connOne, query, queryOne, execute } from '../db.js';
import { notFound, conflict, badRequest, escapeHtml, toMysqlDateTime } from './util.js';
import { recordAudit } from './audit.js';
import { getSettings, getOrganization } from './settings.js';
import { storeAttachment } from './attachments.js';

export const SIGNATURE_METHODS = ['drawn', 'typed', 'uploaded', 'waived'];
export const SIGNER_ROLES = ['client', 'counselor', 'technician', 'guardian', 'other'];

/**
 * Default agreement wording. Deliberately plain: an organisation is expected
 * to replace it with something their own legal or programme staff approved,
 * and placeholder legalese invites people to ship it unchanged.
 */
export const DEFAULT_AGREEMENT_TEXT = `Loan agreement

I confirm that I have received the equipment listed on this agreement from {{organisation}}.

I agree to:
  - take reasonable care of the equipment;
  - use it only for the purpose it was lent to me for;
  - not lend, sell, modify or dispose of it;
  - report any loss, theft or damage to {{organisation}} as soon as I can;
  - return it, with all accessories listed, by {{due_date}}.

I understand that the equipment remains the property of {{organisation}} throughout the loan,
and that {{organisation}} may ask for it back before the return date if it is needed elsewhere.

If you need this agreement in another format, or need help understanding any part of it,
please ask before signing.`;

/** Fill the placeholders for a specific loan. */
export function renderAgreementText(template, { organisation, loan, accessories = [] }) {
  const accessoryLine = accessories.length
    ? accessories.map((a) => a.name).join(', ')
    : 'none';

  return String(template)
    .replaceAll('{{organisation}}', organisation || 'the loaner pool')
    .replaceAll('{{organization}}', organisation || 'the loaner pool')
    .replaceAll('{{due_date}}', loan?.due_at
      ? new Date(loan.due_at).toLocaleDateString(undefined, { dateStyle: 'long' })
      : 'the agreed return date')
    .replaceAll('{{device}}', loan?.device_name || 'the equipment listed')
    .replaceAll('{{barcode}}', loan?.device_barcode || '')
    .replaceAll('{{accessories}}', accessoryLine)
    .replaceAll('{{client}}', loan?.client_name || 'the borrower')
    .replaceAll('{{reference}}', loan?.reference || '');
}

/** The wording and requirement settings, for the check-out form. */
export async function getAgreementSettings(organizationId) {
  const settings = await getSettings(organizationId);
  const org = await getOrganization(organizationId);

  return {
    enabled: Boolean(settings['agreements.enabled']),
    required: Boolean(settings['agreements.required']),
    allowWaive: Boolean(settings['agreements.allow_waive']),
    text: settings['agreements.text'] || DEFAULT_AGREEMENT_TEXT,
    organisation: org?.name || '',
  };
}

/**
 * Record a signed agreement against a loan.
 *
 * A drawn or uploaded signature arrives as a base64 image and is stored as an
 * attachment; a typed one is stored as text. `waived` records that a human
 * decided to proceed without one, with a reason — silently allowing an unsigned
 * loan when the policy requires a signature would make the policy meaningless.
 */
export async function signAgreement(ctx, input) {
  const {
    organizationId, loanId, signedByName, signedByRole = 'client',
    signatureMethod = 'typed', signatureImage = null, typedSignature = null,
    waivedReason = null, witnessedBy = null, agreementText = null, ip = null,
    actorId = null,
  } = input;

  if (!SIGNATURE_METHODS.includes(signatureMethod)) {
    throw badRequest(`Signature method must be one of: ${SIGNATURE_METHODS.join(', ')}.`);
  }
  if (!SIGNER_ROLES.includes(signedByRole)) {
    throw badRequest(`Signer role must be one of: ${SIGNER_ROLES.join(', ')}.`);
  }

  const loan = await queryOne(
    `SELECT l.*, d.name AS device_name, d.barcode AS device_barcode,
            c.first_name, c.last_name
       FROM loans l
       JOIN devices d ON d.id = l.device_id
       LEFT JOIN clients c ON c.id = l.client_id
      WHERE l.id = ? AND l.organization_id = ?`,
    [loanId, organizationId],
  );
  if (!loan) throw notFound('That loan does not exist.');

  const existing = await queryOne('SELECT id FROM loan_agreements WHERE loan_id = ?', [loanId]);
  if (existing) {
    throw conflict(
      'This loan already has a signed agreement. A signature cannot be replaced — ' +
      'if it is wrong, cancel the loan and issue it again.',
      { agreement_id: existing.id },
    );
  }

  if (signatureMethod === 'waived') {
    const settings = await getAgreementSettings(organizationId);
    if (!settings.allowWaive) {
      throw badRequest(
        'Waiving the loan agreement is not permitted for this organisation. ' +
        'An administrator can allow it under Settings.',
      );
    }
    if (!waivedReason || !String(waivedReason).trim()) {
      throw badRequest('Give a reason for proceeding without a signature.', { field: 'waived_reason' });
    }
  } else if (signatureMethod === 'typed') {
    if (!typedSignature || !String(typedSignature).trim()) {
      throw badRequest('Type your full name to sign.', { field: 'typed_signature' });
    }
  } else if (!signatureImage) {
    throw badRequest('No signature image was received.', { field: 'signature_image' });
  }

  if (!signedByName || !String(signedByName).trim()) {
    throw badRequest('Enter the name of the person signing.', { field: 'signed_by_name' });
  }

  // Snapshot the wording actually agreed to.
  const settings = await getAgreementSettings(organizationId);
  const accessories = await query(
    'SELECT name, required FROM device_accessories WHERE device_id = ? ORDER BY sort_order',
    [loan.device_id],
  );

  const finalText = agreementText || renderAgreementText(settings.text, {
    organisation: settings.organisation,
    loan: {
      ...loan,
      client_name: loan.first_name ? `${loan.first_name} ${loan.last_name}` : null,
    },
    accessories,
  });

  let signatureAttachmentId = null;
  if (signatureImage && signatureMethod !== 'waived' && signatureMethod !== 'typed') {
    const attachment = await storeAttachment(ctx, {
      organizationId,
      kind: 'signature',
      loanId,
      deviceId: loan.device_id,
      phase: 'agreement',
      dataUrl: signatureImage,
      caption: `Signature of ${signedByName}`,
      uploadedBy: actorId,
    });
    signatureAttachmentId = attachment.id;
  }

  const result = await execute(
    `INSERT INTO loan_agreements
       (organization_id, loan_id, agreement_text, signed_by_name, signed_by_role,
        signature_method, signature_attachment_id, typed_signature, waived_reason,
        witnessed_by, signed_at, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId, loanId, finalText, String(signedByName).trim().slice(0, 190),
      signedByRole, signatureMethod, signatureAttachmentId,
      typedSignature ? String(typedSignature).trim().slice(0, 190) : null,
      waivedReason ? String(waivedReason).trim().slice(0, 255) : null,
      witnessedBy, toMysqlDateTime(new Date()), ip,
    ],
  );

  await recordAudit(ctx, {
    organizationId,
    action: signatureMethod === 'waived' ? 'agreement.waived' : 'agreement.signed',
    entityType: 'loan',
    entityId: loanId,
    entityLabel: loan.reference,
    summary: signatureMethod === 'waived'
      ? `Loan agreement waived for ${loan.reference}: ${waivedReason}`
      : `Loan agreement signed for ${loan.reference} by ${signedByName} (${signatureMethod})`,
    detail: { method: signatureMethod, role: signedByRole, witnessed_by: witnessedBy },
  });

  return getAgreement(organizationId, loanId);
}

export async function getAgreement(organizationId, loanId) {
  const row = await queryOne(
    `SELECT a.*, w.full_name AS witness_name
       FROM loan_agreements a
       LEFT JOIN users w ON w.id = a.witnessed_by
      WHERE a.loan_id = ? AND a.organization_id = ?`,
    [loanId, organizationId],
  );
  if (!row) return null;

  return {
    ...row,
    signature_url: row.signature_attachment_id
      ? `/api/v1/attachments/${row.signature_attachment_id}`
      : null,
    was_waived: row.signature_method === 'waived',
  };
}

/**
 * A printable copy of the agreement.
 *
 * Rendered as HTML rather than PDF: it prints identically, needs no PDF
 * dependency on a shared host, and can be read by a screen reader — which a
 * generated PDF frequently cannot.
 */
export async function renderAgreementHtml(organizationId, loanId) {
  const agreement = await getAgreement(organizationId, loanId);
  if (!agreement) throw notFound('No agreement has been signed for that loan.');

  const loan = await queryOne(
    `SELECT l.*, d.name AS device_name, d.barcode AS device_barcode, d.serial_number,
            c.first_name, c.last_name, p.name AS program_name, t.full_name AS tech_name
       FROM loans l
       JOIN devices d ON d.id = l.device_id
       LEFT JOIN clients c ON c.id = l.client_id
       LEFT JOIN programs p ON p.id = l.program_id
       LEFT JOIN users t ON t.id = l.tech_id
      WHERE l.id = ?`,
    [loanId],
  );

  const org = await getOrganization(organizationId);
  const accessories = await query(
    'SELECT name, required FROM device_accessories WHERE device_id = ? ORDER BY sort_order',
    [loan.device_id],
  );

  const signatureBlock = agreement.was_waived
    ? `<p class="waived"><strong>Signature waived.</strong> ${escapeHtml(agreement.waived_reason || '')}</p>`
    : agreement.signature_url
      ? `<img class="signature" src="${escapeHtml(agreement.signature_url)}" alt="Signature of ${escapeHtml(agreement.signed_by_name)}">`
      : `<p class="typed-signature">${escapeHtml(agreement.typed_signature || '')}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Loan agreement ${escapeHtml(loan.reference)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: Georgia, "Times New Roman", serif; font-size: 11pt; line-height: 1.55; color: #000; margin: 0; }
  .toolbar { background: #f0f0f0; padding: 12px; border-bottom: 1px solid #ccc; font-family: system-ui, sans-serif; }
  .toolbar button { font: inherit; padding: 8px 16px; cursor: pointer; }
  .sheet { max-width: 190mm; margin: 0 auto; padding: 12mm 0; }
  h1 { font-size: 17pt; margin: 0 0 4px; }
  .org { font-size: 12pt; color: #333; margin-bottom: 18px; }
  table.details { border-collapse: collapse; width: 100%; margin: 16px 0 22px; font-size: 10.5pt; }
  table.details th { text-align: left; width: 34%; padding: 5px 10px 5px 0; vertical-align: top; font-weight: normal; color: #444; }
  table.details td { padding: 5px 0; font-weight: bold; }
  .agreement { white-space: pre-wrap; border-top: 1px solid #999; border-bottom: 1px solid #999; padding: 16px 0; margin: 18px 0; }
  .sign-off { margin-top: 26px; }
  .signature { max-width: 260px; max-height: 90px; display: block; border-bottom: 1px solid #000; padding-bottom: 4px; }
  .typed-signature { font-family: "Segoe Script", "Brush Script MT", cursive; font-size: 20pt; border-bottom: 1px solid #000; display: inline-block; padding: 0 24px 2px 4px; margin: 0; }
  .waived { border: 1px solid #999; padding: 10px; background: #f7f7f7; }
  .meta { font-size: 9pt; color: #555; margin-top: 8px; }
  ul.accessories { margin: 4px 0 0; padding-left: 20px; }
  @media print { .toolbar { display: none; } .sheet { padding: 0; } }
</style>
</head>
<body>
  <div class="toolbar"><button type="button" onclick="window.print()">Print this agreement</button></div>
  <div class="sheet">
    <h1>Equipment loan agreement</h1>
    <p class="org">${escapeHtml(org?.name || '')}</p>

    <table class="details">
      <tr><th scope="row">Agreement reference</th><td>${escapeHtml(loan.reference)}</td></tr>
      <tr><th scope="row">Equipment</th><td>${escapeHtml(loan.device_name)}</td></tr>
      <tr><th scope="row">Barcode</th><td>${escapeHtml(loan.device_barcode)}</td></tr>
      ${loan.serial_number ? `<tr><th scope="row">Serial number</th><td>${escapeHtml(loan.serial_number)}</td></tr>` : ''}
      <tr><th scope="row">Accessories included</th><td>${
        accessories.length
          ? `<ul class="accessories">${accessories.map((a) => `<li>${escapeHtml(a.name)}</li>`).join('')}</ul>`
          : 'None'
      }</td></tr>
      <tr><th scope="row">Borrower</th><td>${escapeHtml(loan.first_name ? `${loan.first_name} ${loan.last_name}` : '—')}</td></tr>
      ${loan.program_name ? `<tr><th scope="row">Program</th><td>${escapeHtml(loan.program_name)}</td></tr>` : ''}
      <tr><th scope="row">Issued</th><td>${new Date(loan.checked_out_at).toLocaleDateString(undefined, { dateStyle: 'long' })}</td></tr>
      <tr><th scope="row">Return by</th><td>${
        loan.due_at ? new Date(loan.due_at).toLocaleDateString(undefined, { dateStyle: 'long' }) : 'No fixed return date'
      }</td></tr>
      ${loan.tech_name ? `<tr><th scope="row">Issued by</th><td>${escapeHtml(loan.tech_name)}</td></tr>` : ''}
    </table>

    <div class="agreement">${escapeHtml(agreement.agreement_text)}</div>

    <div class="sign-off">
      <p><strong>Signed by ${escapeHtml(agreement.signed_by_name)}</strong> (${escapeHtml(agreement.signed_by_role)})</p>
      ${signatureBlock}
      <p class="meta">
        Signed ${new Date(agreement.signed_at).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}
        &middot; method: ${escapeHtml(agreement.signature_method)}
        ${agreement.witness_name ? `&middot; witnessed by ${escapeHtml(agreement.witness_name)}` : ''}
      </p>
    </div>
  </div>
</body>
</html>`;
}

/** Active loans that should have an agreement but do not. */
export async function loansMissingAgreements(organizationId) {
  return query(
    `SELECT l.id, l.reference, l.checked_out_at, d.name AS device_name, d.barcode,
            CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) AS client_name
       FROM loans l
       JOIN devices d ON d.id = l.device_id
       LEFT JOIN clients c ON c.id = l.client_id
       LEFT JOIN loan_agreements a ON a.loan_id = l.id
      WHERE l.organization_id = ? AND l.status = 'active' AND a.id IS NULL
      ORDER BY l.checked_out_at DESC`,
    [organizationId],
  );
}
