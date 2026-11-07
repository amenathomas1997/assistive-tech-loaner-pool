<?php
/**
 * Loan agreements.
 *
 * The signed wording is snapshotted onto the agreement row rather than
 * referenced from settings. What an organisation's agreement says today is not
 * what somebody signed two years ago, and the wording that was signed is the
 * only one that matters if it is ever questioned.
 *
 * Placeholders in the configured text are substituted at signing time from the
 * loan, so the stored copy names the device, the person and the due date.
 */

declare(strict_types=1);

namespace Loaner;

final class Agreements
{
    public const ROLES   = ['client', 'counselor', 'technician', 'guardian', 'other'];
    public const METHODS = ['drawn', 'typed', 'uploaded', 'waived'];

    /**
     * The default wording, used when an organisation has not written its own.
     * Deliberately plain: an agreement nobody can read protects nobody.
     */
    public const DEFAULT_TEXT = <<<'TEXT'
    Loan agreement for {{device_name}} ({{device_barcode}})

    I have received the equipment described above on loan from {{organization}}.

    I agree that:

    1. The equipment remains the property of {{organization}}.
    2. I will take reasonable care of it and keep it in the condition in which
       I received it, allowing for normal use.
    3. I will return it by {{due_date}}, or arrange an extension before that
       date if I still need it.
    4. I will report any loss, theft or damage as soon as I am aware of it.
    5. I will not lend, sell, or permanently alter the equipment.

    If the equipment is lost or damaged beyond normal use, {{organization}} may
    ask me to contribute to its repair or replacement. Nothing in this
    agreement limits any right I have under law.

    Loan reference: {{loan_reference}}
    Issued on: {{checked_out_date}}
    TEXT;

    /** Settings an organisation controls, in the shape the signing screen needs. */
    public static function settings(int $organizationId): array
    {
        $configured = (string) Settings::get($organizationId, 'agreements.text');

        return [
            'enabled'     => (bool) Settings::get($organizationId, 'agreements.enabled'),
            'required'    => (bool) Settings::get($organizationId, 'agreements.required'),
            'allow_waive' => (bool) Settings::get($organizationId, 'agreements.allow_waive'),
            'text'        => trim($configured) !== '' ? $configured : self::DEFAULT_TEXT,
            'is_default'  => trim($configured) === '',
            'roles'       => self::ROLES,
            'signature_methods' => [
                ['value' => 'drawn',    'label' => 'Signed on screen with a finger or stylus'],
                ['value' => 'typed',    'label' => 'Typed name'],
                ['value' => 'uploaded', 'label' => 'Uploaded image of a signature'],
                ['value' => 'waived',   'label' => 'Waived, with a reason'],
            ],
            'placeholders' => array_keys(self::placeholderHelp()),
            'placeholder_help' => self::placeholderHelp(),
        ];
    }

    /** @return array<string, string> */
    public static function placeholderHelp(): array
    {
        return [
            '{{organization}}'     => 'Your organisation name',
            '{{device_name}}'      => 'The device being lent',
            '{{device_barcode}}'   => 'Its barcode',
            '{{device_serial}}'    => 'Its serial number, if recorded',
            '{{client_name}}'      => 'The client, if the loan names one',
            '{{tech_name}}'        => 'The technician handling the loan',
            '{{program_name}}'     => 'The program, if the loan names one',
            '{{loan_reference}}'   => 'The loan reference',
            '{{due_date}}'         => 'The return date',
            '{{checked_out_date}}' => 'The date it went out',
            '{{today}}'            => "Today's date",
        ];
    }

    /**
     * Fill the configured wording for one loan.
     *
     * Unknown placeholders are left alone rather than blanked: a visible
     * {{typo}} tells an administrator their template is wrong, whereas an
     * empty gap in a signed agreement does not.
     */
    public static function render(int $organizationId, array $loan): string
    {
        $settings     = self::settings($organizationId);
        $organization = Settings::organization($organizationId);

        $replacements = [
            '{{organization}}'     => $organization['name'] ?? 'this organisation',
            '{{device_name}}'      => $loan['device_name'] ?? '',
            '{{device_barcode}}'   => $loan['device_barcode'] ?? '',
            '{{device_serial}}'    => $loan['serial_number'] ?? 'not recorded',
            '{{client_name}}'      => $loan['client_name'] ?? 'the borrower',
            '{{tech_name}}'        => $loan['tech_name'] ?? 'the technician',
            '{{program_name}}'     => $loan['program_name'] ?? '',
            '{{loan_reference}}'   => $loan['reference'] ?? '',
            '{{due_date}}'         => self::date($loan['due_at'] ?? null) ?? 'the agreed date',
            '{{checked_out_date}}' => self::date($loan['checked_out_at'] ?? null) ?? '',
            '{{today}}'            => date('j F Y'),
        ];

        return str_replace(array_keys($replacements), array_values($replacements), $settings['text']);
    }

