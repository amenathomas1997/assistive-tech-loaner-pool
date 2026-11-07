/**
 * Structural verification of the hand-written barcode encoders.
 *
 * These tables were transcribed by hand, and a single mistyped digit produces
 * a barcode that renders perfectly and scans as the wrong value (or not at
 * all) — the kind of bug you only find when a device is already mislabelled.
 * The checks below are properties of the Code 128 and Code 39 specifications,
 * so they catch transcription errors without needing a reference encoder.
 *
 * Run: node scripts/verify-barcode.js
 */

import {
  code128Patterns,
  code128Encode,
  code39Encode,
  code128Svg,
  code39Svg,
  generateBarcodeValue,
  normaliseScan,
  qrSvg,
} from '../src/lib/barcode.js';

let failures = 0;

function check(description, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\nCode 128 pattern table');

const patterns = code128Patterns();

check('table has 107 entries (values 0-106)', patterns.length === 107, `got ${patterns.length}`);

// Values 0-105 are six elements: three bars, three spaces.
const wrongElementCount = patterns
  .slice(0, 106)
  .map((p, i) => ({ i, p }))
  .filter(({ p }) => p.length !== 6);
check('values 0-105 each have 6 elements', wrongElementCount.length === 0,
  wrongElementCount.map(({ i, p }) => `${i}:${p}`).join(', '));

// Every character is exactly 11 modules wide. This is the single strongest
// check against a mistyped digit.
const wrongWidth = patterns
  .slice(0, 106)
  .map((p, i) => ({ i, p, sum: [...p].reduce((a, d) => a + Number(d), 0) }))
  .filter(({ sum }) => sum !== 11);
check('values 0-105 are each 11 modules wide', wrongWidth.length === 0,
  wrongWidth.map(({ i, p, sum }) => `${i}:${p}=${sum}`).join(', '));

// The stop pattern is 13 modules across 7 elements.
const stop = patterns[106];
const stopSum = [...stop].reduce((a, d) => a + Number(d), 0);
check('stop pattern is 7 elements / 13 modules', stop.length === 7 && stopSum === 13,
  `${stop} = ${stopSum} modules in ${stop.length} elements`);

// Specification property: within any Code 128 character the bar widths
// (elements 1, 3, 5) sum to an even number. Independent of the width check.
const oddBars = patterns
  .slice(0, 106)
  .map((p, i) => ({ i, p, bars: Number(p[0]) + Number(p[2]) + Number(p[4]) }))
  .filter(({ bars }) => bars % 2 !== 0);
check('bar widths sum to an even number in every character', oddBars.length === 0,
  oddBars.map(({ i, p, bars }) => `${i}:${p} bars=${bars}`).join(', '));

// No two characters may share a pattern, or decoding is ambiguous.
const unique = new Set(patterns);
check('all 107 patterns are unique', unique.size === patterns.length,
  `${patterns.length - unique.size} duplicate(s)`);

console.log('\nCode 128 encoding');

// Worked example, checkable by hand:
//   Start B = 104, "A" = 65 - 32 = 33 at position 1
//   checksum = (104 + 33 * 1) % 103 = 137 % 103 = 34
const encodedA = code128Encode('A');
check('check digit for "A" is 34', encodedA.checkDigit === 34, `got ${encodedA.checkDigit}`);
check('"A" encodes to start + data + check + stop', encodedA.codes.length === 4,
  JSON.stringify(encodedA.codes));

// "LP-7K3F9Q2M" is the shape of a real allocated barcode.
const sample = 'LP-7K3F9Q2M';
const encodedSample = code128Encode(sample);
check('sample encodes to the right number of codes',
  encodedSample.codes.length === sample.length + 3,
  `${encodedSample.codes.length} codes for ${sample.length} characters`);

// Total module count must equal 11 per code plus 2 extra for the stop pattern.
const expectedModules = (encodedSample.codes.length - 1) * 11 + 13;
const actualModules = encodedSample.widths.reduce((a, w) => a + w, 0);
check('sample module count matches specification', actualModules === expectedModules,
  `expected ${expectedModules}, got ${actualModules}`);

// Checksum must be in range for every character the generator can produce.
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ-';
let checksumOutOfRange = 0;
for (const ch of alphabet) {
  const { checkDigit } = code128Encode(`LP-${ch.repeat(6)}`);
  if (checkDigit < 0 || checkDigit > 102) checksumOutOfRange += 1;
}
check('check digit stays within 0-102 across the generator alphabet', checksumOutOfRange === 0);

// Characters outside subset B must be rejected rather than silently mangled.
let rejected = false;
try {
  code128Encode('café');
} catch {
  rejected = true;
}
check('non-ASCII input is rejected', rejected);

console.log('\nCode 39');

const c39Alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
let c39Bad = [];
for (const ch of c39Alphabet) {
  const { widths } = code39Encode(ch);
  // *X* = 3 characters at 9 elements each, plus 2 inter-character gaps = 29.
  if (widths.length !== 29) c39Bad.push(`${ch}:${widths.length}`);
}
check('every Code 39 character yields 29 elements when framed', c39Bad.length === 0, c39Bad.join(', '));

// Specification: exactly 3 of the 9 elements in each character are wide.
import('../src/lib/barcode.js').then(async () => {
  // Re-derive wide counts from a single-character encode, stripping the
  // framing asterisks and gaps.
  let wideBad = [];
  for (const ch of c39Alphabet) {
    const { widths } = code39Encode(ch, { wideRatio: 2 });
    const middle = widths.slice(10, 19); // skip '*' (9) + gap (1)
    const wide = middle.filter((w) => w === 2).length;
    if (wide !== 3) wideBad.push(`${ch}:${wide}`);
  }
  check('each Code 39 character has exactly 3 wide elements', wideBad.length === 0, wideBad.join(', '));

  console.log('\nScan normalisation');

  check('strips wedge carriage return', normaliseScan('LP-ABC123\r\n') === 'LP-ABC123');
  check('strips trailing tab', normaliseScan('LP-ABC123\t') === 'LP-ABC123');
  check('strips AIM symbology identifier', normaliseScan(']C1LP-ABC123') === 'LP-ABC123');
  check('strips Code 39 framing asterisks', normaliseScan('*LP-ABC123*') === 'LP-ABC123');
  check('uppercases', normaliseScan('lp-abc123') === 'LP-ABC123');
  check('empty input becomes null', normaliseScan('   ') === null);
  check('null input becomes null', normaliseScan(null) === null);

  console.log('\nGenerated values');

  const generated = Array.from({ length: 5000 }, () => generateBarcodeValue('LP'));
  check('generated values match the expected shape',
    generated.every((v) => /^LP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(v)));
  check('generated values avoid ambiguous characters 0/O/1/I/L',
    generated.every((v) => !/[01OIL]/.test(v.slice(3))));
  check('5000 generated values contain no duplicates',
    new Set(generated).size === generated.length,
    `${generated.length - new Set(generated).size} collision(s)`);

  // Rejection sampling should leave no character meaningfully more likely than
  // any other. With 40000 samples over 31 characters (~1290 expected each), a
  // modulo-biased generator would show the first 8 characters ~3% high.
  const freq = new Map();
  for (const value of generated) {
    for (const ch of value.slice(3)) freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  const counts = [...freq.values()];
  const expected = (5000 * 8) / 31;
  const maxDeviation = Math.max(...counts.map((c) => Math.abs(c - expected) / expected));
  check('character distribution is uniform within 15%', maxDeviation < 0.15,
    `worst deviation ${(maxDeviation * 100).toFixed(1)}%`);
  check('all 31 alphabet characters appear', freq.size === 31, `saw ${freq.size}`);
  check('every generated value is Code 128 encodable',
    generated.slice(0, 200).every((v) => {
      try { code128Encode(v); return true; } catch { return false; }
    }));

  console.log('\nSVG rendering');

  const svg128 = code128Svg('LP-7K3F9Q2M');
  check('Code 128 SVG is well-formed', svg128.startsWith('<svg') && svg128.endsWith('</svg>'));
  check('Code 128 SVG carries an accessible label', svg128.includes('aria-label="Barcode LP-7K3F9Q2M"'));

  const svg39 = code39Svg('LP-7K3F9Q2M');
  check('Code 39 SVG is well-formed', svg39.startsWith('<svg') && svg39.endsWith('</svg>'));

  const svgQr = await qrSvg('LP-7K3F9Q2M');
  check('QR SVG is well-formed', svgQr.includes('<svg') && svgQr.trim().endsWith('</svg>'));

  console.log(
    failures === 0
      ? '\nAll barcode checks passed.\n'
      : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
});
