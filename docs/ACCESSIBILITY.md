# Accessibility

This is an application for lending assistive technology. The people it exists
to serve are disabled; so, often, are the people operating it. An inaccessible
loaner pool is a particular kind of failure, and that is the standard this
document holds the application to.

It was audited against **WCAG 2.2 at Level AAA** on 7 November 2026, against
the running application rather than the source, in both light and dark
themes. It was re-measured on 8 November 2026 after the custom-colour theme
was added, this time across fourteen screens in three themes — 5,508
text-bearing elements in all. It was audited again from scratch on 8 November
2026, criterion by criterion, across every screen and dialog, the sign-in
pages, the phone scanner, the installer and the two printable documents. That
pass is recorded under *The full re-audit* below, including where this
document had been wrong.

---

## The headline

**Level A and Level AA: met.** Every applicable success criterion at both
levels passes, including the four added in WCAG 2.2 (2.4.11 Focus Not
Obscured, 2.5.7 Dragging Movements, 2.5.8 Target Size (Minimum), 3.3.8
Accessible Authentication).

**Level AAA: substantially met, but not claimed.** WCAG 2.2 has 31 AAA
criteria. 6 do not apply here, 23 are met and 2 are met only in part. The
details are below, named individually, because "AAA" as a bare claim is not
worth much.

WCAG itself says so:

> It is not recommended that Level AAA conformance be required as a general
> policy for entire sites because it is not possible to satisfy all Level AAA
> Success Criteria for some content.

So this document does not claim AAA conformance. It says which criteria are
met, which are not, and why — which is the information somebody procuring or
deploying this actually needs.

---

## The full re-audit, 8 November 2026

This went through all 86 success criteria of WCAG 2.2, against the running
application: 22 screens and 28 dialogs in a browser (2,909 text elements),
every screen again at 320px wide with and without the SC 1.4.12 text spacing,
then the sign-in pages, phone scanner, installer, printed agreement and label
sheet.

**Where this document was wrong.** It listed 23 AAA criteria and never
mentioned 1.3.6, 2.4.8, 3.2.5 or 3.3.9. It said every target was 44px, that
reflow passed, and that contrast passed everywhere. Those were true of what had
been measured and false of what had not.

**What failed, all now fixed:**

| Criterion | Level | What was wrong |
|---|---|---|
| 2.4.1 Bypass Blocks, 1.3.1 | A | The sign-in, two-factor and reset pages had no `<main>`, so "Skip to main content" went nowhere |
| 1.4.10 Reflow | AA | At 320px every table screen scrolled sideways. Visually hidden text in the last column is `position:absolute`, which the scrolling wrapper does not clip unless it is positioned itself. The header was 18px too wide and a two-column grid had a hard 320px minimum |
| 3.2.1 On Focus, 3.2.5 Change on Request | A, AAA | The scan station pulled focus back to its input every 1.2 seconds whenever focus was on the page body, which is where a screen reader in browse mode leaves it. The screen could not be read. It now waits for a keystroke |
| 3.2.5, 2.2.4 | AAA | The "being updated" page used `<meta refresh>` (failure F41), and the page reloaded itself four seconds after a finished update |
| 1.4.6 Contrast (Enhanced) | AAA | The header buttons were white on a white veil, 5.34:1. The build's colour check did not know about veils; it does now |
| 2.5.5 Target Size (Enhanced) | AAA | Footer help button 24px, file inputs 22px, disclosure summaries 23px, the print button on the label sheet 39px |
| 1.4.8 Visual Presentation | AAA | Paragraph spacing was 1em. The criterion asks for 1.5 times the line spacing, so 2.4em here. Two blocks of text also ran to 100 characters |
| 2.4.2, 2.4.8 | A, AAA | Every device had the page title "Device". Records now name themselves, and only one navigation item is marked current |
| 2.4.3 Focus Order | A | Disabling the focused button during a save dropped focus to the top of the page |

**Not a failure, for the record.** Duplicate ids and unlabelled checkboxes
appeared in the first pass and were traced to the test: in a hidden browser
pane a closed `<dialog>` keeps its place in the document until the next
animation frame. Removing them in the test made every one disappear.

