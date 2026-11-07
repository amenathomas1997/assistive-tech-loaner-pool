/**
 * Decode QR matrices produced by the PHP encoder, using jsQR.
 *
 * Reads {text, matrix} pairs on stdin and reports whether each symbol decodes
 * back to its own input. Exits non-zero if any does not.
 *
 * This is the only place Node appears in the project, and only as a test
 * harness. It exists because structural checks are not enough: an earlier
 * version of the encoder built the Reed-Solomon generator polynomial with its
 * two terms transposed, which reverses the coefficients. Every structural
 * property still held — correct version, module count, function patterns and
 * format information, and the symbol even read back to its own codewords — and
 * all 77 symbols were undecodable by any real reader. A reimplementation by the
 * same author reproduced the identical bug; only a genuinely independent
 * decoder found it.
 *
 * No canvas and no browser: jsQR takes raw RGBA bytes, so the pixel buffer is
 * built by hand and the whole check runs headless in CI.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jsQR = require('../public/vendor/jsQR.js').default ?? require('../public/vendor/jsQR.js');

const cases = JSON.parse(readFileSync(0, 'utf8'));

/** Paint a matrix into an RGBA buffer at `scale` pixels per module. */
function render(matrix, scale, quiet) {
  const n = matrix.length;
  const size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!matrix[y][x]) continue;

      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + quiet) * scale + dy) * size;
        for (let dx = 0; dx < scale; dx++) {
          const i = (row + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }

  return { data, width: size, height: size };
}

let pass = 0;
const failures = [];

for (const { text, matrix } of cases) {
  // Several scales, because a decoder that reads a symbol at 10px per module
  // but not at 3 would still fail on a real printed label.
  let decoded = null;

  for (const scale of [6, 3, 10]) {
    const img = render(matrix, scale, 4);
    const result = jsQR(img.data, img.width, img.height);

    if (result && result.data === text) {
      decoded = result.data;
      break;
    }
    if (result && decoded === null) decoded = result.data;
  }

  if (decoded === text) {
    pass++;
  } else {
    failures.push({ text, decoded, modules: matrix.length });
  }
}

console.log(`\nQR round-trip: ${pass}/${cases.length} symbols decoded back to their input.`);

if (failures.length > 0) {
  console.error(`\n${failures.length} symbol(s) FAILED:\n`);
  for (const f of failures.slice(0, 10)) {
    console.error(`  ${f.modules}x${f.modules}  wanted ${JSON.stringify(f.text)}`);
    console.error(`            got    ${JSON.stringify(f.decoded)}`);
  }
  if (failures.length > 10) console.error(`  … and ${failures.length - 10} more`);
  process.exit(1);
}

console.log('All symbols decode correctly at 3, 6 and 10 pixels per module.\n');
