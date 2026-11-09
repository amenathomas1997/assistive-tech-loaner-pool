<?php
/**
 * Outbound email via Microsoft Graph.
 *
 * Client-credentials flow: an Azure app registration with the *application*
 * permission Mail.Send, admin-consented, sending as a specific mailbox. There
 * is no user sign-in, so notifications keep working overnight and unattended.
 *
 * Configuration is entered by an administrator in the settings screen; nothing
 * here reads environment variables, so a fresh install needs no shell access.
 *
 * Every send is journalled to email_log — including failures and skips — so
 * "did the client get told?" has an answer that does not depend on the
 * recipient's word.
 */

declare(strict_types=1);

namespace Loaner;

final class Mailer
{
    private const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
    private const TOKEN_HOST  = 'https://login.microsoftonline.com';
    private const GRAPH_HOST  = 'https://graph.microsoft.com/v1.0';

    /**
     * Access tokens live about an hour. Cached per organisation for the life
     * of the request, and refreshed five minutes early — a burst of overdue
     * notices in one cron run should not mean a token request per email.
     */
    private static array $tokenCache = [];

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    /** Read Graph configuration, reporting *why* it is unusable, not just that. */
    public static function config(int $organizationId): array
    {
        $settings = Settings::all($organizationId);

        $config = [
            'enabled'      => (bool) $settings['graph.enabled'],
            'tenantId'     => (string) $settings['graph.tenant_id'],
            'clientId'     => (string) $settings['graph.client_id'],
            'clientSecret' => (string) ($settings['graph.client_secret'] ?? ''),
            'sender'       => (string) $settings['graph.sender'],
            'replyTo'      => (string) $settings['graph.reply_to'],
        ];

        $missing = [];
        if ($config['tenantId'] === '')     { $missing[] = 'Directory (tenant) ID'; }
        if ($config['clientId'] === '')     { $missing[] = 'Application (client) ID'; }
        if ($config['clientSecret'] === '') { $missing[] = 'Client secret'; }
        if ($config['sender'] === '')       { $missing[] = 'Sender mailbox'; }

        $config['missing'] = $missing;
        $config['usable']  = $config['enabled'] && $missing === [];
        $config['reason']  = match (true) {
            !$config['enabled'] => 'Email notifications are switched off in settings.',
            $missing !== []     => 'Graph is not fully configured. Missing: ' . implode(', ', $missing) . '.',
            default             => null,
        };

        return $config;
    }

    // -----------------------------------------------------------------------
    // Token
    // -----------------------------------------------------------------------

    private static function accessToken(int $organizationId, array $config): string
    {
        $key = $organizationId . ':' . $config['clientId'];

        if (isset(self::$tokenCache[$key]) && self::$tokenCache[$key]['expiresAt'] > time() + 300) {
            return self::$tokenCache[$key]['token'];
        }

        [$status, $body] = self::httpPost(
            self::TOKEN_HOST . '/' . rawurlencode($config['tenantId']) . '/oauth2/v2.0/token',
            http_build_query([
                'client_id'     => $config['clientId'],
                'client_secret' => $config['clientSecret'],
                'scope'         => self::GRAPH_SCOPE,
                'grant_type'    => 'client_credentials',
            ]),
            ['Content-Type: application/x-www-form-urlencoded'],
        );

        $payload = json_decode($body ?: '{}', true) ?: [];

        if ($status !== 200 || empty($payload['access_token'])) {
            throw new HttpError(400, 'graph_auth_failed', self::describeAzureError($payload, $status));
        }

        self::$tokenCache[$key] = [
            'token'     => $payload['access_token'],
            'expiresAt' => time() + (int) ($payload['expires_in'] ?? 3600),
        ];

        return $payload['access_token'];
    }

    /** Azure's own descriptions are genuinely useful; pass them through. */
    private static function describeAzureError(array $payload, int $status): string
    {
        $code        = (string) ($payload['error'] ?? '');
        $description = (string) ($payload['error_description'] ?? '');

        return match (true) {
            str_contains($description, 'AADSTS7000215')
                => 'The client secret is wrong or has expired. Generate a new secret in Azure and paste it in again.',
            str_contains($description, 'AADSTS700016') || $code === 'unauthorized_client'
                => 'That application (client) ID was not found in this tenant. Check both the tenant ID and the client ID.',
            str_contains($description, 'AADSTS90002')
                => 'That tenant ID does not exist. Use the Directory (tenant) ID from the app registration Overview page.',
            $code === 'invalid_scope' || str_contains($description, 'AADSTS70011')
                => 'The app registration is missing the Mail.Send application permission, or admin consent '
                 . 'has not been granted.',
            $description !== '' => $description,
            default => "Microsoft rejected the sign-in request (HTTP {$status}).",
        };
    }

