<?php
/**
 * Clients, programs and staff accounts.
 *
 * Grouped together because they are all "people and places a loan can be
 * attached to", and all three are small CRUD surfaces with the same shape.
 *
 * Nothing here is ever hard-deleted. A client row is referenced by loans
 * going back years; removing it would silently rewrite history. Records are
 * deactivated instead, which takes them out of the pickers while leaving the
 * audit trail intact.
 */

declare(strict_types=1);

namespace Loaner;

final class Directory
{
    // -----------------------------------------------------------------------
    // Clients
    // -----------------------------------------------------------------------

    private const CLIENT_SELECT = '
        SELECT c.*,
               u.full_name AS counselor_name, u.email AS counselor_email,
               p.name AS program_name,
               (SELECT COUNT(*) FROM loans l WHERE l.client_id = c.id) AS loan_count,
               (SELECT COUNT(*) FROM loans l WHERE l.client_id = c.id AND l.status = "active")
                   AS active_loan_count,
               (SELECT COUNT(*) FROM loans l
                 WHERE l.client_id = c.id AND l.status = "active"
                   AND l.due_at IS NOT NULL AND l.due_at < NOW()) AS overdue_loan_count
          FROM clients c
          LEFT JOIN users u ON u.id = c.counselor_id
          LEFT JOIN programs p ON p.id = c.program_id';

    public static function client(int $organizationId, int $clientId): ?array
    {
        $row = Db::one(
            self::CLIENT_SELECT . ' WHERE c.id = ? AND c.organization_id = ?',
            [$clientId, $organizationId],
        );

        if ($row === null) {
            return null;
        }

        $row = self::decorateClient($row);

        $row['loans'] = Loans::list($organizationId, ['clientId' => $clientId], ['limit' => 25])['rows'];

        return $row;
    }

    private static function decorateClient(array $row): array
    {
        $row['full_name']          = $row['first_name'] . ' ' . $row['last_name'];
        $row['loan_count']         = (int) $row['loan_count'];
        $row['active_loan_count']  = (int) $row['active_loan_count'];
        $row['overdue_loan_count'] = (int) $row['overdue_loan_count'];

        return $row;
    }

    public static function clients(int $organizationId, array $filters = [], array $options = []): array
    {
        $limit  = (int) ($options['limit'] ?? 50);
        $offset = (int) ($options['offset'] ?? 0);

        $where  = ['c.organization_id = ?'];
        $params = [$organizationId];

        if (empty($filters['includeInactive'])) {
            $where[] = 'c.active = 1';
        }
        if (!empty($filters['counselorId'])) {
            $where[]  = 'c.counselor_id = ?';
            $params[] = $filters['counselorId'];
        }
        if (!empty($filters['programId'])) {
            $where[]  = 'c.program_id = ?';
            $params[] = $filters['programId'];
        }
        if (!empty($filters['search'])) {
            $where[] = '(c.first_name LIKE ? OR c.last_name LIKE ? '
                     . 'OR CONCAT(c.first_name, " ", c.last_name) LIKE ? '
                     . 'OR c.email LIKE ? OR c.external_ref LIKE ?)';
            $like = '%' . $filters['search'] . '%';
            array_push($params, $like, $like, $like, $like, $like);
        }

        $whereSql = implode(' AND ', $where);

        $order = Util::orderBy($options['sort'] ?? null, [
            'name'       => 'c.last_name, c.first_name',
            'created_at' => 'c.created_at',
            'loans'      => 'loan_count',
        ], 'c.last_name, c.first_name');

        $rows = Db::all(
            self::CLIENT_SELECT . " WHERE {$whereSql} ORDER BY {$order} LIMIT {$limit} OFFSET {$offset}",
            $params,
        );

        $total = (int) Db::value("SELECT COUNT(*) FROM clients c WHERE {$whereSql}", $params);

        return ['rows' => array_map([self::class, 'decorateClient'], $rows), 'total' => $total];
    }

