<?php
/**
 * Condition photos, signature images and documents.
 *
 * Files are written to disk under data/uploads (above the web root) and served
 * back through a route that checks the session, so a photo of a client's
 * equipment is never fetchable by guessing a URL.
 *
 * Only metadata goes in the database. A dump of a year's loans stays a
 * sensible size, and a photo can be streamed rather than loaded as a BLOB.
 */

declare(strict_types=1);

namespace Loaner;

final class Attachments
{
    public const KINDS  = ['condition_photo', 'signature', 'document', 'other'];
    public const PHASES = ['out', 'in', 'repair', 'agreement'];

    /** Accepted image types, mapped to the extension used on disk. */
    private const IMAGE_TYPES = [
        'image/jpeg' => 'jpg',
        'image/jpg'  => 'jpg',
        'image/png'  => 'png',
        'image/webp' => 'webp',
    ];

    /** 8 MB. A phone photo compressed to JPEG lands far below this. */
    public const MAX_BYTES = 8 * 1024 * 1024;

    // -----------------------------------------------------------------------
    // Storing
    // -----------------------------------------------------------------------

    /**
     * Decode a data URL and write it to disk.
     *
     * @return array{filename: string, mime: string, bytes: int, path: string, sha256: string}
     */
    private static function storeDataUrl(int $organizationId, string $dataUrl): array
    {
        if (!preg_match('~^data:(image/[a-z+]+);base64,(.+)$~i', trim($dataUrl), $m)) {
            throw Util::badRequest(
                'That image could not be read. Photos must be sent as a base64 data URL.',
                ['field' => 'images'],
            );
        }

        $mime = strtolower($m[1]);
        if (!isset(self::IMAGE_TYPES[$mime])) {
            throw Util::badRequest(
                'Photos must be JPEG, PNG or WebP. "' . $mime . '" is not supported.',
                ['field' => 'images'],
            );
        }

        $binary = base64_decode($m[2], true);
        if ($binary === false || $binary === '') {
            throw Util::badRequest('That image could not be decoded.', ['field' => 'images']);
        }

        if (strlen($binary) > self::MAX_BYTES) {
            throw Util::badRequest(
                sprintf(
                    'That image is %s, which is over the %s limit. Try a lower-resolution photo.',
                    self::humanSize(strlen($binary)), self::humanSize(self::MAX_BYTES),
                ),
                ['field' => 'images'],
            );
        }

        // Verify it really is an image rather than trusting the declared type:
        // an arbitrary file stored with an image extension is a liability.
        $info = @getimagesizefromstring($binary);
        if ($info === false) {
            throw Util::badRequest(
                'That file is not a readable image.',
                ['field' => 'images'],
            );
        }

        $extension = self::IMAGE_TYPES[$mime];
        $relative  = sprintf('%d/%s/%s.%s',
            $organizationId, date('Y-m'), bin2hex(random_bytes(16)), $extension);
        $absolute  = Config::uploadsDir() . '/' . $relative;

        $directory = dirname($absolute);
        if (!is_dir($directory) && !@mkdir($directory, 0770, true) && !is_dir($directory)) {
            throw new \RuntimeException("Could not create the upload directory at {$directory}.");
        }

        if (@file_put_contents($absolute, $binary) === false) {
            throw new \RuntimeException("Could not write the uploaded file to {$absolute}.");
        }
        @chmod($absolute, 0640);

        return [
            'filename' => basename($relative),
            'mime'     => $mime === 'image/jpg' ? 'image/jpeg' : $mime,
            'bytes'    => strlen($binary),
            'path'     => $relative,
            'sha256'   => hash('sha256', $binary),
            'width'    => (int) $info[0],
            'height'   => (int) $info[1],
        ];
    }