    private static function date(mixed $value): ?string
    {
        if (empty($value)) {
            return null;
        }

        $timestamp = strtotime((string) $value);

        return $timestamp === false ? null : date('j F Y', $timestamp);
    }

    /** The wording a loan would be signed against, without storing anything. */
    public static function preview(int $organizationId, int $loanId): array
    {
        $loan = Loans::get($organizationId, $loanId);
        if ($loan === null) {
            throw Util::notFound('That loan does not exist.');
        }

        return [
            'loan'     => $loan,
            'text'     => self::render($organizationId, $loan),
            'settings' => self::settings($organizationId),
            'existing' => self::forLoan($organizationId, $loanId),
        ];
    }

    public static function forLoan(int $organizationId, int $loanId): ?array
    {
        $row = Db::one(
            'SELECT a.*, w.full_name AS witnessed_by_name, s.id AS signature_id
               FROM loan_agreements a
               LEFT JOIN users w ON w.id = a.witnessed_by
               LEFT JOIN attachments s ON s.id = a.signature_attachment_id
              WHERE a.loan_id = ? AND a.organization_id = ?',
            [$loanId, $organizationId],
        );

        if ($row === null) {
            return null;
        }

        $row['method_label'] = match ($row['signature_method']) {
            'drawn'    => 'Signed on screen',
            'typed'    => 'Typed signature',
            'uploaded' => 'Uploaded signature',
            'waived'   => 'Waived',
            default    => $row['signature_method'],
        };

        $row['was_waived'] = $row['signature_method'] === 'waived';

        if (!empty($row['signature_attachment_id'])) {
            $row['signature_url'] = "/api/v1/attachments/{$row['signature_attachment_id']}/file";
        }

        return $row;
    }

