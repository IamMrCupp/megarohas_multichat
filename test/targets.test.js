'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReplyTargets } = require('../lib/targets');

function world() {
  const sources = [];
  let changes = 0;
  const targets = createReplyTargets({ listSources: () => sources, onChange: () => { changes++; } });
  const add = (id, platform, url, extra = {}) => {
    const entry = { id, platform, url, channel: extra.channel || platform, adapter: platform === 'twitch' ? { channel: extra.channel } : { videoId: extra.videoId || null } };
    sources.push(entry);
    targets.added(entry);
    return entry;
  };
  const remove = entry => { sources.splice(sources.indexOf(entry), 1); targets.removed(entry); };
  return { sources, targets, add, remove, changes: () => changes };
}

test('the only source of a platform becomes its reply target', () => {
  const w = world();
  assert.deepEqual(w.targets.get(), { twitch: { pinned: false, choices: [] }, youtube: { pinned: false, choices: [] } });
  w.add('aaaa1111', 'twitch', 'https://twitch.tv/examplechannel', { channel: 'examplechannel' });
  const t = w.targets.get().twitch;
  assert.equal(t.pinned, true);
  assert.equal(t.channel, 'examplechannel');
  assert.equal(t.label, '#examplechannel');
  assert.equal(t.key, 'aaaa1111:examplechannel');
  assert.equal(w.targets.get().youtube.pinned, false);
});

test('a source added later never takes over — even a YouTube one that is already live', () => {
  const w = world();
  w.add('bbbb2222', 'youtube', 'https://youtube.com/@example/live', { channel: 'Example Channel' });   // mine, not live yet
  w.add('dddd4444', 'youtube', 'https://youtube.com/watch?v=SOMEONEELSE', { channel: 'Someone Else', videoId: 'SOMEONEELSE' });
  const y = w.targets.get().youtube;
  assert.equal(y.sourceId, 'bbbb2222');
  assert.equal(y.videoId, null);
  assert.equal(y.label, 'Example Channel · not live yet');
  assert.deepEqual(y.choices, [{ id: 'bbbb2222', label: 'Example Channel' }, { id: 'dddd4444', label: 'Someone Else' }]);

  w.add('aaaa1111', 'twitch', 'https://twitch.tv/examplechannel', { channel: 'examplechannel' });
  w.add('cccc3333', 'twitch', 'https://twitch.tv/someoneelse', { channel: 'someoneelse' });
  assert.equal(w.targets.get().twitch.channel, 'examplechannel');
});

test('removing the pinned source leaves no target; it does not hop to another', () => {
  const w = world();
  const mine = w.add('aaaa1111', 'twitch', 'https://twitch.tv/examplechannel', { channel: 'examplechannel' });
  w.add('cccc3333', 'twitch', 'https://twitch.tv/someoneelse', { channel: 'someoneelse' });
  w.remove(mine);
  assert.deepEqual(w.targets.get().twitch, { pinned: false, choices: [{ id: 'cccc3333', label: '#someoneelse' }] });
  // a third source arriving doesn't get pinned either: it isn't the only one
  w.add('eeee5555', 'twitch', 'https://twitch.tv/third', { channel: 'third' });
  assert.equal(w.targets.get().twitch.pinned, false);
  // removing a source that isn't pinned changes nothing
  const w2 = world();
  w2.add('aaaa1111', 'twitch', 'https://twitch.tv/examplechannel', { channel: 'examplechannel' });
  const other = w2.add('cccc3333', 'twitch', 'https://twitch.tv/someoneelse', { channel: 'someoneelse' });
  w2.remove(other);
  assert.equal(w2.targets.get().twitch.sourceId, 'aaaa1111');
});

test('an explicit pick moves the target, and only to a real source of that platform', () => {
  const w = world();
  w.add('aaaa1111', 'twitch', 'https://twitch.tv/examplechannel', { channel: 'examplechannel' });
  w.add('cccc3333', 'twitch', 'https://twitch.tv/second', { channel: 'second' });
  w.add('bbbb2222', 'youtube', 'https://youtube.com/@example/live');
  assert.equal(w.targets.set('twitch', 'cccc3333'), true);
  assert.equal(w.targets.get().twitch.channel, 'second');
  assert.equal(w.changes(), 1);
  assert.equal(w.targets.set('twitch', 'bbbb2222'), false);     // a YouTube source
  assert.equal(w.targets.set('twitch', 'nope'), false);
  assert.equal(w.targets.set('discord', 'aaaa1111'), false);
  assert.equal(w.targets.get().twitch.channel, 'second');
  assert.equal(w.changes(), 1);
});

test('the key follows the broadcast, so a page showing the old one is caught', () => {
  const w = world();
  const y = w.add('bbbb2222', 'youtube', 'https://youtube.com/@example/live', { channel: 'Example Channel' });
  const before = w.targets.get().youtube.key;
  y.adapter.videoId = 'FAKEvideo01';
  const after = w.targets.get().youtube;
  assert.notEqual(after.key, before);
  assert.equal(after.key, 'bbbb2222:FAKEvideo01');
  assert.equal(after.label, 'Example Channel · video FAKEvideo01');
});

test('the choice is saved by URL and restored on the next start', () => {
  const w = world();
  w.add('aaaa1111', 'twitch', 'https://twitch.tv/examplechannel', { channel: 'examplechannel' });
  w.add('cccc3333', 'twitch', 'https://twitch.tv/second', { channel: 'second' });
  w.targets.set('twitch', 'cccc3333');
  assert.deepEqual(w.targets.toConfig(), { twitch: 'https://twitch.tv/second' });

  const next = world();     // new run: new ids, same URLs
  next.add('ffff0001', 'twitch', 'https://twitch.tv/examplechannel', { channel: 'examplechannel' });
  next.add('ffff0002', 'twitch', 'https://twitch.tv/second', { channel: 'second' });
  next.targets.restore({ twitch: 'https://twitch.tv/second', youtube: 'https://youtube.com/gone' });
  assert.equal(next.targets.get().twitch.sourceId, 'ffff0002');
  next.targets.restore(undefined);
  next.targets.restore({ twitch: 42 });
  assert.equal(next.targets.get().twitch.sourceId, 'ffff0002');
});