**Reading level (SC 3.1.5) has now been measured.** 261 interface sentences
average Flesch-Kincaid grade 6.5, weighted by length, and the default loan
agreement is 7.7. The criterion asks for lower secondary, roughly grades 7 to
9. That is a formula: it says nothing about whether a sentence is clear, and a
person should still read the agreement that clients sign. An agreement edited
in Settings is not covered by this figure.

---

## What the audit found, and what was done about it

Six things failed when the application was first measured. A second pass,
after the custom-colour theme was built, found five more. All eleven are
fixed.

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

### Five more, found building the colour theme

Writing a theme that derives every colour from two of them meant reading the
stylesheet token by token. That turned up things no screenshot would have.

**An undefined token, used twice.** `var(--brand-ink)` appeared in two rules
and was declared in no stylesheet. An undefined custom property is invalid at
computed-value time, so `background: var(--brand-ink)` resolved to
*transparent* — and the rule that used it set `color: #fff` over the top. That
rule is the "Go to… press a letter" hint, which means the visible indicator
for the keyboard shortcut mode was white text on the page background: invisible
in the light theme, on the feature whose own source comment says "a mode nobody
can see is a trap". The second use, `.linkish`, silently inherited its colour
instead. There is now a `--link` token, declared in both palettes and checked
on every surface, and the hint is drawn as `--text` on `--bg` — the highest
contrast any theme has by definition, custom palettes included.

**A count badge at 2.23:1.** `.badge-count` — the number of unread loan
requests in the sidebar — was `#fff` on `var(--danger)`. In the light theme
`--danger` is a deep red and white sits at 8.23:1. In the dark theme it is a
pale salmon, so the same rule produced white on salmon: **below Level AA**, not
merely below AAA. It is `var(--surface)` now, which is white in the light
theme and therefore changes nothing there, and inverts correctly in the dark
one.

**The same mistake on the offline banner, and worse.** The queued-scan count
was `#fff` on `var(--warn-border)`: **3.05:1 in the light theme**. This is the
number of scans waiting for the network to come back — the one figure somebody
needs to read at the moment the connection has dropped.

**Muted text on seven tinted surfaces.** The contrast script checked body and
muted text on the four plain surfaces and never on the eight tinted ones. On
the brand tint behind a scan target, muted text was 6.18:1 in dark and 6.87:1
on the danger tint in light. Both clear AA; neither clears the 7:1 of SC 1.4.6.
`--text-muted` moved in both themes, the danger tint was lightened, and the
script now checks every tinted surface — which is what took it from 58
pairings to 132.

**A token the custom theme forgot.** `--link` was added to both built-in
palettes and to neither half of the derivation, so with a custom palette the
footer link stayed navy — on black, at 1.71:1. Found by measuring the running
page rather than by reading the code. The build now compares the stylesheet's
colour tokens against the ones the custom theme derives and fails on any
difference, because the failure mode is silent: a forgotten token does not go
missing, it keeps its light-theme value.

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

### Met (23), and not applicable (6)

