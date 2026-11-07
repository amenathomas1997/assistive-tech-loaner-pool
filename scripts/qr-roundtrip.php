<?php
/**
 * QR round-trip verification.
 *
 * Renders symbols with the PHP encoder, then decodes each one in the browser
 * with jsQR and asserts the decoded text matches the input.
 *
 * This exists because structural checks are not enough. An earlier version of
 * this encoder built the Reed-Solomon generator polynomial with its two terms
 * transposed, which reverses the coefficients. Every structural property still
 * held — correct version, correct module count, correct function patterns,
 * correct format information, and the symbol even read back to its own
 * codewords — and all 77 symbols were undecodable. Only a real decoder caught
 * it.
 *
 * Serve the application and open this file's URL in a browser:
 *
 *   php -S 127.0.0.1:8080 -t public scripts/dev-router.php
 *   open http://127.0.0.1:8080/qr-roundtrip.php
 *
 * The page title becomes "QR OK" or "QR FAIL"; the body reports any failures.
 */

declare(strict_types=1);

namespace Loaner;

require __DIR__ . '/../app/bootstrap.php';

$cases = [];

// Representative barcode values, every alphabet character, and the longest
// realistic payload (a scanner pairing URL).
$cases[] = 'AT-7K3F9Q2M';
$cases[] = 'LP-23456789';
$cases[] = 'ZZ-ZZZZZZZZ';

foreach (str_split(Util::UNAMBIGUOUS) as $char) {
    $cases[] = 'AT-' . str_repeat($char, 8);
}

for ($i = 0; $i < 40; $i++) {
    $cases[] = Barcode::generateValue('AT');
}

$cases[] = 'https://loanerpool.example.com/scanner.html?code=7K3F9Q';
$cases[] = 'https://a-very-long-subdomain.example-organisation.org/scanner.html?code=ABCDEF';

// Boundary: exactly the maximum the encoder accepts.
$cases[] = str_repeat('A', Qr::maxLength());

$payload = [];
foreach ($cases as $text) {
    $payload[] = ['text' => $text, 'matrix' => Qr::matrix($text)];
}

header('Content-Type: text/html; charset=utf-8');
$json = json_encode($payload);
?>
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>QR round-trip</title></head>
<body>
<pre id="out">running…</pre>
<script src="/vendor/jsQR.js"></script>
<script>
const CASES = <?= $json ?>;
const out = document.getElementById('out');

function render(matrix, scale, quiet) {
  const n = matrix.length, size = (n + quiet * 2) * scale;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (matrix[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  return ctx.getImageData(0, 0, size, size);
}

let pass = 0, fail = 0;
const failures = [];

for (const { text, matrix } of CASES) {
  // Several scales, because a decoder that works at 8px/module and not at 3
  // would still fail on a real printed label.
  let decoded = null;
  for (const scale of [6, 3, 10]) {
    const img = render(matrix, scale, 4);
    const r = jsQR(img.data, img.width, img.height);
    if (r && r.data === text) { decoded = r.data; break; }
    if (r && !decoded) decoded = r.data;
  }

  if (decoded === text) pass++;
  else { fail++; failures.push({ text, decoded, size: matrix.length }); }
}

out.textContent = JSON.stringify({ total: CASES.length, pass, fail, failures: failures.slice(0, 8) }, null, 2);
document.title = fail === 0 ? 'QR OK' : 'QR FAIL';
</script>
</body>
</html>