    /**
     * Attach photos to a loan at check-out or check-in.
     *
     * @param array<int, mixed> $images data URLs, or {data, caption}
     */
    public static function addLoanPhotos(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $loanId         = (int) $input['loanId'];
        $phase          = (string) ($input['phase'] ?? 'out');
        $images         = $input['images'] ?? [];

        if (!Settings::get($organizationId, 'photos.enabled')) {
            throw Util::conflict(
                'Condition photos are switched off for this organisation. An administrator can turn them '
                . 'on under Settings → Photos.',
            );
        }

        if (!in_array($phase, ['out', 'in'], true)) {
            throw Util::badRequest('A loan photo phase must be either "out" or "in".', ['field' => 'phase']);
        }

        $loan = Db::one(
            'SELECT l.id, l.reference, l.device_id, d.name AS device_name
               FROM loans l JOIN devices d ON d.id = l.device_id
              WHERE l.id = ? AND l.organization_id = ?',
            [$loanId, $organizationId],
        );
        if ($loan === null) {
            throw Util::notFound('That loan does not exist.');
        }

        if (!is_array($images) || $images === []) {
            throw Util::badRequest('No photos were supplied.', ['field' => 'images']);
        }

        $max      = (int) Settings::get($organizationId, 'photos.max_per_phase');
        $existing = (int) Db::value(
            'SELECT COUNT(*) FROM attachments WHERE loan_id = ? AND phase = ? AND kind = "condition_photo"',
            [$loanId, $phase],
        );

        if ($max > 0 && $existing + count($images) > $max) {
            throw Util::badRequest(
                sprintf(
                    'At most %d photo%s per phase, and this would make %d.%s',
                    $max, $max === 1 ? '' : 's', $existing + count($images),
                    $existing === 0
                        ? ''
                        : ($existing === 1
                            ? ' One is already attached.'
                            : " There are {$existing} already attached."),
                ),
                ['field' => 'images', 'limit' => $max, 'existing' => $existing],
            );
        }

        // Each photo stands or falls on its own. Rejecting the whole batch
        // because one frame was unreadable would mean losing good evidence of
        // a device's condition, which is the entire point of taking them.
        $saved  = [];
        $failed = [];

        foreach ($images as $index => $image) {
            $dataUrl = is_array($image) ? ($image['data'] ?? null) : $image;

            if (!is_string($dataUrl) || $dataUrl === '') {
                $failed[] = ['index' => $index, 'reason' => 'No image data was sent.'];
                continue;
            }

            try {
                $stored = self::storeDataUrl($organizationId, $dataUrl);
            } catch (HttpError $e) {
                $failed[] = ['index' => $index, 'reason' => $e->getMessage()];
                continue;
            }

            $id = Db::insert(
                'INSERT INTO attachments
                   (organization_id, kind, loan_id, device_id, phase, filename, mime_type,
                    byte_size, width, height, storage_path, sha256, caption, uploaded_by)
                 VALUES (?, "condition_photo", ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    $organizationId, $loanId, $loan['device_id'], $phase,
                    $stored['filename'], $stored['mime'], $stored['bytes'],
                    $stored['width'], $stored['height'], $stored['path'], $stored['sha256'],
                    is_array($image) ? Util::str($image['caption'] ?? null, 255) : null,
                    $input['actorId'] ?? null,
                ],
            );

            $saved[] = self::get($organizationId, $id);
        }

        if ($saved !== []) {
            Audit::record($actor, [
                'organizationId' => $organizationId,
                'action'         => Audit::ATTACHMENT_ADDED,
                'entityType'     => 'loan',
                'entityId'       => $loanId,
                'entityLabel'    => $loan['reference'],
                'summary'        => sprintf(
                    '%d condition photo%s attached to %s at check-%s',
                    count($saved), count($saved) === 1 ? '' : 's', $loan['reference'],
                    $phase === 'out' ? 'out' : 'in',
                ),
            ]);
        }

        return [
            'stored'  => $saved,
            'failed'  => $failed,
            'count'   => count($saved),
            'summary' => sprintf(
                '%d photo%s attached%s.',
                count($saved), count($saved) === 1 ? '' : 's',
                $failed === [] ? '' : ', ' . count($failed) . ' could not be read',
            ),
        ];
    }

    /** @param array<int, mixed> $images */
    public static function addRepairPhotos(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $repairId       = (int) $input['repairId'];
        $images         = $input['images'] ?? [];

        $repair = Db::one(
            'SELECT id, reference, device_id FROM repairs WHERE id = ? AND organization_id = ?',
            [$repairId, $organizationId],
        );
        if ($repair === null) {
            throw Util::notFound('That repair does not exist.');
        }
        if (!is_array($images) || $images === []) {
            throw Util::badRequest('No photos were supplied.', ['field' => 'images']);
        }

        $saved  = [];
        $failed = [];

        foreach ($images as $index => $image) {
            $dataUrl = is_array($image) ? ($image['data'] ?? null) : $image;

            if (!is_string($dataUrl) || $dataUrl === '') {
                $failed[] = ['index' => $index, 'reason' => 'No image data was sent.'];
                continue;
            }

            try {
                $stored = self::storeDataUrl($organizationId, $dataUrl);
            } catch (HttpError $e) {
                $failed[] = ['index' => $index, 'reason' => $e->getMessage()];
                continue;
            }

            $id = Db::insert(
                'INSERT INTO attachments
                   (organization_id, kind, repair_id, device_id, phase, filename, mime_type,
                    byte_size, width, height, storage_path, sha256, caption, uploaded_by)
                 VALUES (?, "condition_photo", ?, ?, "repair", ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    $organizationId, $repairId, $repair['device_id'],
                    $stored['filename'], $stored['mime'], $stored['bytes'],
                    $stored['width'], $stored['height'], $stored['path'], $stored['sha256'],
                    is_array($image) ? Util::str($image['caption'] ?? null, 255) : null,
                    $input['actorId'] ?? null,
                ],
            );

            $saved[] = self::get($organizationId, $id);
        }

        if ($saved !== []) {
            Audit::record($actor, [
                'organizationId' => $organizationId,
                'action'         => Audit::ATTACHMENT_ADDED,
                'entityType'     => 'repair',
                'entityId'       => $repairId,
                'entityLabel'    => $repair['reference'],
                'summary'        => count($saved) . ' photo(s) attached to repair ' . $repair['reference'],
            ]);
        }

        return ['stored' => $saved, 'failed' => $failed, 'count' => count($saved)];
    }