| Criterion | How |
|---|---|
| **1.2.6** Sign Language | Not applicable — no prerecorded audio |
| **1.2.7** Extended Audio Description | Not applicable — no video |
| **1.2.8** Media Alternative | Not applicable — no synchronised media |
| **1.2.9** Audio-only (Live) | Not applicable — no live audio |
| **1.3.6** Identify Purpose | Named landmarks, `autocomplete` tokens on the person's own details, native controls throughout, and every icon hidden beside a real word |
| **1.4.6** Contrast (Enhanced) | 133 pairings at ≥7:1 checked on every build; 2,909 rendered text elements measured with no failures |
| **1.4.7** Low or No Background Audio | Not applicable — no audio |
| **1.4.8** Visual Presentation | Line length capped at 70ch, never justified, line spacing 1.55, resizes to 200% without horizontal scroll, and the user can choose their own two colours |
| **1.4.9** Images of Text (No Exception) | No images of text anywhere; the logo is inline SVG, every icon is `aria-hidden` beside real text |
| **2.1.3** Keyboard (No Exception) | Nothing needs a pointer. Signing is three equal methods — type your name, draw, or photograph a signed sheet — with typing the default. Barcode scanning always has manual entry beside it |
| **2.2.4** Interruptions | Confirmations can be set not to clear themselves, nothing refreshes on its own, and errors never disappear |
| **2.2.5** Re-authenticating | The sign-in opens over the page and the half-finished form is intact afterwards |
| **2.2.6** Timeouts | Sessions last 14 days with no inactivity timeout, so data persists far beyond the 20 hours the exception allows |
| **2.3.2** Three Flashes | Nothing flashes |
| **2.3.3** Animation from Interactions | `prefers-reduced-motion: reduce` disables every transition and animation |
| **2.4.8** Location | The current page is marked in the navigation, record pages have a breadcrumb, and the page title names the record |
| **2.4.9** Link Purpose (Link Only) | Every link reads unambiguously out of context |
| **2.4.10** Section Headings | Each screen is sectioned, each `<section>` labelled by its heading |
| **2.4.12** Focus Not Obscured (Enhanced) | `scroll-margin-top` of 78px clears the sticky header. Tabbed every focusable element on four screens: none obscured |
| **2.4.13** Focus Appearance | 3px outline at 2px offset plus a 5px ring. The ring reads 8.01:1 against the surface, well over the 3:1 required |
| **2.5.5** Target Size (Enhanced) | Every control on every screen and dialog measured at 44×44 or more; links inside a sentence are excepted by the criterion |
| **2.5.6** Concurrent Input Mechanisms | Nothing restricts input mode; touch, mouse, keyboard and scanner all work at once |
| **3.1.3** Unusual Words | Glossary in the help dialog, reachable from every screen |
| **3.1.4** Abbreviations | Same glossary |
| **3.1.5** Reading Level | Measured at grade 6.5 for the interface and 7.7 for the default agreement. See the re-audit above for what that does and does not show |
| **3.2.5** Change on Request | Nothing moves focus, reloads or navigates unless the person asked it to |
| **3.3.9** Accessible Authentication (Enhanced) | Paste and password managers work on every field, one-time codes are marked for autofill, and nothing asks anybody to recognise or transcribe an image |
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

### Not met (0)

**1.4.8 Visual Presentation** was the one criterion this document recorded as
not met. Four of its five requirements passed — line length capped at 70ch,
text never justified, line spacing 1.55 with paragraph spacing above it, text
resizing to 200% without horizontal scrolling — and the fifth did not: there
was no way for the user to select their own foreground and background colours.

There is now. **Appearance**, in the header of every screen and under the
sign-in form, offers light, dark, follow-the-device, or two colours of the
user's own choosing. See *Choosing your own colours* below.

### Not applicable

**3.1.6 Pronunciation.** No word here needs its pronunciation to be understood.
The five media criteria above do not apply either, as there is no audio or
video.

---

## Choosing your own colours

**Appearance** sits in the header of every screen, and under the sign-in form
— deliberately, because somebody who cannot read light text on a blue header
cannot sign in to say so. A colour setting that only exists behind the sign-in
form is no use to the people it is for.

It offers four things: follow this device, light, dark, or two colours chosen
by the user. The choice is remembered per browser rather than per account,
because the colours somebody needs are a property of the screen they are
sitting at and the light in the room, not of their user record — and because a
shared machine at a front desk should not inherit whatever the last person
needed.

**It measures the pair and says what it meets**, live, as a number and in
words: "16.6 to 1. Meets the highest standard (AAA) for body text", or "3.1 to
1. Below the minimum of 4.5 to 1 — text may be hard to read." It does not
refuse a pair that measures badly. The criterion exists to give the person the
choice, and the person at the keyboard can see the screen; a script that
overruled them would defeat the thing it was meant to serve.

**Six starting points** are offered — black on white, white on black, yellow
on black, black on cream, green on black, navy on pale blue. Not a palette: the
combinations people actually ask for. Somebody who needs yellow on black is one
click away rather than hunting through a colour wheel with the eyesight that
brought them there. All six clear 7:1, and the build checks them.

**Two ways to set each colour.** The swatch opens the platform picker, which
is the easy path. The hex box beside it is not a convenience for developers:
the native picker is a small, mouse-shaped target that some people cannot
operate at all, and an optician's note or a support article gives a hex value.
Either control drives the other, and `#abc`, `00F` and `#0000ff` are all
accepted.

### What custom mode gives up, and why

