/**
 * Stored files: condition photos and signature images.
 *
 * Files live on disk under the config directory, not in the database. A
 * loaner pool accumulates thousands of photos, and putting them in MySQL turns
 * every backup into a multi-gigabyte dump that nobody restores. The database
 * keeps metadata; the disk keeps bytes.
 *
 * Uploads arrive as base64 data URLs in a JSON body rather than multipart.
 * The browser already has the image in a canvas (it resizes before sending),
 * so this avoids multipart middleware and temporary files entirely — which
 * matters on shared hosting where the temp directory may be tiny.
 *
 * Nothing here is ever served from the public directory. Files are streamed
 * by an authenticated route, so a photo of a client's equipment is not a
 * guessable URL.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execute, query, queryOne } from '../db.js';
import { configPath } from '../config.js';
import { badRequest, notFound } from './util.js';

/** Images only, and only formats every browser can produce and display. */
const ALLOWED = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * 6 MB after client-side resizing. The browser downscales to 1600px on the
 * long edge before upload, so a normal photo lands around 200–400 KB; this
 * limit exists to stop a pathological upload, not to shape normal use.
 */
const MAX_BYTES = 6 * 1024 * 1024;

/** Uploads sit beside the config file, outside the web root. */
function uploadRoot() {
  return path.join(path.dirname(configPath()), 'uploads');
}

/**
 * Parse a `data:image/jpeg;base64,...` URL.
 * Rejects anything that is not an allowed image type before a byte is written.
 */
export function parseDataUrl(dataUrl) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || '').trim());
  if (!match) {
    throw badRequest('That image could not be read. Expected a base64 data URL.');
  }

  const mimeType = match[1].toLowerCase();
  if (!ALLOWED[mimeType]) {
    throw badRequest(
      `Images must be JPEG, PNG or WebP. This one is "${mimeType}".`,
      { allowed: Object.keys(ALLOWED) },
    );
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw badRequest('That image is empty.');
  if (buffer.length > MAX_BYTES) {
    throw badRequest(
      `That image is ${(buffer.length / 1048576).toFixed(1)} MB, over the ${MAX_BYTES / 1048576} MB limit.`,
    );
  }

  // Check the magic bytes rather than trusting the declared type — a
  // mislabelled file should fail here, not when something tries to display it.
  if (!looksLikeImage(buffer, mimeType)) {
    throw badRequest('That file is not the image type it claims to be.');
  }

  return { mimeType, extension: ALLOWED[mimeType], buffer };
}

