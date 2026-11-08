<?php
/**
 * Text messages, through Twilio.
 *
 * Separate from Mailer for the same reason Notifications is separate from
 * Mailer: this knows how to talk to a carrier, not what to say.
 *
 * Texts are short, cost money per message, and arrive on a phone a client may
 * be holding in a waiting room. So only three events send one — the ones where
 * acting late has a real cost — and nothing here ever throws: a loan must not
 * fail because a carrier is down.
 *
 * Consent is explicit. Having someone's mobile number is not permission to
 * text them, so sms_opt_in is a separate field and a blank one means no.
 */

declare(strict_types=1);

namespace Loaner;

final class Sms
{
    private const API_HOST = 'https://api.twilio.com/2010-04-01';

    /** Events that may send a text, each with its own switch in settings. */
    public const EVENTS = ['ready_for_pickup', 'due_soon', 'overdue'];

    /** Twilio charges per segment; 160 characters is one. */
    private const MAX_LENGTH = 300;

    public static function config(int $organizationId): array
    {
        $settings = Settings::all($organizationId);

        $config = [
            'enabled'    => (bool) $settings['sms.enabled'],
            'accountSid' => (string) $settings['sms.account_sid'],
            'authToken'  => (string) ($settings['sms.auth_token'] ?? ''),
            'from'       => (string) $settings['sms.from_number'],
        ];

        $missing = [];
        if ($config['accountSid'] === '') { $missing[] = 'Account SID'; }
        if ($config['authToken'] === '')  { $missing[] = 'Auth token'; }
        if ($config['from'] === '')       { $missing[] = 'Sending number'; }

        $config['missing'] = $missing;
        $config['usable']  = $config['enabled'] && $missing === [];
        $config['reason']  = match (true) {
            !$config['enabled'] => 'Text messages are switched off in settings.',
            $missing !== []     => 'Twilio is not fully configured. Missing: ' . implode(', ', $missing) . '.',
            default             => null,
        };

        return $config;
    }

    /**
     * Send one message.
     *
     * @return array{sent: bool, reason: ?string}
     */
    public static function send(?array $actor, int $organizationId, array $message): array
    {
        $eventType = (string) ($message['eventType'] ?? 'manual');
        $to        = self::normaliseNumber($message['to'] ?? null);
        $body      = trim((string) ($message['body'] ?? ''));

        try {
            if ($to === null) {
                return self::log($organizationId, $eventType, '(none)', $body, 'skipped',
                                 'No usable mobile number.', $message);
            }

            if ($body === '') {
                return self::log($organizationId, $eventType, $to, $body, 'skipped',
                                 'Nothing to say.', $message);
            }

            if (mb_strlen($body) > self::MAX_LENGTH) {
                $body = mb_substr($body, 0, self::MAX_LENGTH - 1) . '…';
            }

            $config = self::config($organizationId);

            if (!$config['usable'] && empty($message['bypassEnabledCheck'])) {
                return self::log($organizationId, $eventType, $to, $body, 'skipped',
                                 $config['reason'], $message);
            }

            if ($config['missing'] !== []) {
                return self::log($organizationId, $eventType, $to, $body, 'skipped',
                                 $config['reason'] ?? 'Not configured.', $message);
            }

            [$status, $response] = self::post(
                self::API_HOST . '/Accounts/' . rawurlencode($config['accountSid']) . '/Messages.json',
                http_build_query(['To' => $to, 'From' => $config['from'], 'Body' => $body]),
                $config['accountSid'] . ':' . $config['authToken'],
            );

            $decoded = json_decode($response, true);

            if ($status >= 200 && $status < 300) {
                return self::log($organizationId, $eventType, $to, $body, 'sent', null,
                                 $message, $decoded['sid'] ?? null);
            }

            return self::log(
                $organizationId, $eventType, $to, $body, 'failed',
                self::describeError($status, is_array($decoded) ? $decoded : []),
                $message,
            );
        } catch (\Throwable $e) {
            // Never fatal. A text that did not send must not undo a check-out.
            error_log('[sms] ' . $e->getMessage());

            try {
                return self::log($organizationId, $eventType, $to ?? '(none)', $body, 'failed',
                                 $e->getMessage(), $message);
            } catch (\Throwable) {
                return ['sent' => false, 'reason' => $e->getMessage()];
            }
        }
    }

