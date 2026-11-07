/**
 * Print button for server-rendered sheets (barcode labels, agreements).
 *
 * A separate file rather than an inline onclick: the Content-Security-Policy
 * this application sends allows scripts only from its own origin, so an inline
 * handler is silently refused and the button would do nothing at all.
 */

for (const button of document.querySelectorAll('[data-print]')) {
  button.addEventListener('click', () => window.print());
  button.hidden = false;
}
