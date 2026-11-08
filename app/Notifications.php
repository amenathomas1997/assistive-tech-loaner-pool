<?php
/**
 * Notification templates and dispatch.
 *
 * Separate from Mailer: Mailer knows how to talk to Microsoft Graph,
 * this knows what to say and who should hear it.
 *
 * Nothing here ever throws. A loan check-out must not fail because a mail
 * server is unreachable — the transaction has already happened, and refusing
 * to report it would be worse than a missing email. Failures are recorded in
 * email_log and surface in the settings screen.
 */

declare(strict_types=1);

namespace Loaner;

final class Notifications
{
    /**
     * Send for an event, honouring the per-event toggle.
     *
     * @return array{sent: bool, reason: ?string}
     */
    public static function send(?array $actor, int $organizationId, string $event, array $payload): array
    {
        try {
            $toggle = "notify.{$event}";

            if (isset(Settings::DEFINITIONS[$toggle]) && !Settings::get($organizationId, $toggle)) {
                return ['sent' => false, 'reason' => "The \"{$event}\" notification is switched off."];
            }

            $built = match ($event) {
                'request_submitted' => self::requestSubmitted($payload),
                'request_approved'  => self::requestApproved($payload),
                'request_denied'    => self::requestDenied($payload),
                'ready_for_pickup'  => self::readyForPickup($payload),
                'checked_out'       => self::checkedOut($payload),
                'due_soon'          => self::dueSoon($payload),
                'overdue'           => self::overdue($payload),
                'checked_in'        => self::checkedIn($payload),
                'reservation_ready' => self::reservationReadyTemplate($payload),
                default             => null,
            };

            if ($built === null) {
                return ['sent' => false, 'reason' => "Unknown notification type \"{$event}\"."];
            }

            $mail = Mailer::send($actor, $organizationId, [
                'to'        => self::recipients($organizationId, $event, $payload),
                'subject'   => $built['subject'],
                'html'      => $built['html'],
                'eventType' => $event,
                'loanId'    => $payload['__loan_id'] ?? null,
                'requestId' => $payload['__request_id'] ?? null,
            ]);

            // A text as well, where the client has agreed to one and the event
            // is time-critical. Sent alongside the email rather than instead of
            // it: the email carries the detail, the text carries the prompt.
            $sms = Sms::notifyClient($actor, $organizationId, $event, $payload,
                                     self::textFor($event, $payload));

            return $mail + ['sms' => $sms];
        } catch (\Throwable $e) {
            error_log("[notifications] {$event} failed: " . $e->getMessage());
            return ['sent' => false, 'reason' => $e->getMessage()];
        }
    }

    public static function reservationReady(?array $actor, int $organizationId, array $reservation): array
    {
        return self::send($actor, $organizationId, 'reservation_ready', $reservation);
    }

    /**
     * Who hears about what.
     *
     * Client addresses are included only for events the client is party to — a
     * client has no business receiving the internal "new request needs review"
     * message, which names other staff.
     */
    private static function recipients(int $organizationId, string $event, array $payload): array
    {
        $admins = Settings::parseRecipients((string) Settings::get($organizationId, 'notify.admin_recipients'));
        $out    = [];

        $add = static function (?string $value) use (&$out): void {
            foreach (Settings::parseRecipients($value) as $address) {
                $out[$address] = true;
            }
        };

        switch ($event) {
            case 'request_submitted':
                foreach ($admins as $a) { $out[$a] = true; }
                $add($payload['assigned_tech_email'] ?? null);
                break;

            case 'request_approved':
            case 'request_denied':
            case 'ready_for_pickup':
                $add($payload['requester_email'] ?? null);
                break;

            case 'reservation_ready':
                $add($payload['requester_email'] ?? null);
                $add($payload['client_email'] ?? null);
                break;

            case 'checked_out':
            case 'due_soon':
            case 'overdue':
                $add($payload['client_email'] ?? null);
                $add($payload['tech_email'] ?? null);
                break;

            case 'checked_in':
                $add($payload['tech_email'] ?? null);
                break;

            default:
                foreach ($admins as $a) { $out[$a] = true; }
        }

        return array_keys($out);
    }

    // -----------------------------------------------------------------------
    // Templates
    // -----------------------------------------------------------------------

