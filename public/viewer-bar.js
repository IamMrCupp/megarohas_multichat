'use strict';
// The viewer bar's decisions — what each chip says and whether it shows —
// kept out of the page so Node can test the same file the overlay loads
// (test/viewer-bar.test.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ViewerBar = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NAMES = ['twitch', 'youtube'];
  const LABEL = { twitch: 'Twitch', youtube: 'YouTube' };

  // 987 -> "987", 4467 -> "4,467", 12345 -> "12.3K", 1234567 -> "1.2M".
  // fmt 'full' never abbreviates.
  function format(n, fmt) {
    if (!Number.isFinite(n) || n < 0) return '–';
    n = Math.round(n);
    const full = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (fmt === 'full' || n < 10000) return full;
    const short = (v, unit) => (v >= 100 ? String(Math.floor(v)) : String(Math.floor(v * 10) / 10).replace(/\.0$/, '')) + unit;
    return n < 1000000 ? short(n / 1000, 'K') : short(n / 1000000, 'M');
  }

  // URL parameters -> options.
  //   viewers=1|top|bottom   show the bar (1 = at the edge messages leave by)
  //   viewerstyle=inside     number inside the platform graphic (default: beside it)
  //   viewersoffline=hide    drop a platform's chip while it isn't live
  //   viewersfmt=full        never abbreviate (12,345 instead of 12.3K)
  function options(q, dirTop) {
    const v = (q.get('viewers') || '').toLowerCase();
    const on = ['1', 'top', 'bottom', 'true', 'on'].includes(v);
    return {
      on,
      edge: v === 'top' || v === 'bottom' ? v : (dirTop ? 'bottom' : 'top'),
      style: (q.get('viewerstyle') || '').toLowerCase() === 'inside' ? 'inside' : 'beside',
      hideOffline: (q.get('viewersoffline') || '').toLowerCase() === 'hide',
      fmt: (q.get('viewersfmt') || '').toLowerCase() === 'full' ? 'full' : 'short',
    };
  }

  // viewers: { twitch: { state, count, note }, youtube: {...} } from the server.
  // -> one entry per chip to draw, in a fixed order.
  function chips(viewers, opts) {
    const out = [];
    for (const p of NAMES) {
      const v = viewers && viewers[p];
      if (!v || v.state === 'none') continue;                      // no such source: no chip
      if (v.state !== 'live' && opts && opts.hideOffline) continue;
      if (v.state === 'live') {
        out.push({ platform: p, state: 'live', text: format(v.count, opts && opts.fmt), title: `${LABEL[p]}: ${format(v.count, 'full')} watching` });
      } else if (v.state === 'offline') {
        out.push({ platform: p, state: 'offline', text: 'off', title: `${LABEL[p]}: not live` });
      } else {
        // can't tell — say so; never show a zero nobody measured
        out.push({ platform: p, state: 'unknown', text: '–', title: `${LABEL[p]}: ${v.note || 'viewer count unavailable'}` });
      }
    }
    return out;
  }

  // How much of the window the bar takes from the chat column: its own height
  // plus its gap to the edge it is pinned to. computed is getComputedStyle(bar).
  // A fixed element's computed `top` is its real distance from the top even
  // when it is anchored by `bottom`, so only the pinned edge may be read.
  function barHeight(offsetHeight, computed, edge, chipCount) {
    if (!chipCount) return 0;
    const margin = parseFloat(computed && computed[edge === 'bottom' ? 'bottom' : 'top']) || 0;
    return Math.ceil(offsetHeight + margin);
  }

  return { NAMES, LABEL, format, options, chips, barHeight };
});
