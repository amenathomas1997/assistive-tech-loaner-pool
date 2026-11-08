# Accessibility

This is an application for lending assistive technology. The people it exists
to serve are disabled; so, often, are the people operating it. An inaccessible
loaner pool is a particular kind of failure, and that is the standard this
document holds the application to.

It was audited against **WCAG 2.2 at Level AAA** on 7 November 2026, against
the running application rather than the source, in both light and dark themes.

---

## The headline

**Level A and Level AA: met.** Every applicable success criterion at both
levels passes, including the four added in WCAG 2.2 (2.4.11 Focus Not
Obscured, 2.5.7 Dragging Movements, 2.5.8 Target Size (Minimum), 3.3.8
Accessible Authentication).

**Level AAA: substantially met, but not claimed.** Of the 23 applicable AAA
criteria, 20 pass, 2 pass only in part, and 1 is not met. The details are
below, named individually, because "AAA" as a bare claim is not worth much.

WCAG itself says so:

> It is not recommended that Level AAA conformance be required as a general
> policy for entire sites because it is not possible to satisfy all Level AAA
> Success Criteria for some content.

So this document does not claim AAA conformance. It says which criteria are
met, which are not, and why — which is the information somebody procuring or
deploying this actually needs.

---

## What the audit found, and what was done about it

Six things failed when measured. All six are fixed.

### Two were Level AA failures

Both had been missed because they were in the parts of a design nobody
re-examines once it looks right.

**1.4.11 Non-text Contrast — the border of every text field.** `--border-strong`
was `#9aa4b1`, which is **2.52:1** against white. The criterion requires 3:1
for the visible boundary of a control. A field whose edge cannot be made out
is a field somebody does not know is there. Now `#838f9f` (3.28:1), and
`#64717f` in dark mode (3.36:1).

**1.3.1 Info and Relationships — heading levels.** The shared empty-state and
alert components hard-coded `<h3>`. On any list screen with nothing in it, the
document went `h1` → `h3` with nothing between, so somebody navigating by
heading lands on a level-three heading and has to work out what they missed.
Both components now take a level and default to 2.

### Four were AAA failures

**1.4.6 Contrast (Enhanced).** Twelve colour tokens were between 4.5:1 and
7:1 — passing AA, failing AAA. Muted text was 6.38 on white and 5.63 on the
sunken surface. The status pills ran 5.43 to 6.56. The primary button's
gradient put its white label at **4.52:1**, over the AA threshold by two
hundredths. The avatar chip was 4.61.

All now clear 7:1 in both themes. The button's gradient runs brand to
brand-strong (8.01 to 10.02) rather than bright to brand. The avatar chip was
a white veil over the header, which lightened the backdrop behind white
initials; sunk to a black veil instead, it reads at 10.06.

`scripts/verify-contrast.mjs` checks 58 pairings on every test run and fails
the build if any drops below its threshold. Contrast is the one accessibility
property that decays silently — nothing breaks when a grey is lightened to
make a heading look nicer, and the only person who notices is the one who can
no longer read it.

**2.5.5 Target Size (Enhanced).** Buttons were 42px, fields 42, icon buttons
40, header buttons 40, option rows 32, row checkboxes 20. All over the 24px
floor of SC 2.5.8, all under the 44 of SC 2.5.5. Everything is 44 now. The row
checkbox keeps a 24px tick inside a 44px label with a negative margin, so the
larger target costs no height in a dense table.

**2.2.5 Re-authenticating.** When a session expired, the entire page was
replaced by the sign-in form. A counselor half way through a loan request lost
it — and the people most likely to hit a timeout are the people who take
longest over a form, which is to say the people this criterion is for. The
sign-in now opens over the top in a dialog; the page behind is inert while it
is open and completely intact afterwards. Verified by expiring a live session
over a half-filled request form and signing back in: the typed justification
was still there.