    /**
     * Record a signature, or a waiver.
     *
     * One agreement per loan: re-signing would leave the question of which
     * copy was the agreed one.
     */
    public static function sign(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $loanId         = (int) $input['loanId'];
        $method         = (string) ($input['method'] ?? 'typed');
        $actorId        = $input['actorId'] ?? null;

        $settings = self::settings($organizationId);

        if (!$settings['enabled']) {
            throw Util::conflict(
                'Loan agreements are switched off for this organisation. An administrator can turn them on '
                . 'under Settings → Agreements.',
            );
        }

        if (!in_array($method, self::METHODS, true)) {
            throw Util::badRequest(
                "\"{$method}\" is not a signature method.",
                ['field' => 'method', 'allowed' => self::METHODS],
            );
        }

        if ($method === 'waived' && !$settings['allow_waive']) {
            throw Util::forbidden(
                'This organisation does not allow agreements to be waived. An administrator can change '
                . 'that under Settings → Agreements.',
            );
        }

        $loan = Loans::get($organizationId, $loanId);
        if ($loan === null) {
            throw Util::notFound('That loan does not exist.');
        }

        if (self::forLoan($organizationId, $loanId) !== null) {
            throw Util::conflict(
                "Loan {$loan['reference']} already has a signed agreement. If it needs to change, add a "
                . 'note to the loan rather than replacing the signed copy.',
                ['loan_id' => $loanId],
            );
        }

        $role = (string) ($input['role'] ?? 'client');
        if (!in_array($role, self::ROLES, true)) {
            throw Util::badRequest(
                "\"{$role}\" is not a signer role.",
                ['field' => 'signed_by_role', 'allowed' => self::ROLES],
            );
        }

        $waivedReason = null;
        $signerName   = null;
        $typed        = null;

        if ($method === 'waived') {
            $waivedReason = Util::str($input['waivedReason'] ?? null, 255);

            if ($waivedReason === null || $waivedReason === '') {
                throw Util::badRequest(
                    'Give a reason for waiving the agreement. It is recorded against the loan, and '
                    . 'without it there is no record of why the equipment went out unsigned.',
                    ['field' => 'waived_reason'],
                );
            }

            $signerName = Util::str($input['signerName'] ?? null, 190)
                ?: ($actor['fullName'] ?? $actor['label'] ?? 'Staff');
        } else {
            $signerName = Util::str($input['signerName'] ?? null, 190);

            if ($signerName === null || $signerName === '') {
                throw Util::badRequest('Enter the name of the person signing.', ['field' => 'signed_by_name']);
            }

            if ($method === 'typed') {
                $typed = Util::str($input['typedSignature'] ?? null, 190);

                if ($typed === null || $typed === '') {
                    throw Util::badRequest(
                        'Type the signer’s name to stand as their signature.',
                        ['field' => 'typed_signature'],
                    );
                }

                // A typed signature that does not match the stated name is the
                // sort of thing that makes the whole record worthless.
                if (strcasecmp(trim($typed), trim($signerName)) !== 0) {
                    throw Util::badRequest(
                        'The typed signature must match the signer’s name exactly.',
                        ['field' => 'typed_signature'],
                    );
                }
            }
        }

        $witnessedBy = $input['witnessedBy'] ?? null;

        if (!empty($witnessedBy)) {
            $exists = Db::value(
                'SELECT id FROM users WHERE id = ? AND organization_id = ?',
                [$witnessedBy, $organizationId],
            );
            if ($exists === null) {
                throw Util::badRequest('That witness is not a user here.', ['field' => 'witnessed_by']);
            }
        }

        $text = self::render($organizationId, $loan);

        $agreementId = Db::transaction(static function () use (
            $organizationId, $loanId, $text, $signerName, $role, $method,
            $typed, $waivedReason, $input, $actorId, $witnessedBy
        ): int {
            $signatureAttachmentId = null;

            if (in_array($method, ['drawn', 'uploaded'], true)) {
                $image = $input['signatureImage'] ?? null;
                if (!is_string($image) || $image === '') {
                    throw Util::badRequest(
                        'A drawn or uploaded signature needs an image.',
                        ['field' => 'signature_image'],
                    );
                }
                $signatureAttachmentId = Attachments::storeSignature($organizationId, $loanId, $image, $actorId);
            }

            try {
                return Db::insert(
                    'INSERT INTO loan_agreements
                       (organization_id, loan_id, agreement_text, signed_by_name, signed_by_role,
                        signature_method, signature_attachment_id, typed_signature, waived_reason,
                        witnessed_by, signed_at, ip)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)',
                    [
                        $organizationId, $loanId, $text, $signerName, $role, $method,
                        $signatureAttachmentId, $typed, $waivedReason,
                        $witnessedBy ?: $actorId, $input['ip'] ?? null,
                    ],
                );
            } catch (\Throwable $e) {
                if (Db::isDuplicate($e)) {
                    throw Util::conflict('That loan already has a signed agreement.');
                }
                throw $e;
            }
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => $method === 'waived' ? Audit::AGREEMENT_WAIVED : Audit::AGREEMENT_SIGNED,
            'entityType'     => 'loan',
            'entityId'       => $loanId,
            'entityLabel'    => $loan['reference'],
            'summary'        => $method === 'waived'
                ? "Agreement for {$loan['reference']} waived: {$waivedReason}"
                : "Agreement for {$loan['reference']} signed by {$signerName} ({$role})",
            'detail'         => ['method' => $method, 'agreement_id' => $agreementId],
        ]);

