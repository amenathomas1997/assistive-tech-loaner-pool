<?php
/**
 * Device inventory endpoints.
 *
 * The literal paths here (/devices/facets, /devices/export.csv,
 * /devices/import/preview) sit alongside /devices/{id}. The router scores
 * literal segments above parameters, so none of them can be swallowed by the
 * id route regardless of the order they are registered in.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Audit;
use Loaner\Auth;
use Loaner\Barcode;
use Loaner\Csv;
use Loaner\Devices;
use Loaner\Kits;
use Loaner\Request;
use Loaner\Reservations;
use Loaner\Response;
use Loaner\Router;
use Loaner\Settings;
use Loaner\Util;

final class DeviceRoutes
{
    public static function register(Router $router): void
    {
        $router->get('/devices', [self::class, 'index'], 'devices.read');
        $router->get('/devices/facets', [self::class, 'facets'], 'devices.read');
        $router->get('/devices/export.csv', [self::class, 'exportCsv'], 'devices.read');
        $router->get('/devices/labels', [self::class, 'labels'], 'devices.read');
        $router->get('/devices/lookup/{code}', [self::class, 'lookup'], 'devices.read');

        $router->get('/devices/import/template.csv', [self::class, 'template'], 'devices.import');
        $router->get('/devices/import/history', [self::class, 'importHistory'], 'devices.import');
        $router->post('/devices/import/preview', [self::class, 'importPreview'], 'devices.import');
        $router->post('/devices/import', [self::class, 'import'], 'devices.import');

        $router->post('/devices', [self::class, 'create'], 'devices.write');
        $router->post('/devices/backfill-barcodes', [self::class, 'backfill'], 'devices.write');

        $router->get('/devices/{id}', [self::class, 'show'], 'devices.read');
        $router->get('/devices/{id}/barcode.svg', [self::class, 'barcodeSvg'], 'devices.read');
        $router->patch('/devices/{id}', [self::class, 'update'], 'devices.write');
        $router->delete('/devices/{id}', [self::class, 'destroy'], 'devices.delete');
        $router->post('/devices/{id}/reassign-barcode', [self::class, 'reassignBarcode'], 'devices.write');
    }

    public static function index(Request $request): never
    {
        $auth       = $request->auth;
        $pagination = Util::pagination($request->query);

        $result = Devices::list((int) $auth['organizationId'], [
            'status'    => $request->queryParam('status'),
            'category'  => $request->queryParam('category'),
            'location'  => $request->queryParam('location'),
            'programId' => $request->queryParam('program_id'),
            'search'    => $request->queryParam('search'),
            'overdue'   => $request->queryParam('overdue'),
        ], [
            'limit'  => $pagination['limit'],
            'offset' => $pagination['offset'],
            'sort'   => $request->queryParam('sort'),
        ]);

        Response::json(Util::paged(
            Devices::redactHolders($auth, $result['rows']),
            $result['total'],
            $pagination,
        ));
    }

    public static function facets(Request $request): never
    {
        Response::json(Devices::facets((int) $request->auth['organizationId']));
    }

    public static function show(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $device         = Devices::get($organizationId, (int) $request->param('id'));

        if ($device === null) {
            throw Util::notFound('That device does not exist.');
        }

        Response::json([
            'device'      => Devices::redactHolders($request->auth, [$device])[0],
            'accessories' => Kits::accessories($organizationId, (int) $device['id']),
            // The device screen is built around this. A counselor gets the
            // loans on their own caseload, the same as the loans list.
            'loan_history' => \Loaner\Loans::list($organizationId, array_filter([
                'deviceId'    => (int) $device['id'],
                'counselorId' => Auth::ownRecordsOnly($request->auth),
            ], static fn ($v): bool => $v !== null), ['limit' => 100, 'offset' => 0])['rows'],
            'waitlist'    => Reservations::visibleOnly(
                $request->auth,
                Reservations::forDevice($organizationId, (int) $device['id']),
            ),
            // The audit trail has its own permission, and it names people.
            'history'     => in_array('audit.read', $request->auth['capabilities'] ?? [], true)
                ? Audit::search($organizationId, [
                    'entityType' => 'device',
                    'entityId'   => (int) $device['id'],
                ], 20)['rows']
                : [],
        ]);
    }

    /** Resolve a scanned or typed code. Used by the scan station and the API. */
    public static function lookup(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $code           = (string) $request->param('code');

        $device = \Loaner\Loans::resolveDevice($organizationId, $code);

        if ($device === null) {
            throw Util::notFound("No device matches \"{$code}\".");
        }

        Response::json(['device' => Devices::redactHolders(
            $request->auth,
            [Devices::get($organizationId, (int) $device['id'])],
        )[0]]);
    }

    public static function create(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $body           = $request->body();

        $data = [
            // boundedStr, not str: an identifier quietly trimmed to fit no
            // longer matches the label on the device, and the importer matches
            // on these values.
            'barcode'          => Util::boundedStr($body['barcode'] ?? null, 'barcode', 64) ?: null,
            'asset_tag'        => Util::boundedStr($body['asset_tag'] ?? $body['assetTag'] ?? null,
                'asset_tag', 64) ?: null,
            'serial_number'    => Util::boundedStr($body['serial_number'] ?? $body['serialNumber'] ?? null,
                'serial_number', 128) ?: null,
            'name'             => Util::requiredStr($body['name'] ?? null, 'name', 190),
            'category'         => Util::boundedStr($body['category'] ?? null, 'category', 96),
            'manufacturer'     => Util::boundedStr($body['manufacturer'] ?? null, 'manufacturer', 120),
            'model'            => Util::boundedStr($body['model'] ?? null, 'model', 120),
            'description'      => Util::str($body['description'] ?? null),
            'status'           => Util::oneOf($body['status'] ?? 'available', Devices::STATUSES, 'status', true),
            'condition_note'   => Util::boundedStr($body['condition_note'] ?? $body['conditionNote'] ?? null,
                'condition_note', 190),
            'location'         => Util::boundedStr($body['location'] ?? null, 'location', 190),
            'home_location'    => Util::boundedStr($body['home_location'] ?? $body['homeLocation'] ?? null,
                'home_location', 190),
            'owner_program_id' => $body['owner_program_id'] ?? $body['ownerProgramId'] ?? null,
            'purchase_date'    => empty($body['purchase_date'] ?? $body['purchaseDate'] ?? null)
                ? null : Util::dateOnly($body['purchase_date'] ?? $body['purchaseDate'], 'purchase_date'),
            'purchase_cost'    => ($body['purchase_cost'] ?? $body['purchaseCost'] ?? null) === null
                || ($body['purchase_cost'] ?? $body['purchaseCost'] ?? '') === ''
                ? null : Util::decimal($body['purchase_cost'] ?? $body['purchaseCost'], 'purchase_cost'),
            'warranty_expires' => empty($body['warranty_expires'] ?? $body['warrantyExpires'] ?? null)
                ? null : Util::dateOnly($body['warranty_expires'] ?? $body['warrantyExpires'], 'warranty_expires'),
            'funding_source'   => Util::boundedStr($body['funding_source'] ?? $body['fundingSource'] ?? null,
                'funding_source', 120),
            'notes'            => Util::str($body['notes'] ?? null),
            'item_type'        => Util::oneOf($body['item_type'] ?? $body['itemType'] ?? 'device',
                Devices::ITEM_TYPES, 'item_type', true),
            'seats_total'      => Util::int($body['seats_total'] ?? $body['seatsTotal'] ?? 1,
                'seats_total', 1, 10000) ?? 1,
            'licence_key'      => Util::str($body['licence_key'] ?? $body['licenceKey'] ?? null, 255),
            'licence_expires'  => empty($body['licence_expires'] ?? $body['licenceExpires'] ?? null)
                ? null
                : Util::dateOnly($body['licence_expires'] ?? $body['licenceExpires'], 'licence_expires'),
            'site_id'          => $body['site_id'] ?? $body['siteId'] ?? null,
        ];

        $organization = Settings::organization($organizationId);

        try {
            $device = Devices::create(
                Audit::actor($request),
                $organizationId,
                $data,
                (string) ($organization['barcode_prefix'] ?? 'LP'),
            );
        } catch (\Throwable $e) {
            throw Devices::translateDuplicate($e);
        }

        if (array_key_exists('accessories', $body) && is_array($body['accessories'])) {
            Kits::setAccessories(Audit::actor($request), $organizationId, (int) $device['id'], $body['accessories']);
            $device = Devices::get($organizationId, (int) $device['id']);
        }

        Response::json(['device' => $device], 201);
    }

    public static function update(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $deviceId       = (int) $request->param('id');

        $device = Devices::update(Audit::actor($request), $organizationId, $deviceId, $request->body());

        Response::json(['device' => $device]);
    }

    public static function destroy(Request $request): never
    {
        $result = Devices::delete(
            Audit::actor($request),
            (int) $request->auth['organizationId'],
            (int) $request->param('id'),
        );

        Response::json($result);
    }

    public static function reassignBarcode(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $organization   = Settings::organization($organizationId);

        $device = Devices::reassignBarcode(
            Audit::actor($request),
            $organizationId,
            (int) $request->param('id'),
            (string) ($organization['barcode_prefix'] ?? 'LP'),
        );

        Response::json([
            'device' => $device,
            'notice' => 'The old label no longer matches this device. Print and apply the new one before '
                      . 'putting it back on the shelf.',
        ]);
    }

    public static function backfill(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $organization   = Settings::organization($organizationId);

        Response::json(Devices::backfillBarcodes(
            Audit::actor($request),
            $organizationId,
            (string) ($organization['barcode_prefix'] ?? 'LP'),
        ));
    }

    // -----------------------------------------------------------------------
    // Barcodes and labels
    // -----------------------------------------------------------------------

    public static function barcodeSvg(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $device         = Devices::get($organizationId, (int) $request->param('id'));

        if ($device === null) {
            throw Util::notFound('That device does not exist.');
        }

        $organization = Settings::organization($organizationId);
        $symbology    = Util::oneOf(
            $request->queryParam('symbology') ?? $organization['barcode_symbology'] ?? 'qr',
            Barcode::SYMBOLOGIES,
            'symbology',
            true,
        );

        Response::svg(Barcode::render((string) $device['barcode'], $symbology, [
            'size'   => (int) ($request->queryParam('size') ?? 180),
            'height' => (int) ($request->queryParam('height') ?? 60),
            'title'  => 'Barcode for ' . $device['name'],
        ]));
    }

    /**
     * A printable label sheet.
     *
     * Returns HTML rather than a PDF: every browser can print it, the sizes
     * are set in millimetres so they come out correct on real label stock, and
     * nothing has to be installed on the server.
     */
    public static function labels(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $organization   = Settings::organization($organizationId);

        $ids = array_values(array_filter(array_map(
            'intval',
            explode(',', (string) ($request->queryParam('ids') ?? '')),
        )));

        if ($ids !== []) {
            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $devices = \Loaner\Db::all(
                "SELECT id, barcode, name, asset_tag, category FROM devices
                  WHERE organization_id = ? AND id IN ({$placeholders}) ORDER BY name",
                array_merge([$organizationId], $ids),
            );
        } else {
            $devices = \Loaner\Db::all(
                'SELECT id, barcode, name, asset_tag, category FROM devices
                  WHERE organization_id = ? AND status <> "retired" ORDER BY name LIMIT 1000',
                [$organizationId],
            );
        }

        if ($devices === []) {
            throw Util::notFound('There are no devices to print labels for.');
        }

        Response::html(Barcode::labelSheet($devices, [
            // Validated, because the sheet prints this value back into the page.
            'symbology'    => Util::oneOf(
                $request->queryParam('symbology') ?? $organization['barcode_symbology'] ?? 'qr',
                Barcode::SYMBOLOGIES,
                'symbology',
                true,
            ),
            'orgName'      => $organization['name'] ?? '',
            // The organisation's usual stock unless this sheet asks for another.
            'stock'        => Util::oneOf(
                $request->queryParam('stock') ?? Settings::get($organizationId, 'labels.stock'),
                array_keys(Barcode::LABEL_STOCKS),
                'stock',
                true,
            ),
            'skip'         => Util::int($request->queryParam('skip') ?? 0, 'skip', 0, 79) ?? 0,
            'query'        => [
                'ids'       => $request->queryParam('ids'),
                'symbology' => $request->queryParam('symbology'),
            ],
        ]));
    }

    // -----------------------------------------------------------------------
    // Import and export
    // -----------------------------------------------------------------------

    public static function template(Request $request): never
    {
        Response::csv(Csv::template(), 'device-import-template.csv');
    }

    public static function importPreview(Request $request): never
    {
        $content = $request->input('content');

        if (!is_string($content) || trim($content) === '') {
            throw Util::badRequest(
                'The file appears to be empty. Save it as CSV from your spreadsheet and try again.',
                ['field' => 'content'],
            );
        }

        Response::json(Devices::previewImport($content, $request->input('delimiter')));
    }

    public static function import(Request $request): never
    {
        $body    = $request->body();
        $content = $body['content'] ?? null;

        if (!is_string($content) || trim($content) === '') {
            throw Util::badRequest('No spreadsheet content was supplied.', ['field' => 'content']);
        }

        $organizationId = (int) $request->auth['organizationId'];
        $organization   = Settings::organization($organizationId);

        $result = Devices::import(Audit::actor($request), [
            'organizationId' => $organizationId,
            'text'           => $content,
            'delimiter'      => $body['delimiter'] ?? null,
            'mapping'        => $body['mapping'] ?? null,
            'ignoreHeaders'  => $body['ignore_headers'] ?? $body['ignoreHeaders'] ?? [],
            'defaultStatus'  => Util::oneOf(
                $body['default_status'] ?? $body['defaultStatus'] ?? 'available',
                Devices::STATUSES, 'default_status', true,
            ),
            'filename'       => Util::str($body['filename'] ?? null, 255),
            'dryRun'         => Util::bool($body['dry_run'] ?? $body['dryRun'] ?? false),
            'updateExisting' => Util::bool($body['update_existing'] ?? $body['updateExisting'] ?? true, true),
            'barcodePrefix'  => (string) ($organization['barcode_prefix'] ?? 'LP'),
            'actorId'        => $request->auth['userId'] ?? null,
        ]);

        Response::json($result);
    }

    public static function importHistory(Request $request): never
    {
        Response::json(Util::collection(
            Devices::importHistory((int) $request->auth['organizationId']),
        ));
    }

    public static function exportCsv(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];

        $result = Devices::list($organizationId, [
            'status'   => $request->queryParam('status'),
            'category' => $request->queryParam('category'),
            'search'   => $request->queryParam('search'),
        ], ['limit' => 10000, 'offset' => 0, 'sort' => 'name']);

        // Field names rather than prose headings: this file is what people
        // hand back to the importer, and the importer matches these spellings.
        $csv = Util::toCsv(
            ['barcode', 'asset_tag', 'serial_number', 'name', 'category', 'manufacturer', 'model',
             'status', 'condition', 'location', 'home_location', 'program', 'purchase_date',
             'purchase_cost', 'warranty_expires', 'funding_source', 'on_loan', 'due_back', 'notes'],
            array_map(static fn (array $d): array => [
                $d['barcode'], $d['asset_tag'], $d['serial_number'], $d['name'], $d['category'],
                $d['manufacturer'], $d['model'], $d['status'], $d['condition_note'], $d['location'],
                $d['home_location'], $d['program_name'], $d['purchase_date'], $d['purchase_cost'],
                $d['warranty_expires'], $d['funding_source'],
                $d['active_loan_reference'] ?? '', $d['active_loan_due_at'] ?? '', $d['notes'],
            ], $result['rows']),
        );

        Response::csv($csv, 'devices-' . date('Y-m-d') . '.csv');
    }
}