function looksLikeImage(buffer, mimeType) {
  if (buffer.length < 12) return false;
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (mimeType === 'image/png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mimeType === 'image/webp') {
    return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

/**
 * Store an image and record it.
 *
 * Paths are sharded by organisation and month so no single directory ends up
 * with tens of thousands of entries, which some filesystems handle badly.
 */
export async function storeAttachment(ctx, {
  organizationId,
  kind = 'other',
  loanId = null,
  deviceId = null,
  repairId = null,
  phase = null,
  dataUrl,
  caption = null,
  width = null,
  height = null,
  uploadedBy = null,
}) {
  const { mimeType, extension, buffer } = parseDataUrl(dataUrl);

  const now = new Date();
  const relativeDir = path.join(
    String(organizationId),
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
  );
  const absoluteDir = path.join(uploadRoot(), relativeDir);
  await fsp.mkdir(absoluteDir, { recursive: true });

  const filename = `${crypto.randomBytes(16).toString('hex')}.${extension}`;
  const relativePath = path.join(relativeDir, filename);
  const absolutePath = path.join(absoluteDir, filename);

  await fsp.writeFile(absolutePath, buffer, { mode: 0o600 });

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  try {
    const result = await execute(
      `INSERT INTO attachments
         (organization_id, kind, loan_id, device_id, repair_id, phase, filename, mime_type,
          byte_size, width, height, storage_path, sha256, caption, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        organizationId, kind, loanId, deviceId, repairId, phase, filename, mimeType,
        buffer.length, width, height, relativePath, sha256,
        caption ? String(caption).slice(0, 255) : null, uploadedBy,
      ],
    );

    return {
      id: result.insertId,
      kind,
      filename,
      mime_type: mimeType,
      byte_size: buffer.length,
      caption,
      url: `/api/v1/attachments/${result.insertId}`,
    };
  } catch (err) {
    // Do not leave an orphaned file behind if the row could not be written.
    await fsp.unlink(absolutePath).catch(() => {});
    throw err;
  }
}

/** Metadata for one attachment, scoped to the caller's organisation. */
export async function getAttachment(organizationId, attachmentId) {
  return queryOne(
    'SELECT * FROM attachments WHERE id = ? AND organization_id = ?',
    [attachmentId, organizationId],
  );
}

/**
 * Absolute path for streaming, with a containment check.
 *
 * storage_path comes from our own insert, but a corrupted or hand-edited row
 * must not be able to read outside the upload directory.
 */
export function resolveStoragePath(attachment) {
  const root = uploadRoot();
  const resolved = path.resolve(root, attachment.storage_path);

  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw notFound('That file is not available.');
  }
  if (!fs.existsSync(resolved)) {
    throw notFound('That file is no longer on disk. It may have been removed during maintenance.');
  }
  return resolved;
}

/** Attachments for a loan, grouped by phase. */
export async function attachmentsForLoan(organizationId, loanId) {
  const rows = await query(
    `SELECT a.*, u.full_name AS uploaded_by_name
       FROM attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.loan_id = ? AND a.organization_id = ?
      ORDER BY a.created_at ASC`,
    [loanId, organizationId],
  );

  return rows.map(publicAttachment);
}

export async function attachmentsForRepair(organizationId, repairId) {
  const rows = await query(
    `SELECT a.*, u.full_name AS uploaded_by_name
       FROM attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.repair_id = ? AND a.organization_id = ?
      ORDER BY a.created_at ASC`,
    [repairId, organizationId],
  );
  return rows.map(publicAttachment);
}

export function publicAttachment(row) {
  return {
    id: row.id,
    kind: row.kind,
    phase: row.phase,
    caption: row.caption,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    width: row.width,
    height: row.height,
    uploaded_by_name: row.uploaded_by_name ?? null,
    created_at: row.created_at,
    url: `/api/v1/attachments/${row.id}`,
  };
}

/** Delete an attachment and its file. */
export async function deleteAttachment(organizationId, attachmentId) {
  const attachment = await getAttachment(organizationId, attachmentId);
  if (!attachment) throw notFound('That file does not exist.');

  await execute('DELETE FROM attachments WHERE id = ?', [attachmentId]);

  try {
    await fsp.unlink(resolveStoragePath(attachment));
  } catch {
    // The row is gone, which is what matters; a stray file is harmless and
    // will be caught by the orphan sweep.
  }

  return { deleted: true };
}

/**
 * Store several images, returning what succeeded and what did not.
 *
 * Photos are optional everywhere, so one bad image must not fail the check-out
 * it was attached to — the caller reports partial success instead.
 */
export async function storeMany(ctx, base, images = []) {
  const stored = [];
  const failed = [];

  for (const [index, image] of images.entries()) {
    try {
      stored.push(await storeAttachment(ctx, {
        ...base,
        dataUrl: typeof image === 'string' ? image : image.data,
        caption: typeof image === 'string' ? null : image.caption,
        width: typeof image === 'string' ? null : image.width,
        height: typeof image === 'string' ? null : image.height,
      }));
    } catch (err) {
      failed.push({ index, error: err.message });
    }
  }

  return { stored, failed };
}

/** Total bytes stored, for the settings screen. */
export async function storageUsage(organizationId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS files, COALESCE(SUM(byte_size), 0) AS bytes
       FROM attachments WHERE organization_id = ?`,
    [organizationId],
  );
  return {
    files: Number(row?.files ?? 0),
    bytes: Number(row?.bytes ?? 0),
    megabytes: Math.round((Number(row?.bytes ?? 0) / 1048576) * 10) / 10,
  };
}
