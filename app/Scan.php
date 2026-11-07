<?php
/**
 * Barcode scanning: lookup, and pairing a phone as a scanner.
 *
 * Three ways in, all producing the same result:
 *   - A USB or Bluetooth scanner types the code into the focused field. No
 *     setup, nothing to install, and nothing here is involved.
 *   - The browser's own camera, decoded client-side.
 *   - A phone paired to a channel, which posts each scan here for the desk to
 *     pick up.
 *
 * The paired phone is short-polled rather than streamed. PHP occupies an
 * Apache worker for the whole life of a request, so a long-lived SSE stream
 * per scan station would exhaust the worker pool on a shared host — which is
 * exactly where this software is expected to run.
 */

declare(strict_types=1);

namespace Loaner;

final class Scan
{
    /** Pairing codes are read aloud across a room, so no 0/O or 1/I/L. */
    private const CODE_LENGTH = 6;

    /** Scan events older than this are pruned; the desk only wants recent ones. */
    private const EVENT_RETENTION_HOURS = 12;

    // -----------------------------------------------------------------------
    // Lookup
    // -----------------------------------------------------------------------

    /**
     * What should happen when this barcode is scanned.
     *
     * Returns the device plus the action the desk should offer, so the operator
     * never has to say first whether they are lending or receiving: a device
     * that is out can only come back, and one on the shelf can only go out.
     *
     * An unrecognised code is an error rather than an empty result. A scan that
     * quietly produces nothing is indistinguishable from a scanner that is not
     * working, and the person at the desk needs to know which it is.
     */
    public static function lookup(int $organizationId, mixed $raw): array
    {
        $barcode = Barcode::normaliseScan($raw);

        if ($barcode === null || $barcode === '') {
            throw Util::badRequest('No barcode was scanned.', ['field' => 'barcode']);
        }

        $device = Loans::resolveDevice($organizationId, $barcode);

        if ($device === null) {
            throw new HttpError(
                404,
                'device_not_found',
                self::explainNoMatch($organizationId, $barcode),
                ['barcode' => $barcode],
            );
        }

        $full = Devices::get($organizationId, (int) $device['id']);
        $loan = Loans::activeLoanForDevice((int) $device['id']);

        if ($loan !== null) {
            $loanFull = Loans::get($organizationId, (int) $loan['id']);

            return [
                'barcode'          => $barcode,
                'device'           => $full,
                'active_loan'      => $loanFull,
                'suggested_action' => 'check_in',
                'blocked_reason'   => null,
                'waitlist'         => Reservations::forDevice($organizationId, (int) $device['id']),
                'accessories'      => Kits::accessories($organizationId, (int) $device['id']),
                'message'          => sprintf(
                    '%s is out on %s to %s%s.',
                    $full['name'], $loanFull['reference'],
                    Loans::describeHolders($loanFull),
                    $loanFull['is_overdue'] ? ' and is overdue' : '',
                ),
            ];
        }

        $lendable = in_array($device['status'], Loans::LENDABLE, true);

        $blocked = $lendable ? null : sprintf(
            '%s is marked "%s" and cannot be lent until that changes.',
            $full['name'], str_replace('_', ' ', (string) $device['status']),
        );

        return [
            'barcode'          => $barcode,
            'device'           => $full,
            'active_loan'      => null,
            'suggested_action' => $lendable ? 'check_out' : 'blocked',
            'blocked_reason'   => $blocked,
            'waitlist'         => Reservations::forDevice($organizationId, (int) $device['id']),
            'accessories'      => Kits::accessories($organizationId, (int) $device['id']),
            'message'          => $blocked ?? "{$full['name']} is available.",
        ];
    }

    /**
     * Say something more useful than "unknown code" where we can.
     *
     * A staff badge is a plausible thing to scan at a check-out desk, and so is
     * a retired device's old label, so both are named rather than lumped in
     * with a genuinely unknown barcode.
     */
    private static function explainNoMatch(int $organizationId, string $barcode): string
    {
        $badge = Db::one(
            'SELECT full_name FROM users WHERE organization_id = ? AND badge_barcode = ?',
            [$organizationId, $barcode],
        );

        if ($badge !== null) {
            return "That is {$badge['full_name']}’s staff badge, not a device. Scan the equipment instead.";
        }

        return "No device matches \"{$barcode}\". If this label was printed by another system, find the "
             . 'device by name instead.';
    }

    // -----------------------------------------------------------------------
    // Channels
    // -----------------------------------------------------------------------

