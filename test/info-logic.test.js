'use strict';
// The stream info page's own decisions (public/info-logic.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/info-logic.js');

const PLATFORMS = {
  twitch: { ready: true, limits: { title: 140, tags: 10, tagLength: 25 } },
  youtube: { ready: true, limits: { title: 100, tagsTotal: 500 } },
};
const BOTH = ['twitch', 'youtube'];

test('tags as typed: split on commas and new lines, trimmed, repeats dropped whatever the case', () => {
  assert.deepEqual(L.parseTags(' repair, soldering,,Repair\n two   words ,'), ['repair', 'soldering', 'two words']);
  assert.deepEqual(L.parseTags(''), []);
  assert.deepEqual(L.parseTags(null), []);
});

test('a save goes to the platforms that are ticked and ready, nowhere else', () => {
  assert.deepEqual(L.wanted(PLATFORMS, { twitch: true, youtube: true }), BOTH);
  assert.deepEqual(L.wanted(PLATFORMS, { twitch: true, youtube: false }), ['twitch']);
  assert.deepEqual(L.wanted({ ...PLATFORMS, youtube: { ready: false } }, { twitch: true, youtube: true }), ['twitch']);
  assert.deepEqual(L.wanted(null, { twitch: true, youtube: true }), []);
});

test('the title counter uses the tightest limit among the platforms being saved to', () => {
  assert.deepEqual(L.titleLimit(PLATFORMS, BOTH), { limit: 100, by: 'youtube' });
  assert.deepEqual(L.titleLimit(PLATFORMS, ['twitch']), { limit: 140, by: 'twitch' });
  assert.deepEqual(L.titleLimit(PLATFORMS, []), { limit: 0, by: null });
});

test('what stops a save, said in the page before the server is asked', () => {
  const ok = { title: 'Fixing an example board', tags: ['repair', 'soldering'] };
  assert.equal(L.problem(PLATFORMS, BOTH, ok), '');
  assert.match(L.problem(PLATFORMS, [], ok), /Nothing to save to/);
  assert.match(L.problem(PLATFORMS, BOTH, { ...ok, title: '  ' }), /title is needed/);
  assert.match(L.problem(PLATFORMS, BOTH, { ...ok, title: 'x'.repeat(120) }), /Too long for YouTube — 100/);
  assert.equal(L.problem(PLATFORMS, ['twitch'], { ...ok, title: 'x'.repeat(120) }), '');
  assert.match(L.problem(PLATFORMS, ['twitch'], { ...ok, title: 'x'.repeat(141) }), /Too long for Twitch — 140/);
  assert.match(L.problem(PLATFORMS, BOTH, { ...ok, title: 'a <b>' }), /< or >/);
  assert.equal(L.problem(PLATFORMS, ['twitch'], { ...ok, title: 'a <b>' }), '');
  // a tag with a space is fine on YouTube and not on Twitch
  assert.match(L.problem(PLATFORMS, BOTH, { ...ok, tags: ['two words'] }), /Twitch tags can't contain spaces/);
  assert.equal(L.problem(PLATFORMS, ['youtube'], { ...ok, tags: ['two words'] }), '');
  assert.match(L.problem(PLATFORMS, BOTH, { ...ok, tags: Array.from({ length: 11 }, (_, i) => 't' + i) }), /10 tags at most, this is 11/);
  assert.match(L.problem(PLATFORMS, BOTH, { ...ok, tags: ['x'.repeat(26)] }), /25 characters/);
  assert.match(L.problem(PLATFORMS, ['youtube'], { ...ok, tags: ['x'.repeat(499), 'y'] }), /500/);
  assert.equal(L.youtubeTagsLength(['Foo-Baz', 'Foo Baz']), 17);
});

test('what is shown as "now", and how a result reads', () => {
  assert.equal(L.nowLine('twitch', undefined), 'Twitch: not loaded');
  assert.equal(L.nowLine('youtube', { ok: false, reason: 'No live or upcoming broadcast on this channel.' }), 'YouTube: No live or upcoming broadcast on this channel.');
  assert.equal(L.nowLine('twitch', { ok: true, info: { title: 'Old title', category: { id: '100', name: 'Old Category' }, tags: ['a', 'b'], where: '#examplechannel' } }),
    '#examplechannel: Old title · Old Category · a, b');
  assert.equal(L.nowLine('youtube', { ok: true, info: { title: '', category: { id: '22', name: '' }, tags: [], where: 'YouTube (upcoming)' } }),
    'YouTube (upcoming): (no title) · category 22');
  assert.deepEqual(L.resultLine('twitch', { ok: true }), { ok: true, text: 'Twitch: saved' });
  assert.deepEqual(L.resultLine('youtube', { ok: true, note: 'Tags were not.' }), { ok: true, text: 'YouTube: saved — Tags were not.' });
  assert.deepEqual(L.resultLine('twitch', { ok: false, reason: 'rate limit', retryAfter: 29.2 }), { ok: false, text: 'Twitch: not saved — rate limit (try again in 30s)' });
});

test('what a save sends: only the chosen platforms, the broadcast on show, and a category only where one was picked', () => {
  const current = { youtube: { ok: true, info: { key: 'FAKElive001' } }, twitch: { ok: true, info: {} } };
  const form = { title: '  Fixing an example board ', tags: ['repair'], category: { twitch: { id: '509670', name: 'Example Category' }, youtube: undefined } };
  assert.deepEqual(L.payload(BOTH, form, current), {
    platforms: BOTH, title: 'Fixing an example board', tags: ['repair'],
    category: { twitch: { id: '509670', name: 'Example Category' } }, expect: { youtube: 'FAKElive001' },
  });
  // Twitch cleared on purpose is sent as null; untouched is not sent at all
  assert.deepEqual(L.payload(['twitch'], { ...form, category: { twitch: null } }, current).category, { twitch: null });
  assert.deepEqual(L.payload(['twitch'], { ...form, category: { twitch: undefined } }, current).category, {});
  // a failed read gives nothing to expect, so the server will refuse the YouTube half
  assert.deepEqual(L.payload(['youtube'], form, { youtube: { ok: false, reason: 'x' } }).expect, {});
});
