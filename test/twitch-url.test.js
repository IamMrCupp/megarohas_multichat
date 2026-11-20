'use strict';
// channelFromUrl is pure: no socket is opened by requiring lib/twitch.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { channelFromUrl } = require('../lib/twitch');

test('plain channel links', () => {
  assert.equal(channelFromUrl('https://www.twitch.tv/ExampleChannel'), 'examplechannel');
  assert.equal(channelFromUrl('twitch.tv/example_channel'), 'example_channel');
  assert.equal(channelFromUrl('https://m.twitch.tv/examplechannel'), 'examplechannel');
});

test('popout, moderator, embed and dashboard links', () => {
  assert.equal(channelFromUrl('https://www.twitch.tv/popout/examplechannel/chat'), 'examplechannel');
  assert.equal(channelFromUrl('https://www.twitch.tv/moderator/examplechannel'), 'examplechannel');
  assert.equal(channelFromUrl('https://www.twitch.tv/embed/examplechannel/chat'), 'examplechannel');
  assert.equal(channelFromUrl('https://dashboard.twitch.tv/u/examplechannel/home'), 'examplechannel');
  assert.equal(channelFromUrl('https://player.twitch.tv/?channel=examplechannel'), 'examplechannel');
});

test('things that are not a channel', () => {
  assert.equal(channelFromUrl('https://www.twitch.tv/'), null);
  assert.equal(channelFromUrl('https://www.twitch.tv/directory'), null);
  assert.equal(channelFromUrl('https://www.twitch.tv/settings'), null);
  assert.equal(channelFromUrl('https://example.com/examplechannel'), null);
  assert.equal(channelFromUrl('https://www.twitch.tv/x'), null);
  assert.equal(channelFromUrl('not a url at all'), null);
});
