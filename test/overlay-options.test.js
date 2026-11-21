'use strict';
// The overlay's URL options, from the same file the overlay loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const OO = require('../public/overlay-options');

const q = s => new URLSearchParams(s);

test('bg: a percentage becomes the message background alpha', () => {
  assert.equal(OO.bubbleOpacity(q('bg=88')), 0.88);
  assert.equal(OO.bubbleOpacity(q('bg=62.5')), 0.625);
  assert.equal(OO.bubbleOpacity(q('bg=100')), 1);
  assert.equal(OO.bubbleOpacity(q('size=20&bg=%2040%20')), 0.4);
});

test('bg: zero is a real answer — no background at all', () => {
  assert.equal(OO.bubbleOpacity(q('bg=0')), 0);
});

test('bg: over a hundred is opaque, not an error', () => {
  assert.equal(OO.bubbleOpacity(q('bg=250')), 1);
});

test('bg: absent or junk leaves the stylesheet value alone', () => {
  for (const s of ['', 'bg=', 'bg=dark', 'bg=-20', 'bg=88%25', 'bg=1e2', 'bg=0x10', 'bg=.5', 'bg=NaN']) {
    assert.equal(OO.bubbleOpacity(q(s)), null, s);
  }
});