    /**
     * Turn Twilio's error codes into something an administrator can act on.
     *
     * The raw message is often about the API; the useful version is about
     * their account or the number they typed.
     */
    private static function describeError(int $status, array $body): string
    {
        $code    = (int) ($body['code'] ?? 0);
        $message = (string) ($body['message'] ?? '');

        return match (true) {
            $status === 401 => 'Twilio rejected the credentials. Check the Account SID and auth token.',
            $code === 21211 => 'That mobile number is not valid. Include the country code, e.g. +1.',
            $code === 21608 => 'This Twilio account is still a trial, which can only text verified '
                             . 'numbers. Upgrade the account, or verify the number in Twilio first.',
            $code === 21610 => 'That person has replied STOP to a previous message, so the carrier '
                             . 'will not deliver to them. They have to text START to opt back in.',
            $code === 21614 => 'That number cannot receive text messages — it is probably a landline.',
            $code === 20003 => 'Twilio refused the request: the account may be suspended or out of credit.',
            $message !== '' => "Twilio rejected the message: {$message}",
            default         => "Twilio rejected the message (HTTP {$status}).",
        };
    }

    /**
     * Normalise to E.164 as best we can.
     *
     * A ten-digit number is assumed to be North American, because this is a
     * US vocational rehabilitation tool and that is what will be typed. A
     * number that already starts with + is left exactly alone.
     */
    public static function normaliseNumber(mixed $raw): ?string
    {
        $value = trim((string) ($raw ?? ''));

        if ($value === '') {
            return null;
        }

        if (str_starts_with($value, '+')) {
            $digits = preg_replace('/[^0-9]/', '', substr($value, 1)) ?? '';
            return $digits === '' ? null : '+' . $digits;
        }

        $digits = preg_replace('/[^0-9]/', '', $value) ?? '';

        return match (true) {
            strlen($digits) === 10                              => '+1' . $digits,
            strlen($digits) === 11 && str_starts_with($digits, '1') => '+' . $digits,
            // Anything else is ambiguous, and guessing a country code is how a
            // message goes to a stranger. Refused rather than mangled.
            default => null,
        };
    }

    /** @return array{0:int, 1:string} */
    private static function post(string $url, string $body, string $basicAuth): array
    {
        if (!function_exists('curl_init')) {
            throw new \RuntimeException('The curl extension is not available on this server.');
        }

        $ch = curl_init($url);

        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_USERPWD        => $basicAuth,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
        ]);

        $response = curl_exec($ch);
        $status   = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error    = curl_error($ch);

        if ($response === false) {
            throw new \RuntimeException(
                "Could not reach Twilio: {$error}. Check that this server has outbound HTTPS access.",
            );
        }

        return [$status, (string) $response];
    }

    /** @return array{sent: bool, reason: ?string} */
    private static function log(
        int $organizationId,
        string $eventType,
        string $recipient,
        string $body,
        string $status,
        ?string $error,
        array $message,
        ?string $providerRef = null,
    ): array {
        try {
            Db::execute(
                'INSERT INTO sms_log
                   (organization_id, event_type, recipient, body, loan_id, status,
                    error_message, provider_ref, sent_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    $organizationId, $eventType, $recipient, mb_substr($body, 0, 500),
                    $message['loanId'] ?? null, $status, $error, $providerRef,
                    $status === 'sent' ? Util::mysqlDateTime('now') : null,
                ],
            );
        } catch (\Throwable $e) {
            error_log('[sms] could not record the message: ' . $e->getMessage());
        }

        return ['sent' => $status === 'sent', 'reason' => $error];
    }

    /**
     * Text a client about a loan, if they have agreed to be texted.
     *
     * Every caller goes through here rather than calling send() directly, so
     * the consent check exists in exactly one place.
     */
    public static function notifyClient(
        ?array $actor,
        int $organizationId,
        string $event,
        array $loan,
        string $body,
    ): array {
        if (!in_array($event, self::EVENTS, true)) {
            return ['sent' => false, 'reason' => "\"{$event}\" does not send a text."];
        }

        if (!Settings::get($organizationId, "sms.on_{$event}")) {
            return ['sent' => false, 'reason' => "Texts for \"{$event}\" are switched off."];
        }

        if (empty($loan['client_sms_opt_in'])) {
            // Not a failure. Most clients will not have opted in, and that is
            // their choice rather than a problem to report.
            return ['sent' => false, 'reason' => 'This client has not agreed to be texted.'];
        }

        return self::send($actor, $organizationId, [
            'to'        => $loan['client_mobile'] ?? null,
            'body'      => $body,
            'eventType' => $event,
            'loanId'    => $loan['id'] ?? null,
        ]);
    }

    /** @return array<int, array<string, mixed>> */
    public static function recent(int $organizationId, int $limit = 25): array
    {
        return Db::all(
            'SELECT id, event_type, recipient, body, status, error_message, sent_at, created_at
               FROM sms_log WHERE organization_id = ?
              ORDER BY created_at DESC LIMIT ' . max(1, min(200, $limit)),
            [$organizationId],
        );
    }
}