    /**
     * The text message version.
     *
     * Written to be read on a lock screen: what, when, and who it is from. No
     * link, because a link in an unexpected text is indistinguishable from a
     * phishing attempt and we would be teaching people to tap them.
     */
    private static function textFor(string $event, array $payload): string
    {
        $org    = Settings::organization((int) ($payload['organization_id'] ?? 0))['name'] ?? 'Your loaner pool';
        $device = $payload['device_name'] ?? 'Your equipment';
        $due    = self::date($payload['due_at'] ?? null);

        return match ($event) {
            'ready_for_pickup' => sprintf(
                '%s: %s is ready to collect. Contact your counselor to arrange it.',
                $org, $device,
            ),
            'due_soon' => $due === null
                ? sprintf('%s: please arrange to return %s.', $org, $device)
                : sprintf('%s: %s is due back on %s.', $org, $device, $due),
            'overdue' => $due === null
                ? sprintf('%s: %s is overdue. Please get in touch.', $org, $device)
                : sprintf(
                    '%s: %s was due back on %s. Please get in touch to arrange its return.',
                    $org, $device, $due,
                ),
            default => '',
        };
    }

    private static function details(array $pairs): string
    {
        $rows = '';

        foreach ($pairs as $label => $value) {
            if ($value === null || $value === '') {
                continue;
            }
            $rows .= '<tr>'
                . '<td style="padding:6px 12px 6px 0;color:#6b7280;font-size:14px;vertical-align:top;'
                . 'white-space:nowrap;">' . Util::escapeHtml($label) . '</td>'
                . '<td style="padding:6px 0;font-size:14px;font-weight:600;">' . Util::escapeHtml((string) $value) . '</td>'
                . '</tr>';
        }

        return '<table style="border-collapse:collapse;margin:16px 0;width:100%;">' . $rows . '</table>';
    }

    private static function date(mixed $value): ?string
    {
        if (empty($value)) {
            return null;
        }

        $timestamp = is_numeric($value) ? (int) $value : strtotime((string) $value);

        return $timestamp === false ? null : date('l j F Y', $timestamp);
    }

    private static function link(array $payload, string $path, string $label): string
    {
        $base = Config::baseUrl();

        return $base === '' ? '' : Mailer::button(rtrim($base, '/') . $path, $label);
    }

    private static function deliveryLabel(?string $mode): string
    {
        return match ($mode) {
            'vrc_pickup'        => 'Counselor will collect',
            'deliver_to_client' => 'Deliver to client',
            'client_pickup'     => 'Client will collect',
            default             => (string) $mode,
        };
    }

    private static function requestSubmitted(array $r): array
    {
        return [
            'subject' => "Loan request {$r['reference']} submitted",
            'html'    => Mailer::layout('A new loan request needs review',
                '<p>' . Util::escapeHtml($r['requester_name'] ?? 'A counselor')
                . ' has submitted a loan request.</p>'
                . self::details([
                    'Reference' => $r['reference'],
                    'Client'    => $r['client_name'] ?? null,
                    'Program'   => $r['program_name'] ?? null,
                    'Device'    => $r['device_name'] ?? $r['requested_category'] ?? $r['requested_details'] ?? null,
                    'Needed by' => self::date($r['needed_by'] ?? null),
                    'Delivery'  => self::deliveryLabel($r['delivery_mode'] ?? null),
                ])
                . (!empty($r['justification'])
                    ? '<p style="background:#f9fafb;border-left:3px solid #125b7d;padding:12px;font-size:14px;">'
                      . Util::escapeHtml($r['justification']) . '</p>'
                    : '')
                . self::link($r, "/#/requests/{$r['id']}", 'Review this request')),
        ];
    }

    private static function requestApproved(array $r): array
    {
        return [
            'subject' => "Loan request {$r['reference']} approved",
            'html'    => Mailer::layout('Your loan request was approved',
                '<p>Request <strong>' . Util::escapeHtml($r['reference']) . '</strong> has been approved.</p>'
                . self::details([
                    'Client'      => $r['client_name'] ?? null,
                    'Device'      => $r['device_name'] ?? null,
                    'Status'      => $r['tracking_summary'] ?? null,
                    'Reviewed by' => $r['reviewer_name'] ?? null,
                ])
                . (!empty($r['review_notes'])
                    ? '<p style="font-size:14px;">' . Util::escapeHtml($r['review_notes']) . '</p>' : '')
                . '<p style="font-size:14px;color:#6b7280;">You will be notified again when the device is ready.</p>'
                . self::link($r, "/#/requests/{$r['id']}", 'Track this request')),
        ];
    }

    private static function requestDenied(array $r): array
    {
        return [
            'subject' => "Loan request {$r['reference']} was declined",
            'html'    => Mailer::layout('Your loan request was declined',
                '<p>Request <strong>' . Util::escapeHtml($r['reference']) . '</strong> has been declined.</p>'
                . (!empty($r['review_notes'])
                    ? '<p style="background:#fef2f2;border-left:3px solid #b91c1c;padding:12px;font-size:14px;">'
                      . Util::escapeHtml($r['review_notes']) . '</p>'
                    : '')
                . self::details(['Client' => $r['client_name'] ?? null, 'Reviewed by' => $r['reviewer_name'] ?? null])
                . '<p style="font-size:14px;">If you think this was a mistake, reply to this message or speak '
                . 'to the loaner pool team.</p>'),
        ];
    }