    // -----------------------------------------------------------------------
    // Sending
    // -----------------------------------------------------------------------

    /**
     * Send one message.
     *
     * Returns ['sent' => bool, 'reason' => ?string] rather than throwing when
     * email is simply not configured — a loan check-out must not fail because
     * nobody has set up Graph yet. Genuine send failures are recorded and
     * returned the same way, for the same reason.
     */
    public static function send(?array $actor, int $organizationId, array $message): array
    {
        $recipients = array_values(array_filter(
            is_array($message['to']) ? $message['to'] : Settings::parseRecipients((string) $message['to']),
        ));

        $eventType = (string) ($message['eventType'] ?? 'manual');
        $subject   = (string) $message['subject'];

        if ($recipients === []) {
            self::log($organizationId, $eventType, '(none)', $subject, 'skipped',
                      'No recipient address available.', $message);
            return ['sent' => false, 'reason' => 'No recipient address available.'];
        }

        $config = self::config($organizationId);

        if (!$config['usable'] && empty($message['bypassEnabledCheck'])) {
            self::log($organizationId, $eventType, implode(', ', $recipients), $subject, 'skipped',
                      $config['reason'], $message);
            return ['sent' => false, 'reason' => $config['reason']];
        }

        if ($config['missing'] !== []) {
            $reason = $config['reason'] ?? 'Graph is not configured.';
            self::log($organizationId, $eventType, implode(', ', $recipients), $subject, 'skipped', $reason, $message);
            return ['sent' => false, 'reason' => $reason];
        }

        $payload = [
            'message' => [
                'subject'      => $subject,
                'body'         => ['contentType' => 'HTML', 'content' => $message['html']],
                'toRecipients' => array_map(
                    static fn (string $a): array => ['emailAddress' => ['address' => $a]],
                    $recipients,
                ),
            ],
            'saveToSentItems' => true,
        ];

        if ($config['replyTo'] !== '') {
            $payload['message']['replyTo'] = [['emailAddress' => ['address' => $config['replyTo']]]];
        }

        try {
            $token = self::accessToken($organizationId, $config);

            [$status, $body] = self::httpPost(
                self::GRAPH_HOST . '/users/' . rawurlencode($config['sender']) . '/sendMail',
                json_encode($payload, JSON_UNESCAPED_SLASHES),
                ['Authorization: Bearer ' . $token, 'Content-Type: application/json'],
            );

            if ($status === 202) {
                self::log($organizationId, $eventType, implode(', ', $recipients), $subject, 'sent', null, $message);

                Audit::record($actor, [
                    'organizationId' => $organizationId,
                    'action'         => Audit::EMAIL_SENT,
                    'entityType'     => 'email',
                    'entityLabel'    => $eventType,
                    'summary'        => "Sent \"{$subject}\" to " . implode(', ', $recipients),
                    'detail'         => ['event_type' => $eventType, 'recipients' => $recipients],
                ]);

                return ['sent' => true, 'reason' => null];
            }

            $reason = self::describeSendError(json_decode($body ?: '{}', true) ?: [], $status, $config['sender']);

            self::log($organizationId, $eventType, implode(', ', $recipients), $subject, 'failed', $reason, $message);

            Audit::record($actor, [
                'organizationId' => $organizationId,
                'action'         => Audit::EMAIL_FAILED,
                'entityType'     => 'email',
                'entityLabel'    => $eventType,
                'summary'        => "Failed to send \"{$subject}\": {$reason}",
            ]);

            return ['sent' => false, 'reason' => $reason];
        } catch (\Throwable $e) {
            $reason = $e instanceof HttpError ? $e->getMessage() : 'Unexpected error sending mail: ' . $e->getMessage();
            self::log($organizationId, $eventType, implode(', ', $recipients), $subject, 'failed', $reason, $message);
            return ['sent' => false, 'reason' => $reason];
        }
    }

    private static function describeSendError(array $body, int $status, string $sender): string
    {
        $code    = (string) ($body['error']['code'] ?? '');
        $message = (string) ($body['error']['message'] ?? '');

        return match (true) {
            $status === 404 || $code === 'ResourceNotFound'
                => "The sender mailbox \"{$sender}\" was not found in this tenant. It must be a real, licensed mailbox.",
            $status === 403 || $code === 'ErrorAccessDenied'
                => 'Access denied. The app registration needs the Mail.Send *application* permission with admin '
                 . 'consent granted (delegated permissions do not work for unattended sending).',
            $status === 429
                => 'Microsoft is rate limiting this mailbox. The message was not sent; try again shortly.',
            $message !== '' => $message,
            default => "Microsoft Graph rejected the message (HTTP {$status}).",
        };
    }