**2.2.4 Interruptions.** Confirmations cleared themselves after 5.2 seconds
with no way to stop them. Somebody reading with a screen magnifier may be two
words into a message when it goes. There is now a switch in the keyboard help,
remembered per browser. Errors never auto-dismissed and still do not.

### Also addressed

- **1.4.8 Visual Presentation** — explanatory prose ran to 138 characters a
  line on a wide screen, well over the 80 the criterion allows. Capped at
  70ch. Measured in real `ch` units afterwards: zero blocks over 80 on any
  screen.
- **2.4.9 Link Purpose (Link Only)** — three links reading "See all" on one
  dashboard. Now "See all overdue loans", "See all due back soon", "See all
  loan requests".
- **3.1.3 / 3.1.4 Unusual Words and Abbreviations** — a glossary in the help
  dialog (VRC, AT, kit, outcome, sanitising, CSV, API key and the rest),
  reachable from every screen. Technique G102. A glossary rather than `<abbr>`
  markup because a screen reader announces an `<abbr>` expansion *every single
  time*, and "Vocational Rehabilitation Counselor" read aloud forty times on
  one screen is worse than the abbreviation.
- **Named regions and keyboard navigation** — every landmark carries a name,
  because a region list that says "navigation" twice tells nobody which one to
  enter. Three skip links. Press `G` then a letter to go anywhere, `/` for the
  screen's search, `?` for the list.

---

## Level AAA, criterion by criterion

### Met (20)

| Criterion | How |
|---|---|
| **1.2.6** Sign Language | Not applicable — no prerecorded audio |
| **1.2.7** Extended Audio Description | Not applicable — no video |
| **1.2.8** Media Alternative | Not applicable — no synchronised media |
| **1.2.9** Audio-only (Live) | Not applicable — no live audio |
| **1.4.6** Contrast (Enhanced) | 58 pairings at ≥7:1, both themes, checked on every build |
| **1.4.7** Low or No Background Audio | Not applicable — no audio |
| **1.4.9** Images of Text (No Exception) | No images of text anywhere; the logo is inline SVG, every icon is `aria-hidden` beside real text |
| **2.1.3** Keyboard (No Exception) | Nothing needs a pointer. Signing is three equal methods — type your name, draw, or photograph a signed sheet — with typing the default. Barcode scanning always has manual entry beside it |
| **2.2.6** Timeouts | Sessions last 14 days with no inactivity timeout, so data persists far beyond the 20 hours the exception allows |
| **2.3.2** Three Flashes | Nothing flashes |
| **2.3.3** Animation from Interactions | `prefers-reduced-motion: reduce` disables every transition and animation |
| **2.4.9** Link Purpose (Link Only) | Every link reads unambiguously out of context |
| **2.4.10** Section Headings | Each screen is sectioned, each `<section>` labelled by its heading |
| **2.4.12** Focus Not Obscured (Enhanced) | `scroll-margin-top` of 78px clears the sticky header. Tabbed every focusable element on four screens: none obscured |
| **2.4.13** Focus Appearance | 3px outline at 2px offset plus a 5px ring. The ring reads 8.01:1 against the surface, well over the 3:1 required |
| **2.5.5** Target Size (Enhanced) | Every target is at least 44×44 |
| **2.5.6** Concurrent Input Mechanisms | Nothing restricts input mode; touch, mouse, keyboard and scanner all work at once |
| **3.1.3** Unusual Words | Glossary in the help dialog, reachable from every screen |
| **3.1.4** Abbreviations | Same glossary |
| **3.3.5** Help | A Help button in the same place on every screen (which is also SC 3.2.6), plus per-field help text |

### Partly met (2)

**2.2.3 No Timing.** Nothing has a deadline that costs you anything. But three
timers exist: the "go to" keyboard shortcut waits 3 seconds for its second
key, confirmations clear after 5.2 seconds unless you switch that off, and the
phone-scanner pairing code expires. All three are either switchable off, free
to retry, or both — but the criterion as written says timing must not be
essential at all, and a pairing code that expires is a timing element. It is
there because a pairing code that never expires is a security problem, and
that trade is made deliberately.

