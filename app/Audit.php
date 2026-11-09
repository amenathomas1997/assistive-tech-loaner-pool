<?php
/**
 * Append-only audit trail.
 *
 * Every state change routes through record(). Two rules make the log
 * trustworthy:
 *
 *   1. Nothing in this codebase ever UPDATEs or DELETEs audit_log.
 *   2. A failure to write an audit row never fails the request it describes,
 *      but it is logged to the PHP error log. Losing an audit row is bad;
 *      losing a device check-in because the audit insert deadlocked is worse.
 */

declare(strict_types=1);

namespace Loaner;

final class Audit
{
    // Canonical action verbs. Keeping these fixed makes the log filterable.
    public const LOGIN                    = 'auth.login';
    public const LOGIN_FAILED             = 'auth.login_failed';
    public const LOGOUT                   = 'auth.logout';
    public const PASSWORD_CHANGED         = 'auth.password_changed';
    public const PASSWORD_RESET_REQUESTED = 'auth.password_reset_requested';
    public const PASSWORD_RESET_COMPLETED = 'auth.password_reset_completed';

    public const DEVICE_CREATED          = 'device.created';
    public const DEVICE_UPDATED          = 'device.updated';
    public const DEVICE_DELETED          = 'device.deleted';
    public const DEVICE_IMPORTED         = 'device.imported';
    public const DEVICE_STATUS_CHANGED   = 'device.status_changed';
    public const DEVICE_BARCODE_ASSIGNED = 'device.barcode_assigned';

    public const LOAN_CHECKED_OUT = 'loan.checked_out';
    public const LOAN_CHECKED_IN  = 'loan.checked_in';
    public const LOAN_EXTENDED    = 'loan.extended';
    public const LOAN_REDUCED     = 'loan.reduced';
    public const LOAN_CANCELLED   = 'loan.cancelled';
    public const LOAN_TRANSFERRED = 'loan.transferred';
    public const LOAN_OUTCOME_RECORDED = 'loan.outcome_recorded';
    public const LOAN_SHIPPED     = 'loan.shipped';

    public const DEVICE_SANITISED = 'device.sanitised';
    public const DEVICE_DISPOSED  = 'device.disposed';
    public const DEVICE_TRANSFERRED = 'device.transferred';

    public const CLIENT_IMPORTED   = 'client.imported';
    public const CLIENT_ANONYMISED = 'client.anonymised';

    public const SITE_CREATED = 'site.created';
    public const SITE_UPDATED = 'site.updated';

    public const SMS_SENT   = 'sms.sent';
    public const SMS_FAILED = 'sms.failed';

    public const BACKUP_DOWNLOADED = 'backup.downloaded';

    public const TWOFACTOR_ENABLED  = 'auth.twofactor_enabled';
    public const TWOFACTOR_DISABLED = 'auth.twofactor_disabled';
    public const TWOFACTOR_FAILED   = 'auth.twofactor_failed';
    public const TWOFACTOR_RECOVERY_USED = 'auth.twofactor_recovery_used';
    public const TWOFACTOR_CODES_REISSUED = 'auth.twofactor_codes_reissued';

    public const RETENTION_PURGE = 'retention.purge';

    public const REQUEST_SUBMITTED     = 'request.submitted';
    public const REQUEST_APPROVED      = 'request.approved';
    public const REQUEST_DENIED        = 'request.denied';
    public const REQUEST_CANCELLED     = 'request.cancelled';
    public const REQUEST_STATE_CHANGED = 'request.state_changed';
    public const REQUEST_FULFILLED     = 'request.fulfilled';

    public const CLIENT_CREATED  = 'client.created';
    public const CLIENT_UPDATED  = 'client.updated';
    public const PROGRAM_CREATED = 'program.created';
    public const PROGRAM_UPDATED = 'program.updated';

    public const USER_CREATED     = 'user.created';
    public const USER_UPDATED     = 'user.updated';
    public const USER_DEACTIVATED = 'user.deactivated';

    public const SETTINGS_UPDATED = 'settings.updated';
    public const PERIOD_CREATED   = 'period.created';
    public const PERIOD_UPDATED   = 'period.updated';
    public const PERIOD_DELETED   = 'period.deleted';

    public const APIKEY_CREATED = 'apikey.created';
    public const APIKEY_REVOKED = 'apikey.revoked';

    public const EMAIL_SENT   = 'email.sent';
    public const EMAIL_FAILED = 'email.failed';

    public const AGREEMENT_SIGNED = 'agreement.signed';
    public const AGREEMENT_WAIVED = 'agreement.waived';

    public const RESERVATION_CREATED   = 'reservation.created';
    public const RESERVATION_READY     = 'reservation.ready';
    public const RESERVATION_CANCELLED = 'reservation.cancelled';
    public const RESERVATION_FULFILLED = 'reservation.fulfilled';

    public const REPAIR_OPENED  = 'repair.opened';
    public const REPAIR_UPDATED = 'repair.updated';
    public const REPAIR_CLOSED  = 'repair.closed';

    public const KIT_CREATED      = 'kit.created';
    public const KIT_UPDATED      = 'kit.updated';
    public const KIT_DELETED      = 'kit.deleted';
    public const KIT_CHECKED_OUT  = 'kit.checked_out';
    public const KIT_CHECKED_IN   = 'kit.checked_in';

    public const ATTACHMENT_ADDED = 'attachment.added';
    public const ATTACHMENT_DELETED = 'attachment.deleted';
    public const INSTALL_COMPLETED = 'install.completed';

