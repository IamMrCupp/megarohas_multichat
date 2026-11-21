'use strict';
// Overlay URL parameters that need more than a one-line read, kept out of
// the page so Node can test the same file the overlay loads
// (test/overlay-options.test.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OverlayOptions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ?bg=88 — how solid the message background is, 0 (none) to 100 (opaque).
  // -> the alpha to put in --bg-opacity, or null to leave overlay.css alone.
  // Anything that isn't a plain number is ignored rather than guessed at.
  function bubbleOpacity(q) {
    const raw = (q.get('bg') || '').trim();
    if (!/^\d+(\.\d+)?$/.test(raw)) return null;
    return Math.min(100, parseFloat(raw)) / 100;
  }

  return { bubbleOpacity };
});
