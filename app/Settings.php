<?php
/**
 * Per-organisation settings.
 *
 * Stored as key/value rows rather than columns, so a new admin-configurable
 * setting does not need a migration. Values marked secret are encrypted at
 * rest and never leave the server in readable form.
 */

declare(strict_types=1);

namespace Loaner;

final class Settings
{
    /**
     * Setting definitions. Anything not declared here is rejected, so a typo
     * in a settings POST cannot quietly create a phantom key nothing reads.
     *
     * Shape: [type, default, group, secret?]
     */
    public const DEFINITIONS = [
        // --- Microsoft Graph mail -------------------------------------------
        'graph.enabled'       => ['boolean', false, 'email'],
        'graph.tenant_id'     => ['string',  '',    'email'],
        'graph.client_id'     => ['string',  '',    'email'],
        'graph.client_secret' => ['string',  '',    'email', true],
        'graph.sender'        => ['string',  '',    'email'],
        'graph.reply_to'      => ['string',  '',    'email'],

        // --- Notification toggles -------------------------------------------
        'notify.request_submitted' => ['boolean', true,  'notifications'],
        'notify.request_approved'  => ['boolean', true,  'notifications'],
        'notify.request_denied'    => ['boolean', true,  'notifications'],
        'notify.ready_for_pickup'  => ['boolean', true,  'notifications'],
        'notify.checked_out'       => ['boolean', true,  'notifications'],
        'notify.due_soon'          => ['boolean', true,  'notifications'],
        'notify.overdue'           => ['boolean', true,  'notifications'],
        'notify.checked_in'        => ['boolean', false, 'notifications'],
        'notify.reservation_ready' => ['boolean', true,  'notifications'],
        'notify.due_soon_days'     => ['integer', 3,     'notifications'],
        'notify.admin_recipients'  => ['string',  '',    'notifications'],

        // --- Loan policy ------------------------------------------------------
        'loans.allow_overdue_checkout' => ['boolean', false, 'loans'],
        'loans.require_client_or_tech' => ['boolean', true,  'loans'],
        'loans.max_per_client'         => ['integer', 0,     'loans'],
        'loans.auto_approve_vrc'       => ['boolean', false, 'loans'],

        // --- Scanning ---------------------------------------------------------
        'scan.remote_enabled'      => ['boolean', true, 'scanning'],
        'scan.channel_ttl_minutes' => ['integer', 240,  'scanning'],
        'scan.offline_enabled'     => ['boolean', true, 'scanning'],

        // --- Loan agreements --------------------------------------------------
        'agreements.enabled'     => ['boolean', false, 'agreements'],
        'agreements.required'    => ['boolean', false, 'agreements'],
        'agreements.allow_waive' => ['boolean', true,  'agreements'],
        'agreements.text'        => ['string',  '',    'agreements'],

        // --- Condition photos -------------------------------------------------
        // Off by default. Photographing a client's equipment is a data
        // protection decision an organisation should make deliberately, not
        // inherit from a default.
        'photos.enabled'            => ['boolean', false, 'photos'],
        'photos.prompt_on_checkout' => ['boolean', true,  'photos'],
        'photos.prompt_on_checkin'  => ['boolean', true,  'photos'],
        'photos.max_per_phase'      => ['integer', 4,     'photos'],

        // --- Reservations -----------------------------------------------------
        'reservations.enabled'    => ['boolean', true, 'reservations'],
        'reservations.hold_hours' => ['integer', 48,   'reservations'],

        // --- Trial outcomes ---------------------------------------------------
        // Prompting is on; requiring is not. An outcome entered under protest
        // by somebody who does not know is worse than a blank, because the
        // purchasing reports cannot tell the two apart.
        'outcomes.enabled'          => ['boolean', true,  'outcomes'],
        'outcomes.prompt_on_checkin' => ['boolean', true, 'outcomes'],
        'outcomes.chase_after_days' => ['integer', 7,     'outcomes'],

        // --- Hygiene ----------------------------------------------------------
        'hygiene.enabled'            => ['boolean', false, 'hygiene'],
        'hygiene.require_between_loans' => ['boolean', false, 'hygiene'],
        'hygiene.default_method'     => ['string',  '',    'hygiene'],

        // --- SMS (Twilio) -----------------------------------------------------
        'sms.enabled'      => ['boolean', false, 'sms'],
        'sms.account_sid'  => ['string',  '',    'sms'],
        'sms.auth_token'   => ['string',  '',    'sms', true],
        'sms.from_number'  => ['string',  '',    'sms'],
        'sms.on_ready_for_pickup' => ['boolean', true,  'sms'],
        'sms.on_due_soon'         => ['boolean', false, 'sms'],
        'sms.on_overdue'          => ['boolean', true,  'sms'],

        // --- Sites ------------------------------------------------------------
        'sites.enabled' => ['boolean', false, 'sites'],

        // --- Retention --------------------------------------------------------
        // Off by default: deleting client data is not something software should
        // start doing because nobody changed a setting.
        'retention.enabled'            => ['boolean', false, 'retention'],
        'retention.client_years'       => ['integer', 7,     'retention'],
        'retention.audit_years'        => ['integer', 7,     'retention'],
        'retention.email_log_days'     => ['integer', 365,   'retention'],

        // --- Two-factor -------------------------------------------------------
        'security.require_2fa_for_admins' => ['boolean', false, 'security'],

        // --- Sign in with Microsoft -------------------------------------------
        // Creating accounts is off by default: being in the directory is not
        // the same as being given access to client records.
        'sso.enabled'       => ['boolean', false, 'sso'],
        'sso.tenant_id'     => ['string',  '',    'sso'],
        'sso.client_id'     => ['string',  '',    'sso'],
        'sso.client_secret' => ['string',  '',    'sso', true],
        'sso.required'      => ['boolean', false, 'sso'],
        'sso.auto_create'   => ['boolean', false, 'sso'],
        'sso.default_role'  => ['string',  'viewer', 'sso'],
        'sso.session_hours' => ['integer', 24,    'sso'],
    ];