    /**
     * Write one audit row.
     *
     * $actor is the shape Auth::attach() builds, or a synthetic one for
     * background jobs, which have no request.
     */
    public static function record(?array $actor, array $entry): void
    {
        try {
            $organizationId = $entry['organizationId'] ?? $actor['organizationId'] ?? null;
            if ($organizationId === null) {
                return; // Nothing sensible to attach the row to.
            }

            Db::execute(
                'INSERT INTO audit_log
                   (organization_id, actor_id, actor_label, actor_type, action,
                    entity_type, entity_id, entity_label, summary, detail, ip)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    $organizationId,
                    $actor['userId'] ?? null,
                    $actor['label'] ?? null,
                    $actor['actorType'] ?? 'user',
                    $entry['action'],
                    $entry['entityType'] ?? null,
                    $entry['entityId'] ?? null,
                    isset($entry['entityLabel']) ? mb_substr((string) $entry['entityLabel'], 0, 190) : null,
                    isset($entry['summary']) ? mb_substr((string) $entry['summary'], 0, 500) : null,
                    isset($entry['detail']) ? json_encode($entry['detail'], JSON_UNESCAPED_SLASHES) : null,
                    $actor['ip'] ?? null,
                ],
            );
        } catch (\Throwable $e) {
            // Deliberately swallowed — see the class comment.
            error_log('[audit] failed to record ' . ($entry['action'] ?? '?') . ': ' . $e->getMessage());
        }
    }

    /** The actor shape, built from a request. */
    public static function actor(Request $request): array
    {
        $auth = $request->auth ?? [];

        return [
            'organizationId' => $auth['organizationId'] ?? null,
            'userId'         => $auth['userId'] ?? null,
            'label'          => $auth['label'] ?? null,
            'actorType'      => $auth['actorType'] ?? 'user',
            'ip'             => $request->ip,
        ];
    }

    /** A synthetic actor for scheduled work. */
    public static function system(int $organizationId, string $label = 'Scheduled job'): array
    {
        return [
            'organizationId' => $organizationId,
            'userId'         => null,
            'label'          => $label,
            'actorType'      => 'system',
            'ip'             => null,
        ];
    }

    /**
     * Search the log. Column names come from fixed maps, so no user input
     * reaches the SQL text.
     */
    public static function search(int $organizationId, array $filters = [], int $limit = 50, int $offset = 0): array
    {
        $where  = ['a.organization_id = ?'];
        $params = [$organizationId];

        if (!empty($filters['action'])) {
            $where[] = 'a.action = ?';
            $params[] = $filters['action'];
        }
        if (!empty($filters['actionPrefix'])) {
            $where[] = 'a.action LIKE ?';
            $params[] = $filters['actionPrefix'] . '%';
        }
        if (!empty($filters['actorId'])) {
            $where[] = 'a.actor_id = ?';
            $params[] = $filters['actorId'];
        }
        if (!empty($filters['entityType'])) {
            $where[] = 'a.entity_type = ?';
            $params[] = $filters['entityType'];
        }
        if (!empty($filters['entityId'])) {
            $where[] = 'a.entity_id = ?';
            $params[] = $filters['entityId'];
        }
        if (!empty($filters['from'])) {
            $where[] = 'a.created_at >= ?';
            $params[] = Util::mysqlDateTime($filters['from']);
        }
        if (!empty($filters['to'])) {
            $where[] = 'a.created_at <= ?';
            $params[] = Util::endOfRange($filters['to']);
        }
        if (!empty($filters['search'])) {
            $where[] = '(a.summary LIKE ? OR a.entity_label LIKE ? OR a.actor_label LIKE ?)';
            $like = '%' . $filters['search'] . '%';
            array_push($params, $like, $like, $like);
        }

        $whereSql = implode(' AND ', $where);

        $rows = Db::all(
            "SELECT a.*, u.full_name AS actor_name, u.email AS actor_email
               FROM audit_log a
               LEFT JOIN users u ON u.id = a.actor_id
              WHERE {$whereSql}
              ORDER BY a.created_at DESC, a.id DESC
              LIMIT " . (int) $limit . ' OFFSET ' . (int) $offset,
            $params,
        );

        foreach ($rows as &$row) {
            $row['detail'] = $row['detail'] !== null
                ? (json_decode((string) $row['detail'], true) ?? ['raw' => $row['detail']])
                : null;
        }
        unset($row);

        $total = (int) Db::value("SELECT COUNT(*) FROM audit_log a WHERE {$whereSql}", $params);

        return ['rows' => $rows, 'total' => $total];
    }

    /**
     * Diff two records and return only what changed, so an "updated" row says
     * what actually moved instead of dumping the whole entity.
     */
    public static function diff(?array $before, ?array $after, array $fields): ?array
    {
        $changes = [];

        foreach ($fields as $field) {
            $old = self::normalise($before[$field] ?? null);
            $new = self::normalise($after[$field] ?? null);

            if ($old !== $new) {
                $changes[$field] = ['from' => $old, 'to' => $new];
            }
        }

        return $changes === [] ? null : $changes;
    }

    private static function normalise(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if ($value instanceof \DateTimeInterface) {
            return $value->format('c');
        }
        return (string) $value;
    }

    /** The action vocabulary, for building the audit filter in the UI. */
    public static function actions(): array
    {
        $reflection = new \ReflectionClass(self::class);
        $actions = [];

        foreach ($reflection->getConstants() as $key => $value) {
            if (!is_string($value) || !str_contains($value, '.')) {
                continue;
            }
            $actions[] = [
                'key'    => $key,
                'action' => $value,
                'group'  => explode('.', $value)[0],
            ];
        }

        return $actions;
    }
}
