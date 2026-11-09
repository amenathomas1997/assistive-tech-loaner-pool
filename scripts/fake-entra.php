<?php
/**
 * A stand-in for Microsoft's token endpoint, for scripts/e2e-sso.sh.
 *
 * The "authorization code" the suite hands back is a base64url JSON document
 * saying what this endpoint should have been sent and which claims to return.
 * So the test proves the application sent the right secret, redirect address
 * and PKCE verifier, not merely that it read a token.
 *
 * Test tooling only. Reached solely through the LOANER_SSO_AUTHORITY
 * environment variable, which only the server's own environment can set.
 */

declare(strict_types=1);

header('Content-Type: application/json');

$b64 = static fn (string $s): string => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');

$deny = static function (string $error, string $description): never {
    http_response_code(400);
    echo json_encode(['error' => $error, 'error_description' => $description]);
    exit;
};

$plan = json_decode((string) base64_decode(strtr((string) ($_POST['code'] ?? ''), '-_', '+/')), true);

if (!is_array($plan)) {
    $deny('invalid_grant', 'AADSTS70000: unreadable code.');
}
if (($_POST['client_secret'] ?? '') !== 'test-client-secret') {
    $deny('invalid_client', 'AADSTS7000215: Invalid client secret provided.');
}
if (($_POST['grant_type'] ?? '') !== 'authorization_code') {
    $deny('unsupported_grant_type', 'wrong grant type');
}
if (($_POST['redirect_uri'] ?? '') !== $plan['redirect_uri']) {
    $deny('invalid_grant', 'AADSTS70008: redirect_uri does not match.');
}
if ($b64(hash('sha256', (string) ($_POST['code_verifier'] ?? ''), true)) !== $plan['challenge']) {
    $deny('invalid_grant', 'AADSTS501481: the code verifier does not match the challenge.');
}

echo json_encode([
    'id_token' => $b64('{"alg":"none"}') . '.' . $b64((string) json_encode($plan['claims'])) . '.signature',
]);