    public const GROUPS = [
        'email', 'notifications', 'loans', 'scanning', 'agreements', 'photos', 'reservations',
        'outcomes', 'hygiene', 'sms', 'sites', 'retention', 'security', 'sso',
    ];

    /**
     * The smallest and largest value each whole-number setting may hold.
     *
     * Nothing checked these. A hold of minus three hours was saved as asked,
     * and the next person promoted from a waitlist had their hold expire before
     * the email telling them about it was sent. Zero where zero has a meaning
     * ("no limit", "keep them") is allowed; elsewhere it is not.
     */
    private const RANGES = [
        'notify.due_soon_days'      => [1, 60],
        'loans.max_per_client'      => [0, 100],
        'scan.channel_ttl_minutes'  => [5, 1440],
        'photos.max_per_phase'      => [1, 20],
        'reservations.hold_hours'   => [1, 720],
        'outcomes.chase_after_days' => [1, 365],
        'retention.client_years'    => [0, 100],
        'retention.audit_years'     => [0, 100],
        'retention.email_log_days'  => [0, 36500],
        'sso.session_hours'         => [1, 336],
    ];

    /** @var array<int, array<string, mixed>> */
    private static array $cache = [];

    /**
     * Refuse a value that cannot be what the setting is.
     *
     * Runs over the whole request before anything is written, so a form with
     * one bad box saves nothing rather than half of itself.
     */
    private static function validate(string $key, string $type, mixed $value): void
    {
        if ($value !== null && !is_scalar($value)) {
            throw Util::badRequest("The setting {$key} must be a single value.", ['field' => $key]);
        }

        if ($type !== 'integer') {
            return;
        }

        $text = is_bool($value) ? '' : trim((string) $value);

        if (preg_match('/^-?\d{1,9}$/', $text) !== 1) {
            throw Util::badRequest("The setting {$key} must be a whole number.", ['field' => $key]);
        }

        [$min, $max] = self::RANGES[$key] ?? [0, 999999999];
        $number      = (int) $text;

        if ($number < $min || $number > $max) {
            throw Util::badRequest(
                "The setting {$key} must be between {$min} and {$max}.",
                ['field' => $key, 'min' => $min, 'max' => $max],
            );
        }
    }

    private static function coerce(string $type, mixed $raw, mixed $default): mixed
    {
        if ($raw === null) {
            return $default;
        }

        return match ($type) {
            'boolean' => $raw === '1' || $raw === 1 || $raw === true || $raw === 'true',
            'integer' => is_numeric($raw) ? (int) $raw : $default,
            default   => (string) $raw,
        };
    }

    private static function serialise(string $type, mixed $value): string
    {
        return match ($type) {
            'boolean' => Util::bool($value) ? '1' : '0',
            'integer' => (string) ((int) $value),
            default   => $value === null ? '' : (string) $value,
        };
    }

