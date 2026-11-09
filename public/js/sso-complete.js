/**
 * The last page of a Microsoft sign-in opened in its own window, which is how
 * somebody signs back in over a half-finished form without losing it.
 *
 * A BroadcastChannel rather than window.opener, because Microsoft's sign-in
 * pages can sever the link between a popup and the page that opened it.
 */
const error = new URLSearchParams(window.location.search).get('error');

const channel = new BroadcastChannel('loaner-sso');
channel.postMessage({ error });
channel.close();

// Allowed to fail. If it does, the page already says to close the window.
window.close();