        return self::forLoan($organizationId, $loanId);
    }

    /**
     * Active loans that should have an agreement and do not.
     *
     * Only meaningful when agreements are required; reported anyway so an
     * administrator can see the gap before switching the requirement on.
     */
    public static function missing(int $organizationId): array
    {
        $rows = Db::all(
            'SELECT l.id, l.reference, l.checked_out_at, l.due_at,
                    d.name AS device_name, d.barcode AS device_barcode,
                    CONCAT(c.first_name, " ", c.last_name) AS client_name,
                    u.full_name AS tech_name
               FROM loans l
               JOIN devices d ON d.id = l.device_id
               LEFT JOIN clients c ON c.id = l.client_id
               LEFT JOIN users u ON u.id = l.tech_id
               LEFT JOIN loan_agreements a ON a.loan_id = l.id
              WHERE l.organization_id = ? AND l.status = "active" AND a.id IS NULL
              ORDER BY l.checked_out_at',
            [$organizationId],
        );

        $settings = self::settings($organizationId);

        return [
            'rows'     => $rows,
            'total'    => count($rows),
            'enabled'  => $settings['enabled'],
            'required' => $settings['required'],
            'notice'   => $rows === []
                ? 'Every active loan has a signed agreement.'
                : sprintf(
                    '%d active loan%s without a signed agreement.%s',
                    count($rows), count($rows) === 1 ? '' : 's',
                    $settings['required'] ? '' : ' Agreements are not currently required.',
                ),
        ];
    }

    /** A printable copy, as its own HTML document. */
    public static function printable(int $organizationId, int $loanId): string
    {
        $loan = Loans::get($organizationId, $loanId);
        if ($loan === null) {
            throw Util::notFound('That loan does not exist.');
        }

        $agreement = self::forLoan($organizationId, $loanId);
        $text      = $agreement['agreement_text'] ?? self::render($organizationId, $loan);
        $org       = Settings::organization($organizationId);

        $signature = '';
        if ($agreement !== null) {
            $signature = match ($agreement['signature_method']) {
                'waived' => '<p class="waived"><strong>Agreement waived.</strong> '
                    . Util::escapeHtml($agreement['waived_reason']) . '</p>',
                'typed'  => '<p class="typed">' . Util::escapeHtml($agreement['typed_signature']) . '</p>',
                default  => !empty($agreement['signature_attachment_id'])
                    ? '<img class="sig" alt="Signature of '
                        . Util::escapeHtml($agreement['signed_by_name'])
                        . '" src="/api/v1/attachments/' . (int) $agreement['signature_attachment_id'] . '/file">'
                    : '',
            };
        }

        $signedBlock = $agreement === null
            ? '<div class="unsigned"><p>Signature</p><div class="rule"></div>'
              . '<p class="small">Name and date</p><div class="rule"></div></div>'
            : sprintf(
                '<div class="signed">%s<p><strong>%s</strong><br>%s<br>Signed %s</p></div>',
                $signature,
                Util::escapeHtml($agreement['signed_by_name']),
                Util::escapeHtml(ucfirst((string) $agreement['signed_by_role'])),
                Util::escapeHtml(self::date($agreement['signed_at']) ?? ''),
            );

        $title = 'Equipment loan agreement';
        $subtitle = $loan['reference'] ?? '';

        return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            . '<meta name="viewport" content="width=device-width, initial-scale=1">'
            . '<title>' . Util::escapeHtml($title) . '</title><style>'
            . '@page{size:A4;margin:18mm}'
            . 'body{font:12pt/1.6 Georgia,"Times New Roman",serif;color:#111;max-width:170mm;margin:0 auto;padding:12mm}'
            . 'h1{font-size:17pt;margin:0 0 4mm}'
            . '.org{font-size:11pt;color:#444;margin:0 0 8mm}'
            . 'pre{font:inherit;white-space:pre-wrap;margin:0 0 10mm}'
            . '.meta{font-size:10pt;color:#333;border-top:1px solid #999;padding-top:4mm;margin-top:8mm}'
            . '.meta dt{float:left;width:38mm;font-weight:bold;clear:left}'
            . '.meta dd{margin:0 0 1.5mm 40mm}'
            . '.rule{border-bottom:1px solid #333;height:10mm;margin-bottom:2mm}'
            . '.small{font-size:9pt;color:#555;margin:0 0 6mm}'
            . '.sig{max-width:70mm;max-height:25mm;display:block;margin-bottom:3mm}'
            . '.typed{font-family:cursive;font-size:16pt;margin:0 0 3mm}'
            . '.waived{padding:3mm;border:1px solid #999;background:#f5f5f5}'
            . '@media print{body{padding:0}}'
            . '</style></head><body>'
            . '<h1>' . Util::escapeHtml($title) . '</h1>'
            . '<p class="org">' . Util::escapeHtml($org['name'] ?? '')
                . ($subtitle !== '' ? ' — ' . Util::escapeHtml($subtitle) : '') . '</p>'
            . '<pre>' . Util::escapeHtml($text) . '</pre>'
            . $signedBlock
            . '<dl class="meta">'
            . '<dt>Device</dt><dd>' . Util::escapeHtml($loan['device_name'] ?? '')
                . ' (' . Util::escapeHtml($loan['device_barcode'] ?? '') . ')</dd>'
            . '<dt>Loan reference</dt><dd>' . Util::escapeHtml($loan['reference'] ?? '') . '</dd>'
            . '<dt>Checked out</dt><dd>' . Util::escapeHtml(self::date($loan['checked_out_at'] ?? null) ?? '') . '</dd>'
            . '<dt>Due back</dt><dd>' . Util::escapeHtml(self::date($loan['due_at'] ?? null) ?? 'No fixed date') . '</dd>'
            . '</dl></body></html>';
    }
}