    /** Store a drawn signature image and return its attachment id. */
    public static function storeSignature(int $organizationId, int $loanId, string $dataUrl, ?int $actorId): int
    {
        $stored = self::storeDataUrl($organizationId, $dataUrl);

        return Db::insert(
            'INSERT INTO attachments
               (organization_id, kind, loan_id, phase, filename, mime_type,
                byte_size, width, height, storage_path, sha256, uploaded_by)
             VALUES (?, "signature", ?, "agreement", ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $organizationId, $loanId, $stored['filename'], $stored['mime'], $stored['bytes'],
                $stored['width'], $stored['height'], $stored['path'], $stored['sha256'], $actorId,
            ],
        );
    }

    // -----------------------------------------------------------------------
    // Reading
    // -----------------------------------------------------------------------

    public static function get(int $organizationId, int $attachmentId): ?array
    {
        $row = Db::one(
            'SELECT a.*, u.full_name AS uploaded_by_name
               FROM attachments a
               LEFT JOIN users u ON u.id = a.uploaded_by
              WHERE a.id = ? AND a.organization_id = ?',
            [$attachmentId, $organizationId],
        );

        return $row === null ? null : self::decorate($row);
    }

    public static function decorate(array $row): array
    {
        // Served through a route, never as a path into the uploads directory.
        $row['url']        = "/api/v1/attachments/{$row['id']}/file";
        $row['size_human'] = self::humanSize((int) $row['byte_size']);

        unset($row['storage_path']);

        return $row;
    }

    /** The absolute path on disk, checked to be inside the uploads directory. */
    public static function absolutePath(int $organizationId, int $attachmentId): ?array
    {
        // The loan's holder comes back with the row so the caller can check
        // entitlement without a second query.
        $row = Db::one(
            'SELECT a.id, a.storage_path, a.mime_type, a.filename, a.byte_size, a.loan_id,
                    l.client_id AS loan_client_id, l.request_id AS loan_request_id
               FROM attachments a
               LEFT JOIN loans l ON l.id = a.loan_id
              WHERE a.id = ? AND a.organization_id = ?',
            [$attachmentId, $organizationId],
        );
        if ($row === null) {
            return null;
        }

        $base = realpath(Config::uploadsDir());
        $path = realpath(Config::uploadsDir() . '/' . $row['storage_path']);

        // A stored path should never escape the uploads directory, but a
        // corrupt row must not become an arbitrary file read.
        if ($base === false || $path === false || !str_starts_with($path, $base . DIRECTORY_SEPARATOR)) {
            return null;
        }

        $row['absolute_path'] = $path;

        return $row;
    }

    /** @return array<int, array<string, mixed>> */
    public static function forLoan(int $organizationId, int $loanId): array
    {
        $rows = Db::all(
            'SELECT a.*, u.full_name AS uploaded_by_name
               FROM attachments a
               LEFT JOIN users u ON u.id = a.uploaded_by
              WHERE a.loan_id = ? AND a.organization_id = ?
              ORDER BY a.phase, a.created_at',
            [$loanId, $organizationId],
        );

        $decorated = array_map([self::class, 'decorate'], $rows);

        return [
            'out'       => array_values(array_filter($decorated, static fn ($a) => $a['phase'] === 'out')),
            'in'        => array_values(array_filter($decorated, static fn ($a) => $a['phase'] === 'in')),
            'agreement' => array_values(array_filter($decorated, static fn ($a) => $a['phase'] === 'agreement')),
            'all'       => $decorated,
        ];
    }

