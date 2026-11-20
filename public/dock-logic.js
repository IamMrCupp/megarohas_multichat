'use strict';
// The dock's decisions, kept out of the page so they can be tested in Node
// (test/dock-logic.test.js) as well as loaded by public/dock.html.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DockLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NAMES = ['twitch', 'youtube'];
  const LABEL = { twitch: 'Twitch', youtube: 'YouTube', both: 'Both' };

  function usableOne(platforms, p) {
    const s = platforms && platforms[p];
    return !!(s && s.signedIn && s.connected);
  }
  function usable(platforms, t) {
    return t === 'both' ? NAMES.every(p => usableOne(platforms, p)) : usableOne(platforms, t);
  }
  function wanted(t) { return t === 'both' ? NAMES.slice() : [t]; }

  // The tightest limit among the platforms a target posts to.
  function limitFor(platforms, t) {
    let limit = Infinity;
    let by = null;
    for (const p of wanted(t)) {
      const n = platforms && platforms[p] && platforms[p].maxLength;
      if (n && n < limit) { limit = n; by = p; }
    }
    return { limit: limit === Infinity ? 500 : limit, by };
  }
  function count(text) { return Array.from(text).length; }

  // One always-visible line per platform: where a reply will go, or why it won't.
  function targetLine(platforms, p) {
    const s = platforms && platforms[p];
    if (!s) return { text: `${LABEL[p]} → no connection to the server`, ok: false };
    if (!s.available) return { text: `${LABEL[p]} → ${s.detail || 'not available'}`, ok: false };
    if (!s.signedIn) return { text: `${LABEL[p]} → not signed in`, ok: false, setup: true };
    if (!s.connected) {
      return { text: `${LABEL[p]} → ${s.choices && s.choices.length ? 'no reply target chosen' : 'no chat connected in the panel'}`, ok: false };
    }
    return { text: `${LABEL[p]} → ${s.target}${s.as ? ' (as ' + s.as + ')' : ''}`, ok: true };
  }

  // The keys the page is showing, sent with a message so the server can refuse
  // if the target moved since.
  function expectFor(platforms, t) {
    const out = {};
    for (const p of wanted(t)) if (platforms && platforms[p] && platforms[p].targetKey) out[p] = platforms[p].targetKey;
    return out;
  }

  // Did a reply target change between two session reads? Returns notes to show.
  function targetChanges(before, after) {
    const notes = [];
    for (const p of NAMES) {
      const a = before && before[p], b = after && after[p];
      if (!a || !b || !a.targetKey || a.targetKey === b.targetKey) continue;
      notes.push(b.targetKey ? `${LABEL[p]} reply target is now ${b.target}.` : `${LABEL[p]} has no reply target any more.`);
    }
    return notes;
  }

  // After a send: what the dock aims at next.
  //   state   { target, returnTo }  — returnTo is where to go back to after a retry
  //   results { twitch?: {ok}, youtube?: {ok} } from POST /api/send
  // Everything sent: clear the box; if this was the retry of a half-sent
  // "both", go back to where the user was. Half sent: keep the text and aim at
  // the chat that didn't get it, so Enter can't double-post to the other one.
  function afterSend(state, results, platforms) {
    const names = Object.keys(results);
    const failed = names.filter(p => !results[p].ok);
    if (!failed.length) {
      if (state.returnTo && usable(platforms, state.returnTo)) {
        return { target: state.returnTo, returnTo: null, clear: true, note: `Back to ${LABEL[state.returnTo]}.` };
      }
      return { target: state.target, returnTo: null, clear: true, note: '' };
    }
    if (failed.length < names.length && usable(platforms, failed[0])) {
      return {
        target: failed[0],
        returnTo: state.returnTo || state.target,
        clear: false,
        note: `Now aiming at ${LABEL[failed[0]]} only — Enter retries it, then it's back to ${LABEL[state.returnTo || state.target]}.`,
      };
    }
    return { target: state.target, returnTo: state.returnTo, clear: false, note: '' };
  }

  return { NAMES, LABEL, usable, usableOne, wanted, limitFor, count, targetLine, expectFor, targetChanges, afterSend };
});
