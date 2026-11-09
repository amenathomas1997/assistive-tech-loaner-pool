<?php
/**
 * Organisation settings, loan periods, email configuration and API keys.
 *
 * Secrets are never returned. A GET of the settings shows a Graph client
 * secret as "set" and masked; sending an empty value back leaves it unchanged,
 * and the literal "__CLEAR__" removes it. That is what makes the settings form
 * safe to save after loading it without re-entering every secret.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Audit;
use Loaner\Auth;
use Loaner\Barcode;
use Loaner\Config;
use Loaner\Db;
use Loaner\Jobs;
use Loaner\Mailer;
use Loaner\Request;
use Loaner\Response;
use Loaner\Router;
use Loaner\Settings;
use Loaner\Updates;
use Loaner\Util;

final class AdminRoutes
{
    public static function register(Router $router): void
    {
        $router->get('/admin/organization', [self::class, 'organization'], 'settings.read');
        $router->patch('/admin/organization', [self::class, 'updateOrganization'], 'settings.write');

        $router->get('/admin/loan-periods', [self::class, 'periods'], 'settings.read');
        $router->post('/admin/loan-periods', [self::class, 'createPeriod'], 'settings.write');
        $router->patch('/admin/loan-periods/{id}', [self::class, 'updatePeriod'], 'settings.write');
        $router->delete('/admin/loan-periods/{id}', [self::class, 'deletePeriod'], 'settings.write');

        $router->get('/admin/settings', [self::class, 'settings'], 'settings.read');
        $router->patch('/admin/settings', [self::class, 'updateSettings'], 'settings.write');
        $router->post('/admin/settings/test-email', [self::class, 'testEmail'], 'settings.write');
        $router->get('/admin/settings/email-log', [self::class, 'emailLog'], 'settings.read');

        $router->get('/admin/updates', [self::class, 'updates'], 'settings.read');
        $router->post('/admin/updates/check', [self::class, 'checkUpdates'], 'settings.write');
        // Null capability: this one authorises itself. Updating replaces the
        // running code, so it checks role and re-confirms the password rather
        // than accepting a capability any session already carries.
        $router->post('/admin/updates/apply', [self::class, 'applyUpdate']);

        $router->get('/admin/api-keys', [self::class, 'apiKeys'], 'apikeys.read');
        $router->post('/admin/api-keys', [self::class, 'createApiKey'], 'apikeys.write');
        $router->delete('/admin/api-keys/{id}', [self::class, 'revokeApiKey'], 'apikeys.write');
    }

    // -----------------------------------------------------------------------
    // Organisation
    // -----------------------------------------------------------------------

    public static function organization(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $org            = Settings::organization($organizationId);

        if ($org === null) {
            throw Util::notFound('That organisation does not exist.');
        }

        Response::json([
            'organization' => $org,
            'symbologies'  => array_map(static fn (string $s): array => [
                'value' => $s,
                'label' => match ($s) {
                    'qr'      => 'QR code — scans from a phone camera as well as a laser scanner',
                    'code128' => 'Code 128 — dense linear barcode, needs a laser or imager',
                    'code39'  => 'Code 39 — widest support on older scanners',
                    default   => $s,
                },
            ], Barcode::SYMBOLOGIES),
            'timezone_current' => date_default_timezone_get(),
        ]);
    }

    public static function updateOrganization(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $body           = $request->body();
        $before         = Settings::organization($organizationId);

        $sets   = [];
        $params = [];

        if (array_key_exists('name', $body)) {
            $sets[]   = 'name = ?';
            $params[] = Util::requiredStr($body['name'], 'name', 190);
        }
        if (array_key_exists('contact_email', $body) || array_key_exists('contactEmail', $body)) {
            $sets[]   = 'contact_email = ?';
            $params[] = Util::email($body['contact_email'] ?? $body['contactEmail'] ?? null, 'contact_email');
        }
        if (array_key_exists('timezone', $body)) {
            $timezone = Util::requiredStr($body['timezone'], 'timezone', 64);

            if (!in_array($timezone, \DateTimeZone::listIdentifiers(), true)) {
                throw Util::badRequest(
                    "\"{$timezone}\" is not a recognised time zone. Use a name like "
                    . '"America/Chicago" or "Europe/London".',
                    ['field' => 'timezone'],
                );
            }

            $sets[]   = 'timezone = ?';
            $params[] = $timezone;
        }

        $notice = null;

        foreach ([['barcode_symbology', 'barcodeSymbology'], ['barcode_prefix', 'barcodePrefix']] as [$snake, $camel]) {
            $key = array_key_exists($snake, $body) ? $snake : (array_key_exists($camel, $body) ? $camel : null);
            if ($key === null) {
                continue;
            }

            if ($snake === 'barcode_symbology') {
                $sets[]   = 'barcode_symbology = ?';
                $params[] = Util::oneOf($body[$key], Barcode::SYMBOLOGIES, 'barcode_symbology', true);
                $notice   = 'Changing the symbology does not change any existing barcode value, but labels '
                          . 'already printed are in the old symbology. They keep scanning — reprint only if '
                          . 'you want them to match.';
            } else {
                $prefix = strtoupper(Util::requiredStr($body[$key], 'barcode_prefix', 16));

                if (!preg_match('/^[A-Z0-9]{1,16}$/', $prefix)) {
                    throw Util::badRequest(
                        'A barcode prefix may contain only letters and numbers, up to 16 characters.',
                        ['field' => 'barcode_prefix'],
                    );
                }

                $sets[]   = 'barcode_prefix = ?';
                $params[] = $prefix;

                if ($prefix !== ($before['barcode_prefix'] ?? '')) {
                    $notice = 'New devices will get barcodes with the new prefix. Existing barcodes are '
                            . 'unchanged, so printed labels stay valid.';
                }
            }
        }

        if ($sets === []) {
            Response::json(['organization' => $before]);
        }

        $sets[]   = 'updated_at = NOW()';
        $params[] = $organizationId;

        Db::execute('UPDATE organizations SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);

        $after = Settings::organization($organizationId);

        Audit::record(Audit::actor($request), [
            'action'      => Audit::SETTINGS_UPDATED,
            'entityType'  => 'organization',
            'entityId'    => $organizationId,
            'entityLabel' => $after['name'],
            'summary'     => 'Organisation details updated',
            'detail'      => Audit::diff($before, $after,
                ['name', 'contact_email', 'timezone', 'barcode_symbology', 'barcode_prefix']),
        ]);

        Response::json(['organization' => $after, 'notice' => $notice]);
    }

    // -----------------------------------------------------------------------
    // Loan periods
    // -----------------------------------------------------------------------

    public static function periods(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];

        $rows = Settings::loanPeriods($organizationId, true);

        foreach ($rows as &$row) {
            $row['loan_count'] = (int) Db::value(
                'SELECT COUNT(*) FROM loans WHERE loan_period_id = ?',
                [$row['id']],
            );
            $row['active_loan_count'] = (int) Db::value(
                'SELECT COUNT(*) FROM loans WHERE loan_period_id = ? AND status = "active"',
                [$row['id']],
            );
        }

        Response::json(Util::collection($rows));
    }

    public static function createPeriod(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $body           = $request->body();

        $name = Util::requiredStr($body['name'] ?? null, 'name', 120);
        $days = Util::int($body['days'] ?? null, 'days', 0, 3650);

        if ($days === null) {
            throw Util::badRequest(
                'Say how many days this period lasts. Use 0 for an open-ended loan with no return date.',
                ['field' => 'days'],
            );
        }

        $isDefault = Util::bool($body['is_default'] ?? $body['isDefault'] ?? false);

        $id = Db::transaction(static function () use ($organizationId, $body, $name, $days, $isDefault): int {
            if ($isDefault) {
                Db::execute('UPDATE loan_periods SET is_default = 0 WHERE organization_id = ?', [$organizationId]);
            }

            try {
                return Db::insert(
                    'INSERT INTO loan_periods
                       (organization_id, name, days, is_default, max_extensions, extension_days,
                        active, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        $organizationId, $name, $days, $isDefault ? 1 : 0,
                        Util::int($body['max_extensions'] ?? $body['maxExtensions'] ?? 2,
                            'max_extensions', 0, 50) ?? 2,
                        Util::int($body['extension_days'] ?? $body['extensionDays'] ?? 14,
                            'extension_days', 1, 3650) ?? 14,
                        Util::bool($body['active'] ?? true, true) ? 1 : 0,
                        Util::int($body['sort_order'] ?? $body['sortOrder'] ?? 0, 'sort_order', 0, 9999) ?? 0,
                    ],
                );
            } catch (\Throwable $e) {
                if (Db::isDuplicate($e)) {
                    throw Util::conflict("A loan period called \"{$name}\" already exists.", ['field' => 'name']);
                }
                throw $e;
            }
        });

        Audit::record(Audit::actor($request), [
            'action'      => Audit::PERIOD_CREATED,
            'entityType'  => 'loan_period',
            'entityId'    => $id,
            'entityLabel' => $name,
            'summary'     => $days === 0
                ? "Loan period \"{$name}\" added with no return date"
                : "Loan period \"{$name}\" added at {$days} days",
        ]);

        Response::json([
            'loan_period' => Db::one('SELECT * FROM loan_periods WHERE id = ?', [$id]),
        ], 201);
    }

    public static function updatePeriod(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $periodId       = (int) $request->param('id');
        $body           = $request->body();

        $before = Db::one(
            'SELECT * FROM loan_periods WHERE id = ? AND organization_id = ?',
            [$periodId, $organizationId],
        );
        if ($before === null) {
            throw Util::notFound('That loan period does not exist.');
        }

        $sets   = [];
        $params = [];

        if (array_key_exists('name', $body)) {
            $sets[]   = 'name = ?';
            $params[] = Util::requiredStr($body['name'], 'name', 120);
        }
        if (array_key_exists('days', $body)) {
            $sets[]   = 'days = ?';
            $params[] = Util::int($body['days'], 'days', 0, 3650) ?? 0;
        }
        foreach ([
            ['max_extensions', 'maxExtensions', 0, 50],
            ['extension_days', 'extensionDays', 1, 3650],
            ['sort_order', 'sortOrder', 0, 9999],
        ] as [$snake, $camel, $min, $max]) {
            foreach ([$snake, $camel] as $key) {
                if (array_key_exists($key, $body)) {
                    $sets[]   = "{$snake} = ?";
                    $params[] = Util::int($body[$key], $snake, $min, $max);
                    break;
                }
            }
        }
        if (array_key_exists('active', $body)) {
            $sets[]   = 'active = ?';
            $params[] = Util::bool($body['active']) ? 1 : 0;
        }

        $makeDefault = Util::bool($body['is_default'] ?? $body['isDefault'] ?? false);

        if ($sets === [] && !$makeDefault) {
            Response::json(['loan_period' => $before]);
        }

        Db::transaction(static function () use ($organizationId, $periodId, $sets, $params, $makeDefault): void {
            if ($makeDefault) {
                Db::execute('UPDATE loan_periods SET is_default = 0 WHERE organization_id = ?', [$organizationId]);
                Db::execute('UPDATE loan_periods SET is_default = 1 WHERE id = ?', [$periodId]);
            }

            if ($sets !== []) {
                $args   = $params;
                $args[] = $periodId;
                $args[] = $organizationId;

                try {
                    Db::execute(
                        'UPDATE loan_periods SET ' . implode(', ', $sets)
                        . ' WHERE id = ? AND organization_id = ?',
                        $args,
                    );
                } catch (\Throwable $e) {
                    if (Db::isDuplicate($e)) {
                        throw Util::conflict('Another loan period already has that name.', ['field' => 'name']);
                    }
                    throw $e;
                }
            }
        });

        $after = Db::one('SELECT * FROM loan_periods WHERE id = ?', [$periodId]);

        Audit::record(Audit::actor($request), [
            'action'      => Audit::PERIOD_UPDATED,
            'entityType'  => 'loan_period',
            'entityId'    => $periodId,
            'entityLabel' => $after['name'],
            'summary'     => "Loan period \"{$after['name']}\" updated",
            'detail'      => Audit::diff($before, $after,
                ['name', 'days', 'is_default', 'max_extensions', 'extension_days', 'active']),
        ]);

        Response::json([
            'loan_period' => $after,
            // Existing loans keep the due date they were given; changing the
            // period does not move anybody's return date.
            'notice' => ($before['days'] !== $after['days'])
                ? 'Loans already out keep their existing return dates. The new length applies from the '
                . 'next check-out.'
                : null,
        ]);
    }

    public static function deletePeriod(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $periodId       = (int) $request->param('id');

        $period = Db::one(
            'SELECT * FROM loan_periods WHERE id = ? AND organization_id = ?',
            [$periodId, $organizationId],
        );
        if ($period === null) {
            throw Util::notFound('That loan period does not exist.');
        }

        $used = (int) Db::value('SELECT COUNT(*) FROM loans WHERE loan_period_id = ?', [$periodId]);

        // Deleting would set loan_period_id to NULL on historical loans, which
        // is how "what was the agreed loan length?" becomes unanswerable.
        if ($used > 0) {
            throw Util::conflict(
                sprintf(
                    '"%s" has been used on %d loan%s. Deactivate it instead — it then disappears from the '
                    . 'check-out form but those loans keep their record of it.',
                    $period['name'], $used, $used === 1 ? '' : 's',
                ),
                ['loan_count' => $used, 'suggestion' => 'deactivate'],
            );
        }

        $remaining = (int) Db::value(
            'SELECT COUNT(*) FROM loan_periods WHERE organization_id = ? AND active = 1 AND id <> ?',
            [$organizationId, $periodId],
        );
        if ($remaining === 0) {
            throw Util::conflict(
                'This is the only loan period left. Add another before removing this one, or check-out '
                . 'will have no length to offer.',
            );
        }

        Db::execute('DELETE FROM loan_periods WHERE id = ? AND organization_id = ?', [$periodId, $organizationId]);

        Audit::record(Audit::actor($request), [
            'action'      => Audit::PERIOD_DELETED,
            'entityType'  => 'loan_period',
            'entityId'    => $periodId,
            'entityLabel' => $period['name'],
            'summary'     => "Loan period \"{$period['name']}\" deleted",
        ]);

        Response::json([
            'deleted'     => true,
            'loan_period' => $period,
            'message'     => "Loan period \"{$period['name']}\" removed.",
        ]);
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    public static function settings(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];

        Response::json([
            'settings'    => Settings::forClient($organizationId),
            'groups'      => Settings::GROUPS,
            'mail_status' => self::mailStatus($organizationId),
            'definitions' => array_map(static fn (array $d): array => [
                'type'    => $d[0],
                'default' => $d[1],
                'group'   => $d[2],
                'secret'  => $d[3] ?? false,
            ], Settings::DEFINITIONS),
            // Holds the cron token. Somebody who can read the settings but not
            // change them has no use for it.
            'cron' => in_array('settings.write', $request->auth['capabilities'] ?? [], true)
                ? Jobs::cronCommand($request->baseUrl())
                : null,
        ]);
    }

    /**
     * Mail is sent through Microsoft Graph and nothing else.
     *
     * There is deliberately no SMTP fallback: a half-configured SMTP server
     * that accepts a message and silently drops it is worse than a transport
     * that plainly reports it is not set up.
     */
    private static function mailStatus(int $organizationId): array
    {
        $config = Mailer::config($organizationId);

        return [
            'transport'  => 'microsoft_graph',
            'enabled'    => $config['enabled'],
            'configured' => $config['missing'] === [],
            'usable'     => $config['usable'],
            'missing'    => $config['missing'],
            'reason'     => $config['reason'],
            'sender'     => $config['sender'],
            'permission' => 'Mail.Send (application permission, admin-consented)',
            'recent'     => Mailer::recent($organizationId, 5),
        ];
    }

    public static function updateSettings(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $updates        = $request->input('settings');

        if (!is_array($updates) || $updates === []) {
            throw Util::badRequest('No settings were supplied.', ['field' => 'settings'])
                ;
        }

        $result = Settings::update($organizationId, $updates);

        if ($result['unknown'] !== []) {
            throw Util::badRequest(
                'These settings are not recognised: ' . implode(', ', $result['unknown'])
                . '. Nothing was saved from this request beyond the ones that are.',
                ['unknown' => $result['unknown']],
            );
        }

        if ($result['changed'] !== []) {
            Audit::record(Audit::actor($request), [
                'action'     => Audit::SETTINGS_UPDATED,
                'entityType' => 'settings',
                'summary'    => 'Settings changed: ' . implode(', ', $result['changed']),
                // Values are deliberately not logged: half of them are secrets.
                'detail'     => ['keys' => $result['changed']],
            ]);
        }

        Response::json([
            'settings' => Settings::forClient($organizationId),
            'changed'  => $result['changed'],
            // Recomputed after the write, not before: the client re-renders
            // "is email working?" from this the moment a save returns, and
            // telling it the pre-save state would show the administrator the
            // answer to the question they just stopped asking.
            'mail_status' => self::mailStatus($organizationId),
        ]);
    }

    /**
     * Send a test message.
     *
     * Reports the actual Graph or Entra error rather than "failed to send" —
     * the whole point of a test button is to find out which of a dozen things
     * is wrong.
     */
    public static function testEmail(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $recipient      = Util::email($request->input('recipient'), 'recipient', true);

        $config = Mailer::config($organizationId);

        $result = Mailer::send(Audit::actor($request), $organizationId, [
            'to'        => [$recipient],
            'subject'   => 'Test message from your loaner pool',
            'html'      => Mailer::layout(
                'Email is working',
                '<p>This is a test message from your assistive technology loaner pool.</p>'
                . '<p>If you are reading it, Microsoft Graph is configured correctly and loan '
                . 'notifications will reach people.</p>',
            ),
            'eventType' => 'test',
            // The point of a test button is to find out whether the credentials
            // work, so it runs even while notifications are switched off. The
            // response says so rather than leaving a false impression.
            'bypassEnabledCheck' => true,
        ]);

        $message = $result['sent']
            ? "A test message has been sent to {$recipient}. If it does not arrive within a few minutes, "
            . 'check the junk folder and the sending mailbox’s own rules.'
            : 'The message was not sent. ' . ($result['reason'] ?? '');

        if ($result['sent'] && !$config['enabled']) {
            $message .= ' Note that email notifications are still switched off, so loan emails will not '
                      . 'go out until you turn them on.';
        }

        Response::json([
            'sent'               => $result['sent'],
            'reason'             => $result['reason'] ?? null,
            // Echoed back so the confirmation can say which mailbox it came
            // from and where it went. "A test was sent" is not much use when
            // the thing being tested is which mailbox is configured.
            'sender'             => $config['sender'],
            'recipient'          => $recipient,
            'notifications_live' => $config['enabled'],
            'mail_status'        => self::mailStatus($organizationId),
            'message'            => $message,
        ], $result['sent'] ? 200 : 502);
    }

    public static function emailLog(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];

        Response::json(Util::collection(
            Mailer::recent($organizationId, (int) ($request->queryParam('limit') ?? 50)),
        ));
    }

    // -----------------------------------------------------------------------
    // Updates
    //
    // Checking only. Applying an update is command-line work — see
    // bin/update.php and the note at the top of app/Updates.php.
    // -----------------------------------------------------------------------

    public static function updates(Request $request): never
    {
        Response::json(Updates::check(false));
    }

    /**
     * Install an update from the browser.
     *
     * Gated inside Updates::applyFromWeb(): administrator role, password
     * re-entered, one at a time, backup taken, audit entry written. The site
     * returns 503 for the few seconds the files are actually being swapped.
     */
    public static function applyUpdate(Request $request): never
    {
        $auth = Auth::requireAuth($request);

        $result = Updates::applyFromWeb($auth, $request->input('password'));

        Response::json($result + [
            'message' => $result['changed']
                ? sprintf('Updated from %s to %s. Reload the page to pick up the new interface.',
                    $result['from'], $result['to'])
                : 'Already on the latest version; nothing was changed.',
        ]);
    }

    public static function checkUpdates(Request $request): never
    {
        // Forced, so the button means what it says. Cached results are what
        // the page load uses; pressing "check now" and being told a stale
        // answer would be worse than the wait.
        Response::json(Updates::check(true));
    }

    // -----------------------------------------------------------------------
    // API keys
    // -----------------------------------------------------------------------

    public static function apiKeys(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];

        $rows = Db::all(
            'SELECT k.id, k.name, k.key_prefix, k.scopes, k.last_used_at, k.expires_at,
                    k.revoked_at, k.created_at, u.full_name AS created_by_name
               FROM api_keys k
               LEFT JOIN users u ON u.id = k.created_by
              WHERE k.organization_id = ?
              ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC',
            [$organizationId],
        );

        foreach ($rows as &$row) {
            $row['scopes']  = explode(',', (string) $row['scopes']);
            $row['status']  = match (true) {
                $row['revoked_at'] !== null => 'revoked',
                $row['expires_at'] !== null && strtotime((string) $row['expires_at']) < time() => 'expired',
                default => 'active',
            };
            // The full key exists nowhere after creation — only its hash is
            // stored, so a leaked database cannot be used to call the API.
            $row['masked'] = 'lp_' . $row['key_prefix'] . '_' . str_repeat('•', 12);
        }

        Response::json(Util::collection($rows) + [
            'scopes' => [
                ['value' => 'read',  'label' => 'Read only — list devices, loans and requests'],
                ['value' => 'write', 'label' => 'Read and write — check devices in and out'],
                ['value' => 'admin', 'label' => 'Full access — including settings and accounts'],
            ],
        ]);
    }

    public static function createApiKey(Request $request): never
    {
        Auth::requireRole($request, 'admin');

        $organizationId = (int) $request->auth['organizationId'];
        $body           = $request->body();

        $name   = Util::requiredStr($body['name'] ?? null, 'name', 190);
        $scopes = $body['scopes'] ?? ['read'];

        if (!is_array($scopes) || $scopes === []) {
            throw Util::badRequest('Choose at least one scope for this key.', ['field' => 'scopes']);
        }

        foreach ($scopes as $scope) {
            if (!in_array($scope, Auth::API_SCOPES, true)) {
                throw Util::badRequest(
                    "\"{$scope}\" is not a scope.",
                    ['field' => 'scopes', 'allowed' => Auth::API_SCOPES],
                );
            }
        }

        $expiresAt = null;
        $days      = Util::int($body['expires_in_days'] ?? $body['expiresInDays'] ?? null,
            'expires_in_days', 1, 3650);
        if ($days !== null) {
            $expiresAt = Util::mysqlDateTime(new \DateTimeImmutable("+{$days} days"));
        }

        $key = Auth::generateApiKey();

        $id = Db::insert(
            'INSERT INTO api_keys
               (organization_id, name, key_prefix, key_hash, scopes, created_by, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                $organizationId, $name, $key['prefix'], $key['hash'],
                implode(',', $scopes), $request->auth['userId'] ?? null, $expiresAt,
            ],
        );

        Audit::record(Audit::actor($request), [
            'action'      => Audit::APIKEY_CREATED,
            'entityType'  => 'api_key',
            'entityId'    => $id,
            'entityLabel' => $name,
            'summary'     => "API key \"{$name}\" created with scopes: " . implode(', ', $scopes),
        ]);

        Response::json([
            'key' => $key['plaintext'],
            'api_key' => Db::one(
                'SELECT id, name, key_prefix, scopes, expires_at, created_at FROM api_keys WHERE id = ?',
                [$id],
            ),
            'warning' => 'Copy this key now. Only a hash of it is stored, so it cannot be shown again — '
                       . 'if it is lost, revoke it and create another.',
        ], 201);
    }

    public static function revokeApiKey(Request $request): never
    {
        Auth::requireRole($request, 'admin');

        $organizationId = (int) $request->auth['organizationId'];
        $keyId          = (int) $request->param('id');

        $key = Db::one(
            'SELECT * FROM api_keys WHERE id = ? AND organization_id = ?',
            [$keyId, $organizationId],
        );
        if ($key === null) {
            throw Util::notFound('That API key does not exist.');
        }

        if ($key['revoked_at'] !== null) {
            Response::json(['revoked' => true, 'already' => true]);
        }

        // Revoked rather than deleted: the audit log references it, and
        // "which key did that?" is worth being able to answer afterwards.
        Db::execute('UPDATE api_keys SET revoked_at = NOW() WHERE id = ?', [$keyId]);

        Audit::record(Audit::actor($request), [
            'action'      => Audit::APIKEY_REVOKED,
            'entityType'  => 'api_key',
            'entityId'    => $keyId,
            'entityLabel' => $key['name'],
            'summary'     => "API key \"{$key['name']}\" revoked",
        ]);

        Response::json([
            'revoked' => true,
            'notice'  => 'Any application using that key will start getting 401 responses immediately.',
        ]);
    }
}