    public static function createClient(?array $actor, int $organizationId, array $input): array
    {
        $first = Util::requiredStr($input['first_name'] ?? $input['firstName'] ?? null, 'first_name', 120);
        $last  = Util::requiredStr($input['last_name'] ?? $input['lastName'] ?? null, 'last_name', 120);

        try {
            $id = Db::insert(
                'INSERT INTO clients
                   (organization_id, external_ref, case_number, first_name, last_name, email,
                    phone, mobile, sms_opt_in, counselor_id, program_id, notes, active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    $organizationId,
                    Util::str($input['external_ref'] ?? $input['externalRef'] ?? null, 64) ?: null,
                    Util::str($input['case_number'] ?? $input['caseNumber'] ?? null, 64) ?: null,
                    $first, $last,
                    Util::email($input['email'] ?? null, 'email'),
                    Util::str($input['phone'] ?? null, 40),
                    Util::str($input['mobile'] ?? null, 40),
                    // Consent is explicit: holding a mobile number is not
                    // permission to text it.
                    Util::bool($input['sms_opt_in'] ?? $input['smsOptIn'] ?? false) ? 1 : 0,
                    $input['counselor_id'] ?? $input['counselorId'] ?? null,
                    $input['program_id'] ?? $input['programId'] ?? null,
                    Util::str($input['notes'] ?? null),
                    Util::bool($input['active'] ?? true, true) ? 1 : 0,
                ],
            );
        } catch (\Throwable $e) {
            if (Db::isDuplicate($e)) {
                throw Util::conflict(
                    'Another client already has that reference number.',
                    ['field' => 'external_ref'],
                );
            }
            throw $e;
        }

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::CLIENT_CREATED,
            'entityType'     => 'client',
            'entityId'       => $id,
            'entityLabel'    => "{$first} {$last}",
            'summary'        => "Client {$first} {$last} added",
        ]);

        return self::client($organizationId, $id);
    }

    /**
     * Refuse a counselor naming a client outside their caseload.
     *
     * The response to creating a request or waitlist entry echoes the client's
     * name, so accepting any id would be a way of reading any client. Answered
     * the way a missing client is answered, so it does not confirm one exists.
     */
    public static function assertInCaseload(?array $auth, mixed $clientId): void
    {
        $counselor = Auth::ownRecordsOnly($auth);

        if ($counselor === null || empty($clientId)) {
            return;
        }

        $mine = is_scalar($clientId) && ctype_digit((string) $clientId)
            ? Db::value('SELECT id FROM clients WHERE id = ? AND counselor_id = ?', [$clientId, $counselor])
            : null;

        if ($mine === null) {
            throw Util::badRequest('That client does not exist.', ['field' => 'client_id']);
        }
    }

    public static function updateClient(?array $actor, int $organizationId, int $clientId, array $input): array
    {
        $before = self::client($organizationId, $clientId);
        if ($before === null) {
            throw Util::notFound('That client does not exist.');
        }

        $sets   = [];
        $params = [];

        $map = [
            'first_name'   => ['first_name', 120],
            'firstName'    => ['first_name', 120],
            'last_name'    => ['last_name', 120],
            'lastName'     => ['last_name', 120],
            'phone'        => ['phone', 40],
            'mobile'       => ['mobile', 40],
            'external_ref' => ['external_ref', 64],
            'externalRef'  => ['external_ref', 64],
            'case_number'  => ['case_number', 64],
            'caseNumber'   => ['case_number', 64],
            'notes'        => ['notes', null],
        ];

        foreach ($map as $key => [$column, $max]) {
            if (array_key_exists($key, $input)) {
                $sets[]   = "{$column} = ?";
                $params[] = $max === null ? Util::str($input[$key]) : Util::str($input[$key], $max);
            }
        }

        if (array_key_exists('email', $input)) {
            $sets[]   = 'email = ?';
            $params[] = Util::email($input['email'], 'email');
        }
        foreach ([['counselor_id', 'counselorId', 'users', 'counselor'],
                  ['program_id', 'programId', 'programs', 'program']] as [$column, $camel, $table, $label]) {
            foreach ([$column, $camel] as $key) {
                if (array_key_exists($key, $input)) {
                    Loans::assertBelongs($table, $input[$key], $organizationId, $label);
                    $sets[]   = "{$column} = ?";
                    $params[] = $input[$key] ?: null;
                    break;
                }
            }
        }
        if (array_key_exists('active', $input)) {
            $sets[]   = 'active = ?';
            $params[] = Util::bool($input['active']) ? 1 : 0;
        }

        foreach (['sms_opt_in', 'smsOptIn'] as $key) {
            if (array_key_exists($key, $input)) {
                $sets[]   = 'sms_opt_in = ?';
                $params[] = Util::bool($input[$key]) ? 1 : 0;
                break;
            }
        }

        if ($sets === []) {
            return $before;
        }

        $sets[]   = 'updated_at = NOW()';
        $params[] = $clientId;
        $params[] = $organizationId;

        try {
            Db::execute(
                'UPDATE clients SET ' . implode(', ', $sets) . ' WHERE id = ? AND organization_id = ?',
                $params,
            );
        } catch (\Throwable $e) {
            if (Db::isDuplicate($e)) {
                throw Util::conflict('Another client already has that reference number.',
                    ['field' => 'external_ref']);
            }
            throw $e;
        }

        $after = self::client($organizationId, $clientId);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::CLIENT_UPDATED,
            'entityType'     => 'client',
            'entityId'       => $clientId,
            'entityLabel'    => $after['full_name'],
            'summary'        => "Client {$after['full_name']} updated",
            'detail'         => Audit::diff($before, $after, [
                'first_name', 'last_name', 'email', 'phone', 'mobile', 'external_ref',
                'case_number', 'sms_opt_in', 'counselor_id', 'program_id', 'active',
            ]),
        ]);

        return $after;
    }

    // -----------------------------------------------------------------------
    // Programs
    // -----------------------------------------------------------------------

    public static function programs(int $organizationId, bool $includeInactive = false): array
    {
        return Db::all(
            'SELECT p.*,
                    (SELECT COUNT(*) FROM loans l WHERE l.program_id = p.id) AS loan_count,
                    (SELECT COUNT(*) FROM loans l WHERE l.program_id = p.id AND l.status = "active")
                        AS active_loan_count,
                    (SELECT COUNT(*) FROM devices d WHERE d.owner_program_id = p.id) AS device_count,
                    (SELECT COUNT(*) FROM clients c WHERE c.program_id = p.id AND c.active = 1)
                        AS client_count
               FROM programs p
              WHERE p.organization_id = ?' . ($includeInactive ? '' : ' AND p.active = 1') . '
              ORDER BY p.name',
            [$organizationId],
        );
    }

    public static function program(int $organizationId, int $programId): ?array
    {
        return Db::one(
            'SELECT * FROM programs WHERE id = ? AND organization_id = ?',
            [$programId, $organizationId],
        );
    }

    public static function createProgram(?array $actor, int $organizationId, array $input): array
    {
        $name = Util::requiredStr($input['name'] ?? null, 'name', 190);

        try {
            $id = Db::insert(
                'INSERT INTO programs
                   (organization_id, name, code, description, contact_email, default_loan_days, active)
                 VALUES (?, ?, ?, ?, ?, ?, ?)',
                [
                    $organizationId, $name,
                    Util::str($input['code'] ?? null, 40) ?: null,
                    Util::str($input['description'] ?? null),
                    Util::email($input['contact_email'] ?? $input['contactEmail'] ?? null, 'contact_email'),
                    Util::int($input['default_loan_days'] ?? $input['defaultLoanDays'] ?? null,
                        'default_loan_days', 0, 3650),
                    Util::bool($input['active'] ?? true, true) ? 1 : 0,
                ],
            );
        } catch (\Throwable $e) {
            if (Db::isDuplicate($e)) {
                throw Util::conflict(
                    sprintf('A program with the code "%s" already exists.', (string) ($input['code'] ?? '')),
                    ['field' => 'code'],
                );
            }
            throw $e;
        }

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::PROGRAM_CREATED,
            'entityType'     => 'program',
            'entityId'       => $id,
            'entityLabel'    => $name,
            'summary'        => "Program \"{$name}\" added",
        ]);

        return self::program($organizationId, $id);
    }

    public static function updateProgram(?array $actor, int $organizationId, int $programId, array $input): array
    {
        $before = self::program($organizationId, $programId);
        if ($before === null) {
            throw Util::notFound('That program does not exist.');
        }

        $sets   = [];
        $params = [];

        if (array_key_exists('name', $input)) {
            $sets[]   = 'name = ?';
            $params[] = Util::requiredStr($input['name'], 'name', 190);
        }
        if (array_key_exists('code', $input)) {
            $sets[]   = 'code = ?';
            $params[] = Util::str($input['code'], 40) ?: null;
        }
        if (array_key_exists('description', $input)) {
            $sets[]   = 'description = ?';
            $params[] = Util::str($input['description']);
        }
        foreach (['contact_email', 'contactEmail'] as $key) {
            if (array_key_exists($key, $input)) {
                $sets[]   = 'contact_email = ?';
                $params[] = Util::email($input[$key], 'contact_email');
                break;
            }
        }
        foreach (['default_loan_days', 'defaultLoanDays'] as $key) {
            if (array_key_exists($key, $input)) {
                $sets[]   = 'default_loan_days = ?';
                $params[] = Util::int($input[$key], 'default_loan_days', 0, 3650);
                break;
            }
        }
        if (array_key_exists('active', $input)) {
            $sets[]   = 'active = ?';
            $params[] = Util::bool($input['active']) ? 1 : 0;
        }

        if ($sets === []) {
            return $before;
        }

        $params[] = $programId;
        $params[] = $organizationId;

        try {
            Db::execute(
                'UPDATE programs SET ' . implode(', ', $sets) . ' WHERE id = ? AND organization_id = ?',
                $params,
            );
        } catch (\Throwable $e) {
            if (Db::isDuplicate($e)) {
                throw Util::conflict(
                    sprintf('A program with the code "%s" already exists.', (string) ($input['code'] ?? '')),
                    ['field' => 'code'],
                );
            }
            throw $e;
        }

        $after = self::program($organizationId, $programId);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::PROGRAM_UPDATED,
            'entityType'     => 'program',
            'entityId'       => $programId,
            'entityLabel'    => $after['name'],
            'summary'        => "Program \"{$after['name']}\" updated",
            'detail'         => Audit::diff($before, $after,
                ['name', 'code', 'contact_email', 'default_loan_days', 'active']),
        ]);

        return $after;
    }

    // -----------------------------------------------------------------------
    // Users
    // -----------------------------------------------------------------------

    private const USER_SELECT = '
        SELECT u.id, u.organization_id, u.email, u.full_name, u.role, u.phone, u.employee_ref,
               u.badge_barcode, u.active, u.must_change_password, u.locked_until, u.last_login_at,
               u.created_at, u.updated_at,
               (SELECT COUNT(*) FROM loans l WHERE l.tech_id = u.id AND l.status = "active")
                   AS active_loan_count,
               (SELECT COUNT(*) FROM loan_requests r WHERE r.requested_by = u.id
                 AND r.status IN ("submitted", "approved")) AS open_request_count
          FROM users u';

    public static function user(int $organizationId, int $userId): ?array
    {
        $row = Db::one(
            self::USER_SELECT . ' WHERE u.id = ? AND u.organization_id = ?',
            [$userId, $organizationId],
        );

        return $row === null ? null : self::decorateUser($row);
    }

    private static function decorateUser(array $row): array
    {
        $row['active']               = (bool) $row['active'];
        $row['must_change_password'] = (bool) $row['must_change_password'];
        $row['locked']               = !empty($row['locked_until'])
            && strtotime((string) $row['locked_until']) > time();
        $row['capabilities']         = Auth::capabilitiesForRole($row['role']);
        $row['active_loan_count']    = (int) $row['active_loan_count'];
        $row['open_request_count']   = (int) $row['open_request_count'];

        return $row;
    }

    public static function users(int $organizationId, array $filters = []): array
    {
        $where  = ['u.organization_id = ?'];
        $params = [$organizationId];

        if (empty($filters['includeInactive'])) {
            $where[] = 'u.active = 1';
        }
        if (!empty($filters['role'])) {
            $where[]  = 'u.role = ?';
            $params[] = $filters['role'];
        }
        if (!empty($filters['search'])) {
            $where[] = '(u.full_name LIKE ? OR u.email LIKE ? OR u.employee_ref LIKE ?)';
            $like = '%' . $filters['search'] . '%';
            array_push($params, $like, $like, $like);
        }

        $rows = Db::all(
            self::USER_SELECT . ' WHERE ' . implode(' AND ', $where) . ' ORDER BY u.full_name',
            $params,
        );

        return array_map([self::class, 'decorateUser'], $rows);
    }

    public static function createUser(?array $actor, int $organizationId, array $input): array
    {
        $email    = Util::email($input['email'] ?? null, 'email', true);
        $fullName = Util::requiredStr($input['full_name'] ?? $input['fullName'] ?? null, 'full_name', 190);
        $role     = Util::oneOf($input['role'] ?? 'tech', array_keys(Auth::CAPABILITIES), 'role');
        $password = $input['password'] ?? null;

        // An account with no password cannot be signed in to, and a random one
        // nobody is told is worse than asking for one up front.
        if (!is_string($password) || $password === '') {
            throw Util::badRequest(
                'Set a starting password for this account. The person will be asked to change it when '
                . 'they first sign in.',
                ['field' => 'password'],
            );
        }

        Auth::validatePassword($password);

        try {
            $id = Db::insert(
                'INSERT INTO users
                   (organization_id, email, password_hash, full_name, role, phone, employee_ref,
                    badge_barcode, active, must_change_password)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    $organizationId, $email, Auth::hashPassword($password), $fullName, $role,
                    Util::str($input['phone'] ?? null, 40),
                    Util::str($input['employee_ref'] ?? $input['employeeRef'] ?? null, 64) ?: null,
                    Util::str($input['badge_barcode'] ?? $input['badgeBarcode'] ?? null, 64) ?: null,
                    Util::bool($input['active'] ?? true, true) ? 1 : 0,
                    Util::bool($input['must_change_password'] ?? $input['mustChangePassword'] ?? true, true) ? 1 : 0,
                ],
            );
        } catch (\Throwable $e) {
            if (Db::isDuplicate($e)) {
                throw Util::conflict(
                    str_contains($e->getMessage(), 'badge')
                        ? 'That badge barcode is already assigned to someone else.'
                        : 'An account with that email address already exists.',
                    ['field' => str_contains($e->getMessage(), 'badge') ? 'badge_barcode' : 'email'],
                );
            }
            throw $e;
        }

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::USER_CREATED,
            'entityType'     => 'user',
            'entityId'       => $id,
            'entityLabel'    => $fullName,
            'summary'        => "Account created for {$fullName} ({$email}) as {$role}",
        ]);

        return self::user($organizationId, $id);
    }

    public static function updateUser(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $userId         = (int) $input['userId'];
        $data           = $input['data'] ?? [];
        $auth           = $input['auth'] ?? null;

        $before = self::user($organizationId, $userId);
        if ($before === null) {
            throw Util::notFound('That account does not exist.');
        }

        $sets   = [];
        $params = [];

        foreach ([
            ['full_name', 'fullName', 'full_name', 190],
            ['phone', 'phone', 'phone', 40],
            ['employee_ref', 'employeeRef', 'employee_ref', 64],
            ['badge_barcode', 'badgeBarcode', 'badge_barcode', 64],
        ] as [$snake, $camel, $column, $max]) {
            foreach ([$snake, $camel] as $key) {
                if (array_key_exists($key, $data)) {
                    $sets[]   = "{$column} = ?";
                    $value    = Util::str($data[$key], $max);
                    $params[] = in_array($column, ['employee_ref', 'badge_barcode'], true)
                        ? ($value ?: null) : $value;
                    break;
                }
            }
        }

        if (array_key_exists('email', $data)) {
            $sets[]   = 'email = ?';
            $params[] = Util::email($data['email'], 'email', true);
        }

        if (array_key_exists('role', $data)) {
            $role = Util::oneOf($data['role'], array_keys(Auth::CAPABILITIES), 'role');

            // Two separate traps, both of which lock people out of settings
            // with no way back in through the interface.
            if ($before['role'] === 'admin' && $role !== 'admin') {
                if ((int) ($auth['userId'] ?? 0) === $userId) {
                    throw Util::conflict(
                        'You cannot remove your own administrator role. Ask another administrator to '
                        . 'change it, so there is always someone who can reach the settings.',
                    );
                }

                self::assertNotLastAdmin($organizationId, $userId);
            }

            $sets[]   = 'role = ?';
            $params[] = $role;
        }

        if (array_key_exists('active', $data)) {
            $active = Util::bool($data['active']);

            if (!$active) {
                if ((int) ($auth['userId'] ?? 0) === $userId) {
                    throw Util::badRequest('You cannot deactivate your own account.');
                }
                if ($before['role'] === 'admin') {
                    self::assertNotLastAdmin($organizationId, $userId);
                }
            }

            $sets[]   = 'active = ?';
            $params[] = $active ? 1 : 0;
        }

        if (array_key_exists('unlock', $data) && Util::bool($data['unlock'])) {
            $sets[] = 'locked_until = NULL';
            $sets[] = 'failed_logins = 0';
        }

        if ($sets === []) {
            return $before;
        }

        $sets[]   = 'updated_at = NOW()';
        $params[] = $userId;
        $params[] = $organizationId;

        try {
            Db::execute(
                'UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = ? AND organization_id = ?',
                $params,
            );
        } catch (\Throwable $e) {
            if (Db::isDuplicate($e)) {
                throw Util::conflict(
                    str_contains($e->getMessage(), 'badge')
                        ? 'That badge barcode is already assigned to someone else.'
                        : 'Another account already uses that email address.',
                );
            }
            throw $e;
        }

        $after = self::user($organizationId, $userId);

        // Deactivating an account must end its sessions, or the person stays
        // signed in until their cookie happens to expire.
        if ($before['active'] && !$after['active']) {
            Auth::destroyAllSessionsForUser($userId);
        }

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => $before['active'] && !$after['active']
                ? Audit::USER_DEACTIVATED : Audit::USER_UPDATED,
            'entityType'     => 'user',
            'entityId'       => $userId,
            'entityLabel'    => $after['full_name'],
            'summary'        => $before['active'] && !$after['active']
                ? "Account for {$after['full_name']} deactivated"
                : "Account for {$after['full_name']} updated",
            'detail'         => Audit::diff($before, $after,
                ['full_name', 'email', 'role', 'phone', 'employee_ref', 'badge_barcode', 'active']),
        ]);

        return $after;
    }

    /**
     * Set someone else's password, as an administrator.
     *
     * Every session for that account is ended: if the reason for the reset is
     * that somebody else had the password, leaving their session alive defeats
     * the point.
     */
    public static function resetUserPassword(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $userId         = (int) $input['userId'];
        $password       = $input['password'] ?? null;

        $user = self::user($organizationId, $userId);
        if ($user === null) {
            throw Util::notFound('That account does not exist.');
        }

        if (!is_string($password) || $password === '') {
            throw Util::badRequest('Enter the new password.', ['field' => 'password']);
        }

        Auth::validatePassword($password);

        Db::execute(
            'UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0,
                    locked_until = NULL, updated_at = NOW()
              WHERE id = ? AND organization_id = ?',
            [Auth::hashPassword($password), $userId, $organizationId],
        );

        Auth::destroyAllSessionsForUser($userId);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::PASSWORD_CHANGED,
            'entityType'     => 'user',
            'entityId'       => $userId,
            'entityLabel'    => $user['full_name'],
            'summary'        => "Password reset for {$user['full_name']} by an administrator",
        ]);

        return [
            'user'   => self::user($organizationId, $userId),
            'notice' => "{$user['full_name']} has been signed out everywhere and will be asked to choose a "
                      . 'new password when they next sign in.',
        ];
    }

    private static function assertNotLastAdmin(int $organizationId, int $excludingUserId): void
    {
        $others = (int) Db::value(
            'SELECT COUNT(*) FROM users
              WHERE organization_id = ? AND role = "admin" AND active = 1 AND id <> ?',
            [$organizationId, $excludingUserId],
        );

        if ($others === 0) {
            throw Util::conflict(
                'This is the only active administrator. Make someone else an administrator first, or '
                . 'nobody will be able to reach the settings.',
            );
        }
    }
}
