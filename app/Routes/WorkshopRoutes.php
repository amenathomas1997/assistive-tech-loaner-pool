<?php
/**
 * The back room: kits, loan groups, waitlists, repairs, agreements,
 * attachments, bulk actions and the job runner.
 *
 * Grouped into one module because these are the things a technician reaches
 * for rather than the counter-facing flows, and because each is small enough
 * that a file apiece would be more navigation than code.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Agreements;
use Loaner\Attachments;
use Loaner\Audit;
use Loaner\Auth;
use Loaner\Config;
use Loaner\Devices;
use Loaner\Jobs;
use Loaner\Kits;
use Loaner\Loans;
use Loaner\Notifications;
use Loaner\Repairs;
use Loaner\Request;
use Loaner\Reservations;
use Loaner\Response;
use Loaner\Router;
use Loaner\Settings;
use Loaner\Util;

final class WorkshopRoutes
{
    public static function register(Router $router): void
    {
        // --- Kits and accessories -------------------------------------------
        $router->get('/kits', [self::class, 'kits'], 'devices.read');
        $router->post('/kits', [self::class, 'createKit'], 'devices.write');
        $router->get('/kits/accessories/{deviceId}', [self::class, 'accessories'], 'devices.read');
        $router->put('/kits/accessories/{deviceId}', [self::class, 'setAccessories'], 'devices.write');
        $router->get('/kits/{id}', [self::class, 'kit'], 'devices.read');
        $router->patch('/kits/{id}', [self::class, 'updateKit'], 'devices.write');
        $router->delete('/kits/{id}', [self::class, 'deleteKit'], 'devices.write');
        $router->post('/kits/{id}/checkout', [self::class, 'checkOutKit'], 'loans.write');

        // --- Loan groups ----------------------------------------------------
        $router->get('/groups/{ref}', [self::class, 'group'], 'loans.read');
        $router->post('/groups/{ref}/checkin', [self::class, 'checkInGroup'], 'loans.write');

        // --- Reservations ---------------------------------------------------
        $router->get('/reservations', [self::class, 'reservations'], 'loans.read');
        $router->post('/reservations', [self::class, 'createReservation'], 'requests.write');
        $router->get('/reservations/device/{deviceId}', [self::class, 'deviceWaitlist'], 'loans.read');
        $router->get('/reservations/{id}', [self::class, 'reservation'], 'loans.read');
        $router->post('/reservations/{id}/cancel', [self::class, 'cancelReservation'], 'requests.write');

        // --- Repairs --------------------------------------------------------
        $router->get('/repairs', [self::class, 'repairs'], 'devices.read');
        $router->get('/repairs/meta', [self::class, 'repairMeta'], 'devices.read');
        $router->get('/repairs/summary', [self::class, 'repairSummary'], 'reports.read');
        $router->post('/repairs', [self::class, 'openRepair'], 'devices.write');
        $router->get('/repairs/{id}', [self::class, 'repair'], 'devices.read');
        $router->patch('/repairs/{id}', [self::class, 'updateRepair'], 'devices.write');

        // --- Agreements -----------------------------------------------------
        $router->get('/agreements/settings', [self::class, 'agreementSettings'], 'loans.read');
        $router->get('/agreements/audit/missing', [self::class, 'missingAgreements'], 'loans.read');
        $router->get('/agreements/preview/{loanId}', [self::class, 'agreementPreview'], 'loans.read');
        $router->get('/agreements/{loanId}', [self::class, 'agreement'], 'loans.read');
        $router->post('/agreements/{loanId}', [self::class, 'signAgreement'], 'loans.write');
        $router->get('/agreements/{loanId}/print', [self::class, 'printAgreement'], 'loans.read');

        // --- Attachments ----------------------------------------------------
        $router->get('/attachments/usage/summary', [self::class, 'storageUsage'], 'settings.read');
        $router->post('/attachments/loan/{loanId}', [self::class, 'addLoanPhotos'], 'loans.write');
        $router->get('/attachments/loan/{loanId}/list', [self::class, 'loanAttachments'], 'loans.read');
        $router->post('/attachments/repair/{repairId}', [self::class, 'addRepairPhotos'], 'devices.write');
        $router->get('/attachments/{id}/file', [self::class, 'file'], 'loans.read');
        $router->delete('/attachments/{id}', [self::class, 'deleteAttachment'], 'loans.write');

        // --- Bulk -----------------------------------------------------------
        $router->post('/bulk/checkin', [self::class, 'bulkCheckIn'], 'loans.write');
        $router->post('/bulk/device-status', [self::class, 'bulkDeviceStatus'], 'devices.write');

        // --- Jobs -----------------------------------------------------------
        $router->get('/jobs', [self::class, 'jobs'], 'settings.read');
        $router->get('/jobs/cron-command', [self::class, 'cronCommand'], 'settings.read');
        // No capability: this one authenticates by token so cron can call it.
        $router->post('/jobs/run', [self::class, 'runJobs']);
    }

    // -----------------------------------------------------------------------
    // Kits
    // -----------------------------------------------------------------------

    public static function kits(Request $request): never
    {
        Response::json(Util::collection(Kits::list(
            (int) $request->auth['organizationId'],
            Util::bool($request->queryParam('include_inactive') ?? false),
        )));
    }

    public static function kit(Request $request): never
    {
        $kit = Kits::get((int) $request->auth['organizationId'], (int) $request->param('id'));

        if ($kit === null) {
            throw Util::notFound('That kit does not exist.');
        }

        Response::json(['kit' => $kit]);
    }

    public static function createKit(Request $request): never
    {
        $kit = Kits::create(
            Audit::actor($request),
            (int) $request->auth['organizationId'],
            $request->body(),
        );

        Response::json(['kit' => $kit], 201);
    }

    public static function updateKit(Request $request): never
    {
        $kit = Kits::update(
            Audit::actor($request),
            (int) $request->auth['organizationId'],
            (int) $request->param('id'),
            $request->body(),
        );

        Response::json(['kit' => $kit]);
    }

    public static function deleteKit(Request $request): never
    {
        Kits::delete(
            Audit::actor($request),
            (int) $request->auth['organizationId'],
            (int) $request->param('id'),
        );

        Response::noContent();
    }

    public static function checkOutKit(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        $result = Kits::checkOut(Audit::actor($request), [
            'organizationId'  => (int) $auth['organizationId'],
            'kitId'           => (int) $request->param('id'),
            'techId'          => $body['tech_id'] ?? $body['techId'] ?? null,
            'clientId'        => $body['client_id'] ?? $body['clientId'] ?? null,
            'programId'       => $body['program_id'] ?? $body['programId'] ?? null,
            'loanPeriodId'    => $body['loan_period_id'] ?? $body['loanPeriodId'] ?? null,
            'customDays'      => $body['custom_days'] ?? $body['customDays'] ?? null,
            'conditionOut'    => Util::str($body['condition_out'] ?? $body['conditionOut'] ?? null, 190),
            'notes'           => Util::str($body['notes'] ?? null),
            'skipUnavailable' => Util::bool($body['skip_unavailable'] ?? $body['skipUnavailable'] ?? false),
            'method'          => Util::oneOf($body['method'] ?? 'manual',
                ['scan', 'manual', 'api', 'request'], 'method', true),
            'actorId'         => $auth['userId'] ?? null,
        ]);

        // One email for the kit, not one per device: four separate
        // "your device is ready" emails for one handover is noise.
        if ($result['loans'] !== []) {
            Notifications::send(Audit::actor($request), (int) $auth['organizationId'], 'checked_out',
                $result['loans'][0] + ['__loan_id' => (int) $result['loans'][0]['id']]);
        }

        Response::json($result, 201);
    }

    public static function accessories(Request $request): never
    {
        Response::json(Util::collection(Kits::accessories(
            (int) $request->auth['organizationId'],
            (int) $request->param('deviceId'),
        )));
    }

    public static function setAccessories(Request $request): never
    {
        $accessories = $request->input('accessories');

        if (!is_array($accessories)) {
            throw Util::badRequest(
                'Send the checklist as a list. An empty list clears it.',
                ['field' => 'accessories'],
            );
        }

        Response::json(Util::collection(Kits::setAccessories(
            Audit::actor($request),
            (int) $request->auth['organizationId'],
            (int) $request->param('deviceId'),
            $accessories,
        )));
    }

    // -----------------------------------------------------------------------
    // Groups
    // -----------------------------------------------------------------------

    public static function group(Request $request): never
    {
        $group = Kits::group((int) $request->auth['organizationId'], (string) $request->param('ref'));

        if ($group === null) {
            throw Util::notFound('No loan group matches that reference.');
        }

        Response::json($group);
    }

    public static function checkInGroup(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        $result = Kits::checkInGroup(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'groupRef'       => (string) $request->param('ref'),
            'conditionIn'    => Util::str($body['condition_in'] ?? $body['conditionIn'] ?? null, 190),
            'notes'          => Util::str($body['notes'] ?? null),
            'method'         => Util::oneOf($body['method'] ?? 'manual',
                ['scan', 'manual', 'api'], 'method', true),
            'actorId'        => $auth['userId'] ?? null,
        ]);

        Response::json($result);
    }

    // -----------------------------------------------------------------------
    // Reservations
    // -----------------------------------------------------------------------

    public static function reservations(Request $request): never
    {
        $auth       = $request->auth;
        $pagination = Util::pagination($request->query);

        $filters = [
            'status'      => $request->queryParam('status'),
            'open'        => $request->queryParam('open'),
            'deviceId'    => $request->queryParam('device_id'),
            'category'    => $request->queryParam('category'),
            'clientId'    => $request->queryParam('client_id'),
            'requestedBy' => $request->queryParam('requested_by'),
        ];

        if (Auth::isRestrictedToOwnRecords($auth)) {
            $filters['requestedBy'] = $auth['userId'];
        }

        $result = Reservations::list((int) $auth['organizationId'], $filters, [
            'limit'  => $pagination['limit'],
            'offset' => $pagination['offset'],
        ]);

        Response::json(Util::paged($result['rows'], $result['total'], $pagination));
    }

    public static function reservation(Request $request): never
    {
        $reservation = Reservations::get(
            (int) $request->auth['organizationId'],
            (int) $request->param('id'),
        );

        if ($reservation === null) {
            throw Util::notFound('That reservation does not exist.');
        }

        Response::json(['reservation' => $reservation]);
    }

    public static function createReservation(Request $request): never
    {
        $auth           = $request->auth;
        $organizationId = (int) $auth['organizationId'];
        $body           = $request->body();

        if (!Settings::get($organizationId, 'reservations.enabled')) {
            throw Util::conflict(
                'Waitlists are switched off for this organisation. An administrator can turn them on '
                . 'under Settings → Reservations.',
            );
        }

        $requestedBy = $auth['userId'] ?? Util::int(
            $body['requested_by'] ?? $body['requestedBy'] ?? null, 'requested_by', 1,
        );

        if ($requestedBy === null) {
            throw Util::badRequest(
                'An API key must say which user the reservation is for.',
                ['field' => 'requested_by'],
            );
        }

        $reservation = Reservations::create(Audit::actor($request), [
            'organizationId' => $organizationId,
            'requestedBy'    => $requestedBy,
            'deviceId'       => $body['device_id'] ?? $body['deviceId'] ?? null,
            'category'       => Util::str($body['category'] ?? null, 96),
            'clientId'       => $body['client_id'] ?? $body['clientId'] ?? null,
            'programId'      => $body['program_id'] ?? $body['programId'] ?? null,
            'requestId'      => $body['request_id'] ?? $body['requestId'] ?? null,
            'priority'       => Util::int($body['priority'] ?? 0, 'priority', 0, 100) ?? 0,
            'neededFrom'     => empty($body['needed_from'] ?? $body['neededFrom'] ?? null)
                ? null : Util::dateOnly($body['needed_from'] ?? $body['neededFrom'], 'needed_from'),
            'neededTo'       => empty($body['needed_to'] ?? $body['neededTo'] ?? null)
                ? null : Util::dateOnly($body['needed_to'] ?? $body['neededTo'], 'needed_to'),
            'notes'          => Util::str($body['notes'] ?? null),
            'actorId'        => $auth['userId'] ?? null,
        ]);

        Response::json($reservation, 201);
    }

    public static function cancelReservation(Request $request): never
    {
        $auth = $request->auth;

        $reservation = Reservations::cancel(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'reservationId'  => (int) $request->param('id'),
            'reason'         => Util::str($request->input('reason')),
            'auth'           => $auth,
        ]);

        Response::json(['reservation' => $reservation]);
    }

    public static function deviceWaitlist(Request $request): never
    {
        Response::json(Util::collection(Reservations::forDevice(
            (int) $request->auth['organizationId'],
            (int) $request->param('deviceId'),
        )));
    }

    // -----------------------------------------------------------------------
    // Repairs
    // -----------------------------------------------------------------------

    public static function repairs(Request $request): never
    {
        $pagination = Util::pagination($request->query);

        $result = Repairs::list((int) $request->auth['organizationId'], [
            'status'     => $request->queryParam('status'),
            'deviceId'   => $request->queryParam('device_id'),
            'assignedTo' => $request->queryParam('assigned_to'),
            'open'       => $request->queryParam('open'),
            'from'       => $request->queryParam('from'),
            'to'         => $request->queryParam('to'),
            'search'     => $request->queryParam('search'),
        ], [
            'limit'  => $pagination['limit'],
            'offset' => $pagination['offset'],
            'sort'   => $request->queryParam('sort'),
        ]);

        Response::json(Util::paged($result['rows'], $result['total'], $pagination));
    }

    public static function repair(Request $request): never
    {
        $repair = Repairs::get((int) $request->auth['organizationId'], (int) $request->param('id'));

        if ($repair === null) {
            throw Util::notFound('That repair does not exist.');
        }

        Response::json(['repair' => $repair]);
    }

    public static function repairMeta(Request $request): never
    {
        Response::json(Repairs::meta((int) $request->auth['organizationId']));
    }

    public static function repairSummary(Request $request): never
    {
        Response::json(Repairs::summary(
            (int) $request->auth['organizationId'],
            $request->queryParam('from'),
            $request->queryParam('to'),
        ));
    }

    public static function openRepair(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        $repair = Repairs::open(Audit::actor($request), [
            'organizationId'   => (int) $auth['organizationId'],
            'deviceIdentifier' => $body['device_id'] ?? $body['deviceId']
                ?? $body['device'] ?? $body['barcode'] ?? null,
            'fault'            => $body['fault'] ?? null,
            'vendor'           => $body['vendor'] ?? null,
            'vendorRef'        => $body['vendor_ref'] ?? $body['vendorRef'] ?? null,
            'cost'             => $body['cost'] ?? null,
            'underWarranty'    => $body['under_warranty'] ?? $body['underWarranty'] ?? false,
            'assignedTo'       => $body['assigned_to'] ?? $body['assignedTo'] ?? null,
            // A device can be reported faulty while still out with someone;
            // only end the loan if the person opening the repair says to.
            'checkInFirst'     => $body['check_in_first'] ?? $body['checkInFirst'] ?? false,
            'actorId'          => $auth['userId'] ?? null,
        ]);

        Response::json(['repair' => $repair], 201);
    }

    public static function updateRepair(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        $input = [
            'organizationId' => (int) $auth['organizationId'],
            'repairId'       => (int) $request->param('id'),
            'actorId'        => $auth['userId'] ?? null,
        ];

        // Only forward fields that were actually sent. Passing every key with
        // a null default would blank the vendor and cost on a PATCH that only
        // meant to change the status.
        foreach ([
            'status' => ['status'],
            'notes'  => ['notes'],
            'diagnosis' => ['diagnosis'],
            'resolution' => ['resolution'],
            'vendor' => ['vendor'],
            'vendorRef' => ['vendor_ref', 'vendorRef'],
            'cost' => ['cost'],
            'underWarranty' => ['under_warranty', 'underWarranty'],
            'assignedTo' => ['assigned_to', 'assignedTo'],
            'sentAt' => ['sent_at', 'sentAt'],
            'returnedAt' => ['returned_at', 'returnedAt'],
        ] as $target => $accepted) {
            foreach ($accepted as $key) {
                if (array_key_exists($key, $body)) {
                    $input[$target] = $body[$key];
                    break;
                }
            }
        }

        $repair = Repairs::update(Audit::actor($request), $input);

        Response::json(['repair' => $repair]);
    }

    // -----------------------------------------------------------------------
    // Agreements
    // -----------------------------------------------------------------------

    public static function agreementSettings(Request $request): never
    {
        Response::json(Agreements::settings((int) $request->auth['organizationId']));
    }

    public static function agreementPreview(Request $request): never
    {
        Response::json(Agreements::preview(
            (int) $request->auth['organizationId'],
            (int) $request->param('loanId'),
        ));
    }

    public static function agreement(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $loanId         = (int) $request->param('loanId');

        $agreement = Agreements::forLoan($organizationId, $loanId);

        if ($agreement === null) {
            // Not an error: "no agreement yet" is the normal state, and the
            // signing screen needs the wording either way.
            Response::json([
                'agreement' => null,
                'settings'  => Agreements::settings($organizationId),
            ]);
        }

        Response::json([
            'agreement' => $agreement,
            'settings'  => Agreements::settings($organizationId),
        ]);
    }

    public static function signAgreement(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        $agreement = Agreements::sign(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'loanId'         => (int) $request->param('loanId'),
            'method'         => $body['signature_method'] ?? $body['signatureMethod']
                ?? $body['method'] ?? 'typed',
            'role'           => $body['signed_by_role'] ?? $body['signedByRole']
                ?? $body['role'] ?? 'client',
            'signerName'     => $body['signed_by_name'] ?? $body['signedByName']
                ?? $body['signer_name'] ?? $body['signerName'] ?? null,
            'typedSignature' => $body['typed_signature'] ?? $body['typedSignature'] ?? null,
            'signatureImage' => $body['signature_image'] ?? $body['signatureImage'] ?? null,
            'waivedReason'   => $body['waived_reason'] ?? $body['waivedReason'] ?? null,
            'witnessedBy'    => $body['witnessed_by'] ?? $body['witnessedBy'] ?? null,
            'ip'             => $request->ip ?: null,
            'actorId'        => $auth['userId'] ?? null,
        ]);

        Response::json(['agreement' => $agreement], 201);
    }

    public static function printAgreement(Request $request): never
    {
        Response::html(Agreements::printable(
            (int) $request->auth['organizationId'],
            (int) $request->param('loanId'),
        ));
    }

    public static function missingAgreements(Request $request): never
    {
        Response::json(Agreements::missing((int) $request->auth['organizationId']));
    }

    // -----------------------------------------------------------------------
    // Attachments
    // -----------------------------------------------------------------------

    public static function addLoanPhotos(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        // Entitlement is checked against the loan, not just the capability.
        Loans::getVisible($auth, (int) $auth['organizationId'], (int) $request->param('loanId'));

        $result = Attachments::addLoanPhotos(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'loanId'         => (int) $request->param('loanId'),
            'phase'          => $body['phase'] ?? 'out',
            'images'         => $body['images'] ?? [],
            'actorId'        => $auth['userId'] ?? null,
        ]);

        Response::json($result, $result['count'] > 0 ? 201 : 200);
    }

    public static function loanAttachments(Request $request): never
    {
        $auth   = $request->auth;
        $loanId = (int) $request->param('loanId');

        // Condition photos and signatures are personal data about a named
        // client, so holding "loans.read" is not enough — the caller has to be
        // entitled to this particular loan.
        Loans::getVisible($auth, (int) $auth['organizationId'], $loanId);

        Response::json(Attachments::forLoan((int) $auth['organizationId'], $loanId));
    }

    public static function addRepairPhotos(Request $request): never
    {
        $auth = $request->auth;

        $result = Attachments::addRepairPhotos(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'repairId'       => (int) $request->param('repairId'),
            'images'         => $request->input('images') ?? [],
            'actorId'        => $auth['userId'] ?? null,
        ]);

        Response::json($result, $result['count'] > 0 ? 201 : 200);
    }

    /**
     * Stream a stored photo or signature.
     *
     * Files live above the web root and are served only through here, so a
     * photo of someone's equipment is never fetchable by guessing a path.
     */
    public static function file(Request $request): never
    {
        $auth           = $request->auth;
        $organizationId = (int) $auth['organizationId'];

        $row = Attachments::absolutePath($organizationId, (int) $request->param('id'));

        if ($row === null) {
            throw Util::notFound('That file does not exist.');
        }

        // Attachment ids are sequential, so without this a counselor could walk
        // the range and collect every client's signature and condition photos.
        // Reported as "does not exist" rather than "forbidden" so the response
        // does not confirm that the file is there.
        if (!empty($row['loan_id'])
            && !Loans::isVisibleTo($auth, ['client_id' => $row['loan_client_id'],
                                           'request_id' => $row['loan_request_id']])
        ) {
            throw Util::notFound('That file does not exist.');
        }

        Response::file($row['absolute_path'], $row['mime_type'], $row['filename']);
    }

    public static function deleteAttachment(Request $request): never
    {
        Attachments::delete(
            Audit::actor($request),
            (int) $request->auth['organizationId'],
            (int) $request->param('id'),
        );

        Response::noContent();
    }

    public static function storageUsage(Request $request): never
    {
        Response::json(Attachments::usage((int) $request->auth['organizationId']));
    }

    // -----------------------------------------------------------------------
    // Bulk
    // -----------------------------------------------------------------------

    /**
     * Check in many devices at once, by barcode or loan id.
     *
     * Partial success is reported rather than rolled back. A stocktake that
     * scans forty returned devices and hits one that was already back should
     * still record the thirty-nine.
     */
    public static function bulkCheckIn(Request $request): never
    {
        $auth           = $request->auth;
        $organizationId = (int) $auth['organizationId'];
        $body           = $request->body();

        $items = $body['devices'] ?? $body['barcodes'] ?? $body['items'] ?? [];

        if (!is_array($items) || $items === []) {
            throw Util::badRequest(
                'Scan or choose at least one device to check in.',
                ['field' => 'devices'],
            );
        }

        if (count($items) > 500) {
            throw Util::badRequest(
                'That is ' . count($items) . ' devices in one request; the limit is 500. Split it into '
                . 'smaller batches.',
                ['field' => 'devices', 'limit' => 500],
            );
        }

        $checkedIn = [];
        $failed    = [];

        foreach ($items as $item) {
            $identifier = is_array($item) ? ($item['device'] ?? $item['barcode'] ?? null) : $item;
            $loanId     = is_array($item) ? ($item['loan_id'] ?? $item['loanId'] ?? null) : null;

            try {
                $result = Loans::checkIn(Audit::actor($request), [
                    'organizationId'   => $organizationId,
                    'deviceIdentifier' => $identifier,
                    'loanId'           => $loanId,
                    'conditionIn'      => Util::str($body['condition_in'] ?? $body['conditionIn'] ?? null, 190),
                    'notes'            => Util::str($body['notes'] ?? null),
                    'newDeviceStatus'  => Util::oneOf(
                        $body['new_device_status'] ?? $body['newDeviceStatus'] ?? 'available',
                        Devices::STATUSES, 'new_device_status', true,
                    ),
                    'method'           => Util::oneOf($body['method'] ?? 'scan',
                        ['scan', 'manual', 'api'], 'method', true),
                    'actorId'          => $auth['userId'] ?? null,
                ]);

                $checkedIn[] = [
                    'identifier'  => $identifier,
                    'loan'        => $result['loan'],
                    'was_overdue' => $result['wasOverdue'],
                    'days_late'   => $result['daysLate'],
                ];
            } catch (\Throwable $e) {
                $failed[] = ['identifier' => $identifier, 'loan_id' => $loanId, 'reason' => $e->getMessage()];
            }
        }

        Response::json([
            // Counts first: the caller shows "38 checked in, 2 could not be"
            // and only needs the detail when something went wrong.
            'checked_in'    => count($checkedIn),
            'failed_count'  => count($failed),
            'loans'         => $checkedIn,
            // The client renders this as a table of what could not be done, so
            // it is the rows, not a count. The count is failed_count.
            'failed'        => $failed,
            'summary'       => sprintf(
                '%d device%s checked in%s.',
                count($checkedIn), count($checkedIn) === 1 ? '' : 's',
                $failed === [] ? '' : ', ' . count($failed) . ' could not be',
            ),
        ]);
    }

    public static function bulkDeviceStatus(Request $request): never
    {
        $body = $request->body();
        $ids  = $body['device_ids'] ?? $body['deviceIds'] ?? $body['ids'] ?? [];

        if (!is_array($ids) || $ids === []) {
            throw Util::badRequest('Choose at least one device.', ['field' => 'device_ids']);
        }

        $status = Util::requiredStr($body['status'] ?? null, 'status', 40);

        Response::json(Devices::bulkStatus(
            Audit::actor($request),
            (int) $request->auth['organizationId'],
            $ids,
            $status,
            Util::str($body['note'] ?? $body['condition_note'] ?? null, 190),
        ));
    }

    // -----------------------------------------------------------------------
    // Jobs
    // -----------------------------------------------------------------------

    public static function jobs(Request $request): never
    {
        Response::json(Jobs::status((int) $request->auth['organizationId']));
    }

    public static function cronCommand(Request $request): never
    {
        Response::json(Jobs::cronCommand($request->baseUrl()));
    }

    /**
     * Trigger the scheduled jobs.
     *
     * Accepts either a cron token in the query string or a signed-in
     * administrator. Cron has no session, and requiring one would mean storing
     * a password in a crontab line.
     */
    public static function runJobs(Request $request): never
    {
        // The token arrives in a header, not the query string: query strings
        // are written to access logs and proxy logs, and this one is a standing
        // credential.
        $token = $request->header('X-Cron-Token');

        if (is_string($token) && $token !== '') {
            if (!Config::verifyCronToken($token)) {
                throw Util::forbidden('That cron token is not valid for this installation.');
            }

            // Cron runs the whole site, not one tenant.
            $triggeredBy     = 'cron';
            $actor           = null;
            $organizationIds = array_map('intval', array_column(
                \Loaner\Db::all('SELECT id FROM organizations WHERE active = 1 ORDER BY id'),
                'id',
            ));
        } else {
            // No token: fall back to a signed-in administrator pressing the
            // button. Phrased as "forbidden" rather than "unauthorized"
            // because the endpoint exists and the caller simply may not use it.
            if ($request->auth === null) {
                throw Util::forbidden(
                    'Running the scheduled jobs needs either an administrator session or the '
                    . 'X-Cron-Token header. See Settings → Scheduled jobs for the cron line.',
                );
            }

            $auth = Auth::requireCapability($request, 'settings.write');

            $triggeredBy     = 'manual';
            $actor           = Audit::actor($request);
            $organizationIds = [(int) $auth['organizationId']];
        }

        $organizations = [];
        foreach ($organizationIds as $organizationId) {
            $organizations[(string) $organizationId] = Jobs::runAll($actor, $organizationId, $triggeredBy);
        }

        $ok = !in_array(false, array_column($organizations, 'ok'), true);

        Response::json([
            'ok'            => $ok,
            'triggered_by'  => $triggeredBy,
            'ran_at'        => date('c'),
            'organizations' => $organizations,
            'summary'       => $ok
                ? 'All scheduled jobs completed.'
                : 'Some scheduled jobs failed — see each organisation below.',
        // 207 rather than 500: some organisations' jobs did run, and a single
        // failing mailbox should not make the whole call look like a crash.
        ], $ok ? 200 : 207);
    }
}
