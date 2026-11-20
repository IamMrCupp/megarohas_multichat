'use strict';
// The overlay bar's decisions, from the same file the overlay loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const VB = require('../public/viewer-bar');

const q = s => new URLSearchParams(s);

test('format: plain below ten thousand, abbreviated above, never invented', () => {
  assert.equal(VB.format(0), '0');
  assert.equal(VB.format(987), '987');
  assert.equal(VB.format(4467), '4,467');
  assert.equal(VB.format(9999), '9,999');
  assert.equal(VB.format(10000), '10K');
  assert.equal(VB.format(12345), '12.3K');
  assert.equal(VB.format(99950), '99.9K');
  assert.equal(VB.format(123456), '123K');
  assert.equal(VB.format(1234567), '1.2M');
  assert.equal(VB.format(12345, 'full'), '12,345');
  assert.equal(VB.format(1234567, 'full'), '1,234,567');
  for (const bad of [null, undefined, NaN, -1, 'x']) assert.equal(VB.format(bad), '–');
});

test('options: off unless asked for; the bar sits at the edge messages leave by', () => {
  assert.equal(VB.options(q(''), false).on, false);
  assert.equal(VB.options(q('viewers=0'), false).on, false);
  assert.deepEqual(VB.options(q('viewers=1'), false), { on: true, edge: 'top', style: 'beside', hideOffline: false, fmt: 'short' });
  assert.equal(VB.options(q('viewers=1'), true).edge, 'bottom');        // ?dir=top: messages leave at the bottom
  assert.equal(VB.options(q('viewers=top'), true).edge, 'top');
  assert.equal(VB.options(q('viewers=bottom'), false).edge, 'bottom');
  assert.deepEqual(VB.options(q('viewers=1&viewerstyle=inside&viewersoffline=hide&viewersfmt=full'), false),
    { on: true, edge: 'top', style: 'inside', hideOffline: true, fmt: 'full' });
});

test('chips: one per platform that has a source, in a fixed order', () => {
  const viewers = { twitch: { state: 'live', count: 42, note: '' }, youtube: { state: 'live', count: 12345, note: '' } };
  assert.deepEqual(VB.chips(viewers, { fmt: 'short' }), [
    { platform: 'twitch', state: 'live', text: '42', title: 'Twitch: 42 watching' },
    { platform: 'youtube', state: 'live', text: '12.3K', title: 'YouTube: 12,345 watching' },
  ]);
  assert.deepEqual(VB.chips({ twitch: { state: 'none' }, youtube: { state: 'live', count: 7 } }, {}).map(c => c.platform), ['youtube']);
  assert.deepEqual(VB.chips(null, {}), []);
  assert.deepEqual(VB.chips({}, {}), []);
});

test('chips: offline and "can\'t tell" are said, not shown as zero', () => {
  const viewers = {
    twitch: { state: 'unknown', count: null, note: 'Sign in to Twitch on /setup to show viewers.' },
    youtube: { state: 'offline', count: null, note: '' },
  };
  const chips = VB.chips(viewers, {});
  assert.deepEqual(chips[0], { platform: 'twitch', state: 'unknown', text: '–', title: 'Twitch: Sign in to Twitch on /setup to show viewers.' });
  assert.deepEqual(chips[1], { platform: 'youtube', state: 'offline', text: 'off', title: 'YouTube: not live' });
  assert.ok(!chips.some(c => c.text === '0'));
  // a real zero is still a zero
  assert.equal(VB.chips({ twitch: { state: 'live', count: 0 } }, {})[0].text, '0');
  // ?viewersoffline=hide drops everything that isn't live
  assert.deepEqual(VB.chips(viewers, { hideOffline: true }), []);
});

test('bar height: its own height plus the gap to the edge it is pinned to', () => {
  // top bar: 41px tall, 10px from the top (and, being fixed, a large computed bottom)
  assert.equal(VB.barHeight(41, { top: '10px', bottom: '569px' }, 'top', 2), 51);
  // bottom bar: the computed top is its real offset (558px) and must not be used
  assert.equal(VB.barHeight(52, { top: '558px', bottom: '10px' }, 'bottom', 2), 62);
  assert.equal(VB.barHeight(40.2, { top: '10px' }, 'top', 1), 51);
  assert.equal(VB.barHeight(41, { top: '10px' }, 'top', 0), 0);        // no chips: the chat keeps the whole window
  assert.equal(VB.barHeight(41, null, 'top', 1), 41);
});