    /**
     * All settings for an organisation, with defaults filled in. Secrets are
     * decrypted — this is the server-side view.
     */
    public static function all(int $organizationId): array
    {
        if (isset(self::$cache[$organizationId])) {
            return self::$cache[$organizationId];
        }

        $stored = [];
        foreach (Db::all(
            'SELECT setting_key, setting_value, is_secret FROM org_settings WHERE organization_id = ?',
            [$organizationId],
        ) as $row) {
            $stored[$row['setting_key']] = $row;
        }

        $result = [];

        foreach (self::DEFINITIONS as $key => $definition) {
            [$type, $default] = $definition;
            $isSecret = $definition[3] ?? false;

            if (!isset($stored[$key])) {
                $result[$key] = $default;
                continue;
            }

            $raw = $isSecret
                ? Secrets::decrypt($stored[$key]['setting_value'])
                : $stored[$key]['setting_value'];

            $result[$key] = self::coerce($type, $raw, $default);
        }

        return self::$cache[$organizationId] = $result;
    }

    public static function get(int $organizationId, string $key): mixed
    {
        if (!isset(self::DEFINITIONS[$key])) {
            throw new \InvalidArgumentException("Unknown setting: {$key}");
        }

        return self::all($organizationId)[$key];
    }

    /**
     * The client-safe view: secrets become a boolean "is it set" plus a masked
     * hint, never the value.
     */
    public static function forClient(int $organizationId): array
    {
        $settings = self::all($organizationId);
        $safe     = [];

        foreach (self::DEFINITIONS as $key => $definition) {
            if ($definition[3] ?? false) {
                $value = $settings[$key];
                $safe[$key]              = null;
                $safe[$key . '__is_set'] = $value !== '' && $value !== null;
                $safe[$key . '__hint']   = $value ? Secrets::mask((string) $value) : null;
            } else {
                $safe[$key] = $settings[$key];
            }
        }

        return $safe;
    }

    /**
     * Write settings. Returns which keys actually changed, so the caller can
     * write a meaningful audit entry.
     *
     * A secret submitted as an empty string means "leave unchanged" —
     * otherwise every save from a form that masks the field would wipe it. To
     * clear one, send the literal string "__CLEAR__".
     */
    public static function update(int $organizationId, array $updates): array
    {
        $changed = [];
        $unknown = [];

        foreach ($updates as $key => $value) {
            if (isset(self::DEFINITIONS[$key])) {
                self::validate((string) $key, self::DEFINITIONS[$key][0], $value);
            }
        }

        foreach ($updates as $key => $value) {
            if (!isset(self::DEFINITIONS[$key])) {
                $unknown[] = $key;
                continue;
            }

            $definition = self::DEFINITIONS[$key];
            $isSecret   = $definition[3] ?? false;

            if ($isSecret) {
                if ($value === '' || $value === null) {
                    continue; // unchanged
                }

                $toStore = $value === '__CLEAR__' ? null : Secrets::encrypt((string) $value);

                Db::execute(
                    'INSERT INTO org_settings (organization_id, setting_key, setting_value, is_secret)
                     VALUES (?, ?, ?, 1)
                     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), is_secret = 1',
                    [$organizationId, $key, $toStore],
                );

                $changed[] = $key;
                continue;
            }

            $serialised = self::serialise($definition[0], $value);

            $existing = Db::value(
                'SELECT setting_value FROM org_settings WHERE organization_id = ? AND setting_key = ?',
                [$organizationId, $key],
            );

            if ($existing !== null && (string) $existing === $serialised) {
                continue;
            }

            Db::execute(
                'INSERT INTO org_settings (organization_id, setting_key, setting_value, is_secret)
                 VALUES (?, ?, ?, 0)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), is_secret = 0',
                [$organizationId, $key, $serialised],
            );

            $changed[] = $key;
        }

        unset(self::$cache[$organizationId]);

        return ['changed' => $changed, 'unknown' => $unknown];
    }

    /** Parse a comma/semicolon/newline separated recipient list. */
    public static function parseRecipients(?string $value): array
    {
        if ($value === null || trim($value) === '') {
            return [];
        }

        return array_values(array_filter(
            array_map('trim', preg_split('/[,;\n]/', $value) ?: []),
            static fn (string $s): bool => str_contains($s, '@'),
        ));
    }

    // -----------------------------------------------------------------------
    // Organisation and loan periods
    // -----------------------------------------------------------------------

    public static function organization(int $organizationId): ?array
    {
        return Db::one('SELECT * FROM organizations WHERE id = ?', [$organizationId]);
    }

    public static function loanPeriods(int $organizationId, bool $includeInactive = false): array
    {
        return Db::all(
            'SELECT * FROM loan_periods
              WHERE organization_id = ? ' . ($includeInactive ? '' : 'AND active = 1') . '
              ORDER BY is_default DESC, sort_order ASC, days ASC',
            [$organizationId],
        );
    }

    public static function defaultLoanPeriod(int $organizationId): ?array
    {
        return Db::one(
            'SELECT * FROM loan_periods
              WHERE organization_id = ? AND active = 1
              ORDER BY is_default DESC, sort_order ASC LIMIT 1',
            [$organizationId],
        );
    }
}