Two colours in, a whole palette out: every surface is the chosen background or
a measured step from it toward the foreground. That costs two things, both on
purpose.

**Muted text is not muted.** A derived grey cannot be guaranteed to clear 7:1
— or even 4.5:1 — against an arbitrary background. Somebody who has chosen
their own two colours has said legibility matters more than shading, so
secondary text is the foreground colour exactly.

**The status pills lose their hues.** Available, On loan, Overdue and In
repair all end up the same two colours. This is only safe because SC 1.3.1 was
already satisfied without colour: every pill carries its word, every status has
a dot beside that word, the current nav item has a bar as well as a colour, and
the tracker steps have glyphs. Nothing in this application was ever
distinguishable by hue alone — which is exactly what makes a two-colour mode
possible.

A danger button and a primary button would also be identical, so in custom
mode they differ by fill: the primary one is filled, the destructive one is
outlined and underlined. The word on the button was always doing the work.

### Windows High Contrast still wins

`forced-colors: active` is supported in full, and when the platform setting is
on it overrides all of this. For the people who have it configured that remains
the better route, because it applies to every application at once. The
in-application setting is for everybody else: a browser on a shared machine, a
Chromebook, a locked-down desktop where the platform setting is not theirs to
change.

### How it is applied

The theme is an attribute on the root element, not a media query. A small
classic script in the `<head>` of every page resolves the stored preference —
"follow this device" included — to a concrete value before the body is painted,
so a chosen palette never flashes the default one first. For somebody who
picked yellow on black because white backgrounds hurt, that flash is not a
cosmetic detail.

It is a separate file rather than an inline `<script>` because the policy in
`index.php` is `script-src 'self'` with no `'unsafe-inline'`, and relaxing a
content security policy to avoid a flash of colour would be a poor trade.

## What was verified, and how

The audit ran against the application in a browser, signed in, on real seeded
data — not against the source.

- **Contrast** computed from the rendered colours of every text-bearing
  element, with gradients resolved to their stops. The second pass covered
  fourteen screens in three themes — light, dark, and a custom yellow-on-black
  — and measured **5,508 text elements, none below its threshold**. False
  positives from an early pass (white-on-gradient reported as 1.07:1, because
  the computed `background-color` of a gradient is transparent and the
  measurement had walked up to the page behind it) were traced and discarded
  rather than "fixed"; the resolver reads the gradient stops now.
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

- `scripts/verify-contrast.mjs` — 133 colour pairings against their AA or AAA
  threshold, read from the stylesheet so it cannot drift from what it checks:
  body and muted text on all eleven surfaces, every status colour on its own
  tint, both gradient ends of the header and the primary button, the two count
  badges, and the six custom-theme starting points. It also compares the
  stylesheet's colour tokens against the ones the custom theme derives, and
  fails on any the derivation has forgotten.
- `scripts/verify-ui-contract.sh` — every field the interface reads is present
  in the response it reads it from. Not an accessibility check as such, but
  the word "undefined" on screen is an accessibility failure like any other,
  and this is what stops it.

## Known limitations

- **No automated screen-reader testing.** Landmarks, names, roles and live
  regions were verified through the accessibility tree. They have not been
  driven with NVDA, JAWS or VoiceOver. That is the next thing worth doing, and
  the one thing here no script can replace.
- **Reading level is a formula's answer**, as above. Nobody has read the
  interface for plainness, and that includes the people it is written for.
- **The focus ring was not re-measured live in the November re-audit**, because
  the browser pane was not the focused window and `:focus-visible` does not
  match there. The rule itself did not change, and it was measured live on
  7 November.
- **Custom colours flatten two things on purpose**: text that is normally
  muted is not muted, and the status pills lose their separate hues. Both are
  described under *Choosing your own colours*. Neither is a conformance
  failure — no information in this application was ever carried by colour
  alone — but somebody evaluating it should know the trade was deliberate.
- **Two surfaces stay white in every theme**: the QR code and the signature
  pad. A QR code has to be dark-on-light to scan at all, and a signature
  belongs on white. In a dark or custom theme they are bright patches, which
  is a real cost and the right one.
- **The browser's own camera scanner** depends on `BarcodeDetector` or the
  bundled decoder. Where neither works, manual entry is always available —
  which is the accessible path in any case.
