/**
 * Apply the saved appearance before anything is painted.
 *
 * A classic script, not a module, and loaded in <head> without defer, so the
 * browser runs it before it draws the body. The alternative is a flash of the
 * default palette on every page load, which for somebody who has chosen
 * yellow-on-black because white backgrounds hurt is not a cosmetic detail.
 *
 * It is a separate file rather than an inline <script> because the policy in
 * index.php is script-src 'self' with no 'unsafe-inline', and relaxing that
 * for a theme flash would be a poor trade.
 *
 * Deliberately dumb: it replays what theme.js already computed and stored.
 * The colour maths lives in one place, and this file cannot disagree with it.
 */
(function () {
  'use strict';

  var MODE = 'loanerpool.theme';
  var CSS  = 'loanerpool.theme.css';

  var mode, css;

  try {
    mode = window.localStorage.getItem(MODE);
    css  = window.localStorage.getItem(CSS);
  } catch (e) {
    // Private browsing, or storage blocked by policy. Fall through to the
    // system preference, which is what an installation with no saved choice
    // does anyway.
    return;
  }

  if (!mode || mode === 'system') {
    // Resolved here rather than left to the stylesheet so that the attribute
    // is always a concrete value. The CSS then needs one selector per theme
    // instead of a media query and an attribute override of it.
    mode = window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.documentElement.setAttribute('data-theme', mode);

  if (mode === 'custom' && css) {
    // One assignment of a declaration list, exactly as theme.js serialised
    // it. style-src allows 'unsafe-inline', and this is a style attribute
    // rather than a <style> element in any case.
    document.documentElement.style.cssText = css;
  }
}());