**3.3.6 Error Prevention (All).** Everything destructive or legally
significant is confirmed, reversible, or both: deletions ask, imports run a
dry run first that writes nothing, a check-out can be reversed by a check-in,
and the backup requires a password. But a loan record is not editable after
the fact by design — that is what makes the audit trail worth having — so
"reversible" is not true of every submission in the sense the criterion means.
This is a deliberate records-keeping decision, not an oversight.

### Not met (1)

**1.4.8 Visual Presentation.** Four of its five requirements pass: line length
is capped at 70ch, text is never justified, line spacing is 1.55 with
paragraph spacing above it, and text resizes to 200% without horizontal
scrolling.

The fifth — that the user can select foreground and background colours — is
not provided *in the application*. There is no colour picker.

What does exist: both light and dark themes following the system preference,
and full support for `forced-colors: active`, so Windows High Contrast and
equivalent platform settings work correctly and the page honours the user's
own chosen colours. That is the mechanism most people actually use. It is not
what the criterion asks for, and this document does not pretend otherwise.

### Not assessed

**3.1.5 Reading Level.** The criterion asks that text not require reading
ability beyond lower secondary education, or that a simpler alternative be
available. Interface copy here was written plainly and deliberately, but
reading level is a judgement about prose that an automated check cannot make
honestly, and no human assessment has been done. Unverified rather than
claimed.

**3.1.6 Pronunciation.** No content depends on pronunciation for its meaning.
Arguably not applicable; recorded as unassessed rather than passed.

---

## What was verified, and how

The audit ran against the application in a browser, signed in, on real seeded
data — not against the source.

- **Contrast** computed from the rendered colours of every text-bearing
  element on thirteen screens in both themes, with gradients resolved to their
  lightest stop. False positives from an early pass (white-on-gradient
  reported as 1.07:1 because the computed `background-color` is transparent)
  were traced and discarded rather than "fixed".
- **Target size** measured from `getBoundingClientRect` on every interactive
  element, with the 2.5.8 spacing exception checked separately: row checkboxes
  sit 36.5px apart with the nearest other target 52px away, so they would have
  passed AA on spacing alone before being enlarged.
- **Focus** tested by focusing every focusable element on four screens and
  measuring its box against the sticky header, with a repaint in between.
- **Text spacing (1.4.12)** tested by injecting the criterion's exact values
  and checking for clipped content. The only hits were `.visually-hidden`
  elements, which are 1px by design.
- **Reflow (1.4.10)** — the only horizontal overflow is the data tables, which
  sit in an `overflow-x: auto` wrapper and are exempt as content requiring
  two-dimensional layout.
- **Landmarks, headings, labels and alternative text** enumerated per screen:
  one `h1` each, no skipped levels, no unlabelled controls, no image without
  `alt`, no unlabelled SVG.

## What is checked on every build

Accessibility that is verified once decays. Two scripts run in
`./scripts/reset-and-test.sh`:

- `scripts/verify-contrast.mjs` — 58 colour pairings against their AA or AAA
  threshold, read from the stylesheet so it cannot drift from what it checks.
- `scripts/verify-ui-contract.sh` — every field the interface reads is present
  in the response it reads it from. Not an accessibility check as such, but
  the word "undefined" on screen is an accessibility failure like any other,
  and this is what stops it.

## Known limitations

- **No automated screen-reader testing.** Landmarks, names, roles and live
  regions were verified through the accessibility tree. They have not been
  driven with NVDA, JAWS or VoiceOver. That is the next thing worth doing, and
  the one thing here no script can replace.
- **Reading level unassessed**, as above.
- **No in-application colour picker**, as above.
- **The browser's own camera scanner** depends on `BarcodeDetector` or the
  bundled decoder. Where neither works, manual entry is always available —
  which is the accessible path in any case.