    private static function readyForPickup(array $r): array
    {
        return [
            'subject' => "Ready for pickup — {$r['reference']}",
            'html'    => Mailer::layout('Your device is ready for pickup',
                '<p>The device for request <strong>' . Util::escapeHtml($r['reference'])
                . '</strong> is staged and ready to collect.</p>'
                . self::details([
                    'Device'  => $r['device_name'] ?? null,
                    'Barcode' => $r['device_barcode'] ?? null,
                    'Client'  => $r['client_name'] ?? null,
                ])
                . self::link($r, "/#/requests/{$r['id']}", 'View request')),
        ];
    }

    private static function checkedOut(array $l): array
    {
        return [
            'subject' => "Device issued — {$l['device_name']} ({$l['reference']})",
            'html'    => Mailer::layout('A device has been issued',
                '<p><strong>' . Util::escapeHtml($l['device_name']) . '</strong> has been checked out.</p>'
                . self::details([
                    'Loan reference' => $l['reference'],
                    'Barcode'        => $l['device_barcode'],
                    'Issued to'      => $l['holder_summary'] ?? null,
                    'Due back'       => self::date($l['due_at'] ?? null) ?? 'No return date (open-ended loan)',
                ])
                . (!empty($l['due_at'])
                    ? '<p style="font-size:14px;">Please return the device by the date above. You will get a '
                      . 'reminder before it is due.</p>'
                    : '')),
        ];
    }

    private static function dueSoon(array $l): array
    {
        $days = (int) ($l['days_until_due'] ?? 0);

        return [
            'subject' => "Due in {$days} day" . ($days === 1 ? '' : 's') . " — {$l['device_name']}",
            'html'    => Mailer::layout('A loaned device is due back soon',
                '<p><strong>' . Util::escapeHtml($l['device_name']) . '</strong> is due back '
                . Util::escapeHtml(self::date($l['due_at'] ?? null) ?? 'soon') . '.</p>'
                . self::details([
                    'Loan reference' => $l['reference'],
                    'Barcode'        => $l['device_barcode'],
                    'Held by'        => $l['holder_summary'] ?? null,
                ])
                . '<p style="font-size:14px;">If more time is needed, the loan can be extended — contact the '
                . 'loaner pool team before the due date.</p>'),
        ];
    }

    private static function overdue(array $l): array
    {
        $days = (int) ($l['days_overdue'] ?? 0);

        return [
            'subject' => "Overdue by {$days} day" . ($days === 1 ? '' : 's') . " — {$l['device_name']}",
            'html'    => Mailer::layout('A loaned device is overdue',
                '<p style="background:#fef2f2;border-left:3px solid #b91c1c;padding:12px;font-size:14px;">'
                . '<strong>' . Util::escapeHtml($l['device_name']) . '</strong> was due back '
                . Util::escapeHtml(self::date($l['due_at'] ?? null) ?? '') . ' and has not been returned.</p>'
                . self::details([
                    'Loan reference' => $l['reference'],
                    'Barcode'        => $l['device_barcode'],
                    'Held by'        => $l['holder_summary'] ?? null,
                    'Days overdue'   => $days,
                ])
                . '<p style="font-size:14px;">Please return it, or contact the loaner pool team to extend '
                . 'the loan.</p>'),
        ];
    }

    private static function checkedIn(array $l): array
    {
        return [
            'subject' => "Returned — {$l['device_name']} ({$l['reference']})",
            'html'    => Mailer::layout('A device has been returned',
                '<p><strong>' . Util::escapeHtml($l['device_name'])
                . '</strong> has been checked back in. Thank you.</p>'
                . self::details([
                    'Loan reference'  => $l['reference'],
                    'Returned'        => self::date($l['returned_at'] ?? null),
                    'Condition noted' => $l['condition_in'] ?? null,
                ])),
        ];
    }

    private static function reservationReadyTemplate(array $r): array
    {
        return [
            'subject' => "Ready to collect — {$r['ready_device_name']}",
            'html'    => Mailer::layout('The equipment you were waiting for is ready',
                '<p><strong>' . Util::escapeHtml((string) $r['ready_device_name'])
                . '</strong> has come back and is being held for you.</p>'
                . self::details([
                    'Reference'    => $r['reference'],
                    'Barcode'      => $r['ready_device_barcode'] ?? null,
                    'For'          => $r['client_name'] ?? null,
                    'Held until'   => self::date($r['claim_expires_at'] ?? null),
                ])
                . '<p style="font-size:14px;">It is held for a limited time. If you no longer need it, please '
                . 'cancel your waitlist entry so it can go to the next person.</p>'
                . self::link($r, '/#/waitlist', 'View the waitlist')),
        ];
    }
}
