'use strict';
// Whose broadcast a watch page is: the one thing read off the page to notice
// a reply sign-in that landed on a different channel.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ownerChannelId } = require('../lib/youtube');

const OWNER = 'UCfakefakefakefakefakefa';
const page = details => `<html><script>var ytInitialPlayerResponse = {"responseContext":{},"videoDetails":${details},"microformat":{}};</script>`
  + '<script>var ytInitialData = {"contents":[{"channelId":"UCrecommendedrecommended"}]};</script></html>';

test('owner channel: videoDetails.channelId, past a long title and keywords', () => {
  const details = `{"videoId":"FAKEvideo01","title":"${'Fixing an example board '.repeat(4)}","lengthSeconds":"0","keywords":[${Array.from({ length: 60 }, (_, i) => `"keyword ${i}"`).join(',')}],"channelId":"${OWNER}","isOwnerViewing":false}`;
  assert.equal(ownerChannelId(page(details)), OWNER);
});

test('owner channel: not some other channel mentioned earlier or later on the page', () => {
  const html = '<script>{"channelId":"UCearlierearlierearlier1"}</script>' + page(`{"videoId":"FAKEvideo01","title":"t","channelId":"${OWNER}"}`);
  assert.equal(ownerChannelId(html), OWNER);
});

test('owner channel: a page that does not say is null, not a guess', () => {
  assert.equal(ownerChannelId(''), null);
  assert.equal(ownerChannelId(null), null);
  assert.equal(ownerChannelId('<html>consent wall</html>'), null);
  assert.equal(ownerChannelId('{"channelId":"UCnotinsidevideodetails1"}'), null);
  assert.equal(ownerChannelId(page('{"videoId":"FAKEvideo01","title":"t","channelId":"not-a-channel-id"}')), null);
});
