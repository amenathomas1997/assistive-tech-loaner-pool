<?php
/**
 * Spreadsheet import for clients.
 *
 * The same two-phase shape as the device import, for the same reason: a dry
 * run reports precisely what would happen and writes nothing, and only an
 * explicit second call commits. An import run against the wrong file is the
 * mistake people actually make, and there is no undo for 400 rows.
 *
 * Matching is on the agency's own reference first. A VR agency already has an
 * identifier for every participant, and matching on name would merge two
 * different people who happen to share one — a mistake that is very hard to
 * notice and worse than a duplicate.
 */

declare(strict_types=1);

namespace Loaner;

final class ClientImport
{
    private const MAX_ROWS = 20000;

    /** Parse and propose a mapping without touching the database. */
    public static function preview(string $text, ?string $delimiter = null): array
    {
        ['headers' => $headers, 'records' => $records] = Csv::toRecords($text, $delimiter);

        if (count($records) > self::MAX_ROWS) {
            throw Util::badRequest(
                'That file has ' . count($records) . ' rows, which is over the ' . self::MAX_ROWS
                . ' row limit. Split it into smaller files.',
            );
        }

        ['mapping' => $mapping, 'unmapped' => $unmapped] = Csv::suggestClientMapping($headers);

        return [
            'row_count'         => count($records),
            'headers'           => $headers,
            'suggested_mapping' => $mapping,
            'unmapped_headers'  => $unmapped,
            'importable_fields' => array_keys(Csv::CLIENT_ALIASES),
            'sample_rows'       => array_slice($records, 0, 5),
        ];
    }