    /** @return array<int, array<string, mixed>> */
    public static function forRepair(int $organizationId, int $repairId): array
    {
        $rows = Db::all(
            'SELECT a.*, u.full_name AS uploaded_by_name
               FROM attachments a
               LEFT JOIN users u ON u.id = a.uploaded_by
              WHERE a.repair_id = ? AND a.organization_id = ?
              ORDER BY a.created_at',
            [$repairId, $organizationId],
        );

        return array_map([self::class, 'decorate'], $rows);
    }

    public static function delete(?array $actor, int $organizationId, int $attachmentId): void
    {
        $row = self::absolutePath($organizationId, $attachmentId);
        if ($row === null) {
            throw Util::notFound('That attachment does not exist.');
        }

        // The foreign key from loan_agreements is ON DELETE SET NULL, so
        // deleting a signature image would quietly leave a "signed" agreement
        // with nothing signed on it. The retention policy promises signed
        // agreements are never deleted; this is where that promise is kept.
        $kind = Db::value('SELECT kind FROM attachments WHERE id = ?', [$attachmentId]);

        if ($kind === 'signature') {
            throw Util::conflict(
                'That image is the signature on a loan agreement, and a signed agreement is kept '
                . 'as it was signed. If the agreement itself is wrong, add a note to the loan.',
                ['attachment_id' => $attachmentId, 'kind' => 'signature'],
            );
        }

        // Row first: a database row pointing at a missing file is a cosmetic
        // problem, whereas a file with no row is invisible and never cleaned up.
        Db::execute('DELETE FROM attachments WHERE id = ? AND organization_id = ?', [$attachmentId, $organizationId]);
        @unlink($row['absolute_path']);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::ATTACHMENT_ADDED,
            'entityType'     => 'attachment',
            'entityId'       => $attachmentId,
            'entityLabel'    => $row['filename'],
            'summary'        => "Attachment {$row['filename']} deleted",
        ]);
    }

    /**
     * Storage usage, so an administrator can see what photos are costing in
     * disk before the host tells them.
     */
    public static function usage(int $organizationId): array
    {
        $totals = Db::one(
            'SELECT COUNT(*) AS file_count, COALESCE(SUM(byte_size), 0) AS total_bytes
               FROM attachments WHERE organization_id = ?',
            [$organizationId],
        );

        // Update backups live in data/ too and can be larger than the photos.
        // Counted separately so "your photos are using 40 MB" stays true.
        $backupBytes = 0;
        foreach ((array) glob(Config::dataDir() . '/backup-*.zip') as $backup) {
            $backupBytes += (int) @filesize($backup);
        }

        $byKind = Db::all(
            'SELECT kind, COUNT(*) AS file_count, COALESCE(SUM(byte_size), 0) AS total_bytes
               FROM attachments WHERE organization_id = ?
              GROUP BY kind ORDER BY total_bytes DESC',
            [$organizationId],
        );

        foreach ($byKind as &$row) {
            $row['size_human'] = self::humanSize((int) $row['total_bytes']);
        }

        $uploads = Config::uploadsDir();
        $free    = is_dir($uploads) ? @disk_free_space($uploads) : false;

        $bytes = (int) $totals['total_bytes'];

        return [
            'file_count'  => (int) $totals['file_count'],
            // Same numbers under the short names the settings screen reads.
            // Megabytes rather than bytes there because the question being
            // answered is "is this a problem for my hosting plan?".
            'files'       => (int) $totals['file_count'],
            'megabytes'   => round($bytes / 1048576, 1),
            'total_bytes' => $bytes,
            'total_human' => self::humanSize($bytes),
            'by_kind'     => $byKind,
            'disk_free'   => $free === false ? null : (int) $free,
            'disk_free_human' => $free === false ? null : self::humanSize((int) $free),
            'photos_enabled'  => (bool) Settings::get($organizationId, 'photos.enabled'),
            'update_backups'  => [
                'bytes'  => $backupBytes,
                'human'  => self::humanSize($backupBytes),
                'notice' => $backupBytes === 0
                    ? null
                    : 'Update backups in data/ are using ' . self::humanSize($backupBytes)
                      . '. They are safe to delete once an update has proved itself.',
            ],
        ];
    }

    public static function humanSize(int $bytes): string
    {
        $units = ['B', 'KB', 'MB', 'GB', 'TB'];
        $index = 0;
        $size  = (float) $bytes;

        while ($size >= 1024 && $index < count($units) - 1) {
            $size /= 1024;
            $index++;
        }

        return ($index === 0 ? (string) (int) $size : number_format($size, 1)) . ' ' . $units[$index];
    }
}