    /**
     * @return array{0:int, 1:string} status, body
     */
    private static function httpPost(string $url, string $body, array $headers): array
    {
        $ch = curl_init($url);

        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_CONNECTTIMEOUT => 15,
        ]);

        $response = curl_exec($ch);
        $status   = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error    = curl_error($ch);

        // No curl_close(): since PHP 8.0 the handle is freed when it goes out
        // of scope, and 8.5 deprecates the call outright.

        if ($response === false) {
            throw new HttpError(
                502,
                'graph_unreachable',
                "Could not reach Microsoft: {$error}. Check that this server has outbound HTTPS access.",
            );
        }

        return [$status, (string) $response];
    }

    private static function log(
        int $organizationId,
        string $eventType,
        string $recipient,
        string $subject,
        string $status,
        ?string $error,
        array $message,
    ): void {
        try {
            Db::execute(
                'INSERT INTO email_log
                   (organization_id, event_type, recipient, subject, body_preview, loan_id, request_id,
                    status, error_message, attempts, sent_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
                [
                    $organizationId,
                    $eventType,
                    mb_substr($recipient, 0, 500),
                    mb_substr($subject, 0, 255),
                    // A reset email's body is the reset link, and password_resets
                    // stores only a hash of it precisely so that the database
                    // cannot be used to take over an account.
                    empty($message['sensitive'])
                        ? mb_substr(trim(preg_replace('/\s+/', ' ', strip_tags((string) ($message['html'] ?? ''))) ?? ''), 0, 2000)
                        : '(not recorded: this message contains a sign-in link)',
                    $message['loanId'] ?? null,
                    $message['requestId'] ?? null,
                    $status,
                    $error,
                    $status === 'sent' ? date('Y-m-d H:i:s') : null,
                ],
            );
        } catch (\Throwable $e) {
            error_log('[mailer] could not write email_log entry: ' . $e->getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // Templates
    //
    // Inline styles only, and a table-free layout — Outlook strips <style>
    // blocks and most webmail ignores external CSS entirely.
    // -----------------------------------------------------------------------

    public static function layout(string $heading, string $bodyHtml): string
    {
        $heading = Util::escapeHtml($heading);

        return <<<HTML
            <!doctype html><html lang="en"><head><meta charset="utf-8"><title>{$heading}</title></head><body style="margin:0;padding:0;background:#f4f5f7;
              font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
              <div style="max-width:600px;margin:0 auto;padding:24px;">
                <div style="background:#fff;border-radius:8px;padding:24px;border:1px solid #e1e3e6;">
                  <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#125b7d;">{$heading}</h1>
                  {$bodyHtml}
                </div>
                <p style="font-size:14px;color:#3f4650;margin:16px 0 0;text-align:center;">
                  Sent automatically by Loaner Pool.
                </p>
              </div>
            </body></html>
            HTML;
    }

    public static function button(string $href, string $label): string
    {
        $href  = Util::escapeHtml($href);
        $label = Util::escapeHtml($label);

        return '<p style="margin:24px 0 0;"><a href="' . $href . '" '
             . 'style="display:inline-block;background:#125b7d;color:#fff;text-decoration:none;'
             . 'padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;">' . $label . '</a></p>';
    }

    /** The one template that lives here rather than in a domain class. */
    public static function sendPasswordReset(int $organizationId, array $user, string $link): array
    {
        $name   = Util::escapeHtml($user['full_name']);
        $safe   = Util::escapeHtml($link);
        $button = self::button($link, 'Choose a new password');

        $html = self::layout('Reset your password', <<<HTML
            <p>Hello {$name},</p>
            <p>Someone asked to reset the Loaner Pool password for this address.
               If it was you, use the link below. It stops working in one hour.</p>
            {$button}
            <p style="font-size:14px;color:#3f4650;">If the button does not work, copy this address into your browser:<br>
              <span style="word-break:break-all;">{$safe}</span></p>
            <p style="font-size:14px;color:#3f4650;">If you did not ask for this, you can ignore this message —
               your password has not changed.</p>
            HTML);

        return self::send(
            Audit::system($organizationId, 'Password reset'),
            $organizationId,
            [
                'to'        => [$user['email']],
                'subject'   => 'Reset your Loaner Pool password',
                'html'      => $html,
                'eventType' => 'password_reset',
                'sensitive' => true,
            ],
        );
    }

    /** Recent email activity, for the admin settings screen. */
    public static function recent(int $organizationId, int $limit = 25): array
    {
        return Db::all(
            'SELECT id, event_type, recipient, subject, status, error_message, sent_at, created_at
               FROM email_log WHERE organization_id = ?
              ORDER BY created_at DESC LIMIT ' . max(1, min(200, $limit)),
            [$organizationId],
        );
    }
}