    public static function createChannel(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $ownerId        = (int) $input['ownerId'];

        if (!Settings::get($organizationId, 'scan.remote_enabled')) {
            throw Util::conflict(
                'Pairing a phone as a scanner is switched off for this organisation. An administrator can '
                . 'turn it on under Settings → Scanning.',
            );
        }

        $ttl = max(5, (int) Settings::get($organizationId, 'scan.channel_ttl_minutes'));

        // One open channel per person. Two codes for one desk is a way to lose
        // scans into a channel nobody is watching.
        Db::execute(
            'DELETE FROM scan_channels WHERE owner_id = ? AND expires_at > NOW()',
            [$ownerId],
        );

        $channelId = null;
        $pairCode  = null;

        for ($attempt = 0; $attempt < 12; $attempt++) {
            $pairCode = Util::randomCode(self::CODE_LENGTH);
            try {
                $channelId = Db::insert(
                    'INSERT INTO scan_channels (organization_id, pair_code, label, owner_id, expires_at)
                     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))',
                    [$organizationId, $pairCode, Util::str($input['label'] ?? null, 120), $ownerId, $ttl],
                );
                break;
            } catch (\Throwable $e) {
                if (Db::isDuplicate($e)) {
                    continue;
                }
                throw $e;
            }
        }

        if ($channelId === null) {
            throw new \RuntimeException('Could not allocate a unique pairing code.');
        }

        $channel = self::channel($organizationId, $channelId, $ownerId);

        $base    = $input['baseUrl'] ?? '';
        $joinUrl = rtrim((string) $base, '/') . '/scanner.html#' . $pairCode;

        return [
            'channel'       => $channel,
            'join_url'      => $joinUrl,
            'join_qr_svg'   => Qr::svg($joinUrl, ['moduleSize' => 5, 'quietZone' => 2,
                                                  'title' => 'Pairing link for the scanner phone']),
            'expires_in'    => $ttl * 60,
            'poll_url'      => "/api/v1/scan/channels/{$channelId}/events",
            // Camera access needs a secure context. Saying so now beats a
            // phone silently refusing to open its camera later.
            'https_warning' => !empty($input['insecure'])
                ? 'This page is not being served over HTTPS, so the phone’s browser will refuse to open its '
                . 'camera. Pair over HTTPS, or use a USB scanner at this desk instead.'
                : null,
        ];
    }

    public static function channel(int $organizationId, int $channelId, ?int $ownerId = null): ?array
    {
        $row = Db::one(
            'SELECT c.*, u.full_name AS owner_name
               FROM scan_channels c JOIN users u ON u.id = c.owner_id
              WHERE c.id = ? AND c.organization_id = ?',
            [$channelId, $organizationId],
        );

        if ($row === null) {
            return null;
        }

        // A channel is a private line between one person's desk and their
        // phone; nobody else in the organisation should be able to read it.
        if ($ownerId !== null && (int) $row['owner_id'] !== $ownerId) {
            throw Util::forbidden('That pairing channel belongs to someone else.');
        }

        $row['expired'] = strtotime((string) $row['expires_at']) < time();

        return $row;
    }

    public static function closeChannel(int $organizationId, int $channelId, int $ownerId): void
    {
        $channel = self::channel($organizationId, $channelId, $ownerId);
        if ($channel === null) {
            throw Util::notFound('That pairing channel does not exist.');
        }

        Db::execute('DELETE FROM scan_channels WHERE id = ?', [$channelId]);
    }

    /**
     * How recently the desk must have polled to count as listening.
     *
     * Generous relative to the poll interval: a phone that reports "nobody is
     * listening" because one poll was slow would be worse than useless.
     */
    private const LISTENING_WINDOW_SECONDS = 15;

    /**
     * The phone's view of a channel, found by pairing code.
     *
     * No session is required. The pairing code is the credential, and it is a
     * deliberately narrow one: it is six characters, expires within hours, and
     * the only thing it can do is append a barcode for the desk to look up. It
     * cannot read the inventory, and a scan never performs a check-out on its
     * own — the person at the desk still confirms every action. Requiring a
     * sign-in on the phone instead would defeat the point of the feature,
     * which is to hand someone a phone and have it work.
     */
    public static function join(string $pairCode): array
    {
        $channel = self::channelByCode($pairCode);

        return [
            'paired'  => true,
            'channel' => [
                'pair_code'    => $channel['pair_code'],
                'label'        => $channel['label'] ?: 'Scan station',
                'organization' => $channel['organization_name'],
                'operator'     => $channel['owner_name'],
                'scan_count'   => (int) $channel['scan_count'],
                'expires_at'   => $channel['expires_at'],
            ],
            'station_connected' => self::isListening($channel),
        ];
    }

    /** The phone reports a scan. */
    public static function push(string $pairCode, array $input): array
    {
        $barcode = Barcode::normaliseScan($input['barcode'] ?? null);

        if ($barcode === null || $barcode === '') {
            throw Util::badRequest('No barcode was sent.', ['field' => 'barcode']);
        }

        $channel = self::channelByCode($pairCode);

        $eventId = Db::transaction(static function () use ($channel, $barcode, $input): int {
            $id = Db::insert(
                'INSERT INTO scan_events (channel_id, barcode, source, scanned_by)
                 VALUES (?, ?, ?, ?)',
                [
                    $channel['id'], $barcode,
                    Util::str($input['source'] ?? 'camera', 32) ?? 'camera',
                    $channel['owner_id'],
                ],
            );

            Db::execute(
                'UPDATE scan_channels SET scan_count = scan_count + 1, last_scan_at = NOW() WHERE id = ?',
                [$channel['id']],
            );

            return $id;
        });

        // Name the device back to the phone. "Sent Dragon headset" is far
        // easier to work with one-handed than "OK", and it catches a mis-scan
        // immediately instead of at the desk.
        $device = null;
        try {
            $match = Loans::resolveDevice((int) $channel['organization_id'], $barcode);
            if ($match !== null) {
                $device = ['id' => (int) $match['id'], 'name' => $match['name'],
                           'barcode' => $match['barcode']];
            }
        } catch (\Throwable $e) {
            error_log('[scan] push lookup failed: ' . $e->getMessage());
        }

        $listening = self::isListening($channel);

        return [
            'accepted'              => true,
            'event_id'              => $eventId,
            'barcode'               => $barcode,
            'device'                => $device,
            'delivered_to_station'  => $listening,
            'message'               => $listening
                ? 'sent to the computer.'
                : 'saved, but the scan station is not listening. Check the computer screen.',
        ];
    }

    /** Look up a live channel by its pairing code, or explain why not. */
    private static function channelByCode(string $pairCode): array
    {
        $code = strtoupper(trim($pairCode));

        $channel = Db::one(
            'SELECT c.*, o.name AS organization_name, u.full_name AS owner_name
               FROM scan_channels c
               JOIN organizations o ON o.id = c.organization_id
               JOIN users u ON u.id = c.owner_id
              WHERE c.pair_code = ?',
            [$code],
        );

        if ($channel === null) {
            throw Util::notFound(
                'That pairing code is not recognised. Check it on the computer screen — it may have expired.',
            );
        }

        if (strtotime((string) $channel['expires_at']) < time()) {
            // 404 rather than 409: the phone treats "gone" as "go back to the
            // join screen", which is exactly the right thing to do here.
            throw Util::notFound('That pairing code has expired. Ask the station for a new one.');
        }

        return $channel;
    }

    private static function isListening(array $channel): bool
    {
        return !empty($channel['last_poll_at'])
            && strtotime((string) $channel['last_poll_at']) > time() - self::LISTENING_WINDOW_SECONDS;
    }

    /**
     * The desk polls for scans it has not seen.
     *
     * `after` is the last event id already handled, so nothing is delivered
     * twice and nothing is missed between polls.
     */
    public static function events(int $organizationId, int $channelId, int $ownerId, int $after = 0): array
    {
        $channel = self::channel($organizationId, $channelId, $ownerId);

        if ($channel === null) {
            return ['closed' => true, 'reason' => 'That pairing channel has closed.', 'events' => []];
        }
        if ($channel['expired']) {
            return ['closed' => true, 'reason' => 'The pairing code has expired.', 'events' => [],
                    'channel' => $channel];
        }

        // Stamping the poll is what lets the phone say whether anyone is
        // listening. Done on every poll, including empty ones.
        Db::execute('UPDATE scan_channels SET last_poll_at = NOW() WHERE id = ?', [$channelId]);

        $events = Db::all(
            'SELECT id, barcode, source, created_at FROM scan_events
              WHERE channel_id = ? AND id > ? ORDER BY id LIMIT 50',
            [$channelId, $after],
        );

        return [
            'closed'   => false,
            'events'   => $events,
            'last_id'  => $events === [] ? $after : (int) end($events)['id'],
            'channel'  => $channel,
            // The client uses this rather than a hard-coded interval, so the
            // poll rate can be eased without shipping new JavaScript.
            'poll_after_ms' => $events === [] ? 1500 : 400,
        ];
    }

    /** Remove expired channels and stale events. Called by the job runner. */
    public static function prune(): array
    {
        $events = Db::execute(
            'DELETE FROM scan_events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)',
            [self::EVENT_RETENTION_HOURS],
        );

        // Channels go last: deleting one cascades to its events anyway.
        $channels = Db::execute('DELETE FROM scan_channels WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)');

        return ['events_pruned' => $events, 'channels_pruned' => $channels];
    }
}