    /**
     * Run the import.
     *
     * @return array{dry_run: bool, ...}
     */
    public static function import(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $dryRun         = (bool) ($input['dryRun'] ?? true);
        $updateExisting = (bool) ($input['updateExisting'] ?? true);

        // A counselor's import stays inside their own caseload: every row is
        // theirs, and a row matching somebody else's client is refused. Matching
        // is by a reference anyone can type, so without this one line of a
        // spreadsheet could rewrite any client in the system.
        $counselor = isset($input['restrictToCounselor']) ? (int) $input['restrictToCounselor'] : null;

        ['headers' => $headers, 'records' => $records]
            = Csv::toRecords($input['text'], $input['delimiter'] ?? null);

        if ($records === []) {
            throw Util::badRequest('That file has a header row but no data rows.');
        }
        if (count($records) > self::MAX_ROWS) {
            throw Util::badRequest('That file has ' . count($records) . ' rows, over the limit.');
        }

        $mapping = is_array($input['mapping'] ?? null)
            ? $input['mapping']
            : Csv::suggestClientMapping($headers)['mapping'];
        $fields  = array_values($mapping);

        // A client needs a name. Without one there is nothing to show on a loan
        // and nothing a technician could search for.
        if (!in_array('last_name', $fields, true)) {
            throw Util::badRequest(
                'Map a column to "last_name" so each person can be identified. Without a name there '
                . 'is nothing to show against a loan.',
                ['mapped_fields' => $fields],
            );
        }

        // Counselors and programs are resolved once, by name, code or email —
        // a spreadsheet will use whichever the person exporting it had.
        $counselors = [];
        foreach (Db::all(
            'SELECT id, full_name, email FROM users WHERE organization_id = ? AND active = 1',
            [$organizationId],
        ) as $user) {
            $counselors[mb_strtolower($user['full_name'])] = (int) $user['id'];
            $counselors[mb_strtolower($user['email'])]     = (int) $user['id'];
        }

        $programs = [];
        foreach (Db::all(
            'SELECT id, name, code FROM programs WHERE organization_id = ?',
            [$organizationId],
        ) as $program) {
            $programs[mb_strtolower($program['name'])] = (int) $program['id'];
            if (!empty($program['code'])) {
                $programs[mb_strtolower($program['code'])] = (int) $program['id'];
            }
        }

        $plan     = [];
        $errors   = [];
        $seenRefs = [];

        foreach ($records as $record) {
            $line   = (int) ($record['__line'] ?? 0);
            $client = [];

            foreach ($mapping as $header => $field) {
                $value = trim((string) ($record[$header] ?? ''));
                if ($value !== '') {
                    $client[$field] = $value;
                }
            }

            $last = $client['last_name'] ?? null;

            if ($last === null) {
                $errors[] = ['line' => $line, 'error' => 'No last name on this row.'];
                continue;
            }

            // A reference that repeats inside one file is a problem with the
            // file, and importing it would silently keep only the last row.
            $ref = $client['external_ref'] ?? null;
            if ($ref !== null) {
                if (isset($seenRefs[$ref])) {
                    $errors[] = [
                        'line'  => $line,
                        'error' => "Reference \"{$ref}\" also appears on line {$seenRefs[$ref]} of this file.",
                    ];
                    continue;
                }
                $seenRefs[$ref] = $line;
            }

            if (isset($client['email'])) {
                try {
                    $client['email'] = Util::email($client['email'], 'email');
                } catch (\Throwable $e) {
                    // Not fatal: a bad address should not cost the agency the
                    // rest of the record. Dropped, and reported.
                    $errors[] = ['line' => $line, 'error' => 'Email address ignored: '
                                . $client['email'] . ' is not a valid address.'];
                    unset($client['email']);
                }
            }

            // Names are resolved to ids here so the commit phase does no
            // lookups and an unknown name is reported before anything is written.
            if (isset($client['counselor'])) {
                $key = mb_strtolower($client['counselor']);
                if (isset($counselors[$key])) {
                    $client['counselor_id'] = $counselors[$key];
                } else {
                    $errors[] = ['line' => $line, 'error' => 'No staff member called "'
                                . $client['counselor'] . '" — the client will be imported unassigned.'];
                }
                unset($client['counselor']);
            }

            if (isset($client['program'])) {
                $key = mb_strtolower($client['program']);
                if (isset($programs[$key])) {
                    $client['program_id'] = $programs[$key];
                } else {
                    $errors[] = ['line' => $line, 'error' => 'No program called "'
                                . $client['program'] . '" — the client will be imported without one.'];
                }
                unset($client['program']);
            }

            $existing = self::findExisting($organizationId, $client);

            if ($counselor !== null) {
                if ($existing !== null && (int) $existing['counselor_id'] !== $counselor) {
                    $errors[] = ['line' => $line, 'error' => 'That reference belongs to a client who is not '
                                . 'on your caseload, so this row was left out.'];
                    continue;
                }
                $client['counselor_id'] = $counselor;
            }

            $plan[] = [
                'line'     => $line,
                'action'   => $existing === null ? 'create' : ($updateExisting ? 'update' : 'skip'),
                'client'   => $client,
                'existing_id' => $existing['id'] ?? null,
                'name'     => trim(($client['first_name'] ?? '') . ' ' . $last),
            ];
        }

        $toCreate = count(array_filter($plan, static fn ($p) => $p['action'] === 'create'));
        $toUpdate = count(array_filter($plan, static fn ($p) => $p['action'] === 'update'));
        $toSkip   = count(array_filter($plan, static fn ($p) => $p['action'] === 'skip'));

        if ($dryRun) {
            return [
                'dry_run'       => true,
                'row_count'     => count($records),
                'to_create'     => $toCreate,
                'to_update'     => $toUpdate,
                'to_skip'       => $toSkip,
                'error_count'   => count($errors),
                'errors'        => array_slice($errors, 0, 50),
                'plan'          => array_slice($plan, 0, 25),
                'column_mapping' => $mapping,
                'notice'        => 'Nothing has been saved. Check the rows above, then import for real.',
            ];
        }

        $created = 0;
        $updated = 0;
        $skipped = 0;

        Db::transaction(static function () use (
            $plan, $organizationId, &$created, &$updated, &$skipped, &$errors
        ): void {
            foreach ($plan as $row) {
                if ($row['action'] === 'skip') {
                    $skipped++;
                    continue;
                }

                $client = $row['client'];

                try {
                    if ($row['action'] === 'create') {
                        Db::execute(
                            'INSERT INTO clients
                               (organization_id, external_ref, case_number, first_name, last_name,
                                email, phone, mobile, counselor_id, program_id, notes, active)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
                            [
                                $organizationId,
                                $client['external_ref'] ?? null, $client['case_number'] ?? null,
                                $client['first_name'] ?? '', $client['last_name'],
                                $client['email'] ?? null, $client['phone'] ?? null,
                                $client['mobile'] ?? null,
                                $client['counselor_id'] ?? null, $client['program_id'] ?? null,
                                $client['notes'] ?? null,
                            ],
                        );
                        $created++;
                    } else {
                        // Only the columns actually present in the file are
                        // written. A spreadsheet with three columns must not
                        // blank out the other seven.
                        $sets   = [];
                        $params = [];

                        foreach (['case_number', 'first_name', 'last_name', 'email', 'phone',
                                  'mobile', 'counselor_id', 'program_id', 'notes'] as $column) {
                            if (array_key_exists($column, $client)) {
                                $sets[]   = "{$column} = ?";
                                $params[] = $client[$column];
                            }
                        }

                        if ($sets !== []) {
                            $sets[]   = 'updated_at = NOW()';
                            $params[] = $row['existing_id'];
                            $params[] = $organizationId;

                            Db::execute(
                                'UPDATE clients SET ' . implode(', ', $sets)
                                . ' WHERE id = ? AND organization_id = ?',
                                $params,
                            );
                        }
                        $updated++;
                    }
                } catch (\Throwable $e) {
                    $errors[] = [
                        'line'  => $row['line'],
                        'error' => Db::isDuplicate($e)
                            ? 'Another client already uses that reference number.'
                            : 'Could not be saved.',
                    ];
                }
            }
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::CLIENT_IMPORTED,
            'entityType'     => 'client',
            'summary'        => sprintf(
                'Imported clients from %s: %d created, %d updated, %d skipped, %d error(s)',
                $input['filename'] ?? 'a spreadsheet', $created, $updated, $skipped, count($errors),
            ),
            'detail' => ['created' => $created, 'updated' => $updated, 'skipped' => $skipped],
        ]);

        return [
            'dry_run'       => false,
            'row_count'     => count($records),
            'created_count' => $created,
            'updated_count' => $updated,
            'skipped_count' => $skipped,
            'error_count'   => count($errors),
            'errors'        => array_slice($errors, 0, 50),
            'column_mapping' => $mapping,
        ];
    }

    /**
     * Find the client this row refers to, if any.
     *
     * Reference first, then case number. Never by name: two different people
     * called J. Smith would be merged into one, and nobody would notice until
     * a loan appeared on the wrong record.
     */
    private static function findExisting(int $organizationId, array $client): ?array
    {
        // external_ref only. It is unique per organisation, which is what
        // makes it safe to match on.
        //
        // case_number is deliberately NOT used. It has no unique constraint
        // and a vocational rehabilitation case can cover more than one
        // participant, so matching on it merges two different people and one
        // silently overwrites the other — the same failure this function's
        // refusal to match on names exists to prevent.
        if (empty($client['external_ref'])) {
            return null;
        }

        return Db::one(
            'SELECT id, counselor_id FROM clients WHERE organization_id = ? AND external_ref = ?',
            [$organizationId, $client['external_ref']],
        );
    }
}
