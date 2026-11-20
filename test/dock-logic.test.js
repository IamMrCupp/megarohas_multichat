'use strict';
// The dock page's decisions, from the same file the page loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/dock-logic');

const on = (extra = {}) => ({ available: true, signedIn: true, connected: true, as: 'example_user', target: '#examplechannel', targetKey: 'aaaa1111:examplechannel', choices: [{ id: 'aaaa1111', label: '#examplechannel' }], maxLength: 500, detail: '', ...extra });
const both = () => ({ twitch: on(), youtube: on({ as: 'Example Channel', target: 'Example Channel · video FAKEvideo01', targetKey: 'bbbb2222:FAKEvideo01', maxLength: 200 }) });

test('usable: a platform needs a sign-in and a reply target; Both needs both', () => {
  const p = both();
  assert.equal(L.usable(p, 'twitch'), true);
  assert.equal(L.usable(p, 'both'), true);
  p.youtube.connected = false;
  assert.equal(L.usable(p, 'youtube'), false);
  assert.equal(L.usable(p, 'both'), false);
  assert.equal(L.usable(null, 'twitch'), false);
});

test('target lines say, in the page, where each reply goes or why it will not', () => {
  const p = both();
  assert.deepEqual(L.targetLine(p, 'twitch'), { text: 'Twitch → #examplechannel (as example_user)', ok: true });
  assert.equal(L.targetLine(p, 'youtube').text, 'YouTube → Example Channel · video FAKEvideo01 (as Example Channel)');
  assert.deepEqual(L.targetLine({ twitch: on({ signedIn: false }) }, 'twitch'), { text: 'Twitch → not signed in', ok: false, setup: true });
  assert.equal(L.targetLine({ twitch: on({ connected: false, choices: [] }) }, 'twitch').text, 'Twitch → no chat connected in the panel');
  assert.equal(L.targetLine({ twitch: on({ connected: false }) }, 'twitch').text, 'Twitch → no reply target chosen');
  assert.equal(L.targetLine({ youtube: on({ available: false, detail: 'Sending to YouTube isn\'t in this build.' }) }, 'youtube').ok, false);
});

test('a reply target that moved between two reads is announced', () => {
  const before = both();
  const after = both();
  assert.deepEqual(L.targetChanges(before, after), []);
  after.twitch.target = '#someoneelse'; after.twitch.targetKey = 'cccc3333:someoneelse';
  after.youtube.connected = false; after.youtube.target = null; after.youtube.targetKey = null;
  assert.deepEqual(L.targetChanges(before, after), ['Twitch reply target is now #someoneelse.', 'YouTube has no reply target any more.']);
  assert.deepEqual(L.targetChanges(null, after), []);       // first load: nothing to compare
});

test('expect carries the keys on show, for exactly the platforms being sent to', () => {
  const p = both();
  assert.deepEqual(L.expectFor(p, 'twitch'), { twitch: 'aaaa1111:examplechannel' });
  assert.deepEqual(L.expectFor(p, 'both'), { twitch: 'aaaa1111:examplechannel', youtube: 'bbbb2222:FAKEvideo01' });
});

test('counter: the tightest limit of the target, in characters', () => {
  const p = both();
  assert.deepEqual(L.limitFor(p, 'twitch'), { limit: 500, by: 'twitch' });
  assert.deepEqual(L.limitFor(p, 'youtube'), { limit: 200, by: 'youtube' });
  assert.deepEqual(L.limitFor(p, 'both'), { limit: 200, by: 'youtube' });
  assert.equal(L.count('😀😀'), 2);
});

test('after a send: all sent clears the box and stays put', () => {
  const next = L.afterSend({ target: 'both', returnTo: null }, { twitch: { ok: true }, youtube: { ok: true } }, both());
  assert.deepEqual(next, { target: 'both', returnTo: null, clear: true, note: '' });
});

test('after a send: half sent aims at the one that failed, then comes back to Both', () => {
  const p = both();
  // Both: Twitch went through, YouTube didn't
  const half = L.afterSend({ target: 'both', returnTo: null }, { twitch: { ok: true }, youtube: { ok: false } }, p);
  assert.equal(half.target, 'youtube');
  assert.equal(half.returnTo, 'both');
  assert.equal(half.clear, false);
  assert.equal(half.note, 'Now aiming at YouTube only — Enter retries it, then it\'s back to Both.');
  // the retry fails again: still YouTube, still remembers Both
  const again = L.afterSend({ target: half.target, returnTo: half.returnTo }, { youtube: { ok: false } }, p);
  assert.deepEqual([again.target, again.returnTo, again.clear], ['youtube', 'both', false]);
  // the retry succeeds: back to Both, box cleared, and it says so
  const done = L.afterSend({ target: again.target, returnTo: again.returnTo }, { youtube: { ok: true } }, p);
  assert.deepEqual(done, { target: 'both', returnTo: null, clear: true, note: 'Back to Both.' });
});

test('after a send: both failed keeps the text and the target', () => {
  const next = L.afterSend({ target: 'both', returnTo: null }, { twitch: { ok: false }, youtube: { ok: false } }, both());
  assert.deepEqual(next, { target: 'both', returnTo: null, clear: false, note: '' });
});

test('after a send: does not go back to Both if Both stopped being usable', () => {
  const p = both();
  p.twitch.signedIn = false;
  const done = L.afterSend({ target: 'youtube', returnTo: 'both' }, { youtube: { ok: true } }, p);
  assert.deepEqual(done, { target: 'youtube', returnTo: null, clear: true, note: '' });
});
