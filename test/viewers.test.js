'use strict';
// Viewer counts: the YouTube parser against the shape captured from the
// real interface, the fetch against a fake YouTube, and the poller's states.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createViewerCounts, fetchYouTubeViewers, parseYouTubeViewers } = require('../lib/viewers');
const { fakeUpstream } = require('./helpers');

// As returned by youtubei/v1/updated_metadata for a live video (2026-11), trimmed.
const liveMeta = (n, text) => ({
  responseContext: {},
  continuation: { timedContinuationData: { timeoutMs: 5000, continuation: 'FAKE_CONTINUATION' } },
  actions: [
    { clickTrackingParams: 'x', updateViewershipAction: { viewCount: { videoViewCountRenderer: {
      viewCount: { simpleText: text || `${n.toLocaleString('en-US')} watching now` }, isLive: true,
      extraShortViewCount: { simpleText: '4.4K' }, unlabeledViewCountValue: { simpleText: n.toLocaleString('en-US') },
      ...(text ? {} : { originalViewCount: String(n) }),
    } } } },
    { clickTrackingParams: 'x', updateDateTextAction: {} },
    { clickTrackingParams: 'x', updateTitleAction: {} },
  ],
});

test('parse: live count, not live, and shapes it can\'t read', () => {
  assert.deepEqual(parseYouTubeViewers(liveMeta(4467)), { live: true, count: 4467 });
  assert.deepEqual(parseYouTubeViewers(liveMeta(0)), { live: true, count: 0 });
  // no originalViewCount: fall back to the text, in whatever grouping the locale used
  assert.deepEqual(parseYouTubeViewers(liveMeta(0, '4,467 watching now')), { live: true, count: 4467 });
  assert.deepEqual(parseYouTubeViewers(liveMeta(0, '4.467 Zuschauer')), { live: true, count: 4467 });
  assert.deepEqual(parseYouTubeViewers(liveMeta(0, 'watching now')), null);
  // a finished stream or an ordinary video: a view count, isLive absent
  assert.deepEqual(parseYouTubeViewers({ actions: [{ updateViewershipAction: { viewCount: { videoViewCountRenderer: { viewCount: { simpleText: '651,847,120 views' }, originalViewCount: '651847120' } } } }] }), { live: false, count: null });
  for (const junk of [null, {}, { actions: [] }, { actions: [{ updateTitleAction: {} }] }, { actions: [null, 5] }]) assert.equal(parseYouTubeViewers(junk), null);
});

test('fetch: asks the watch page\'s interface for one video, and nothing official', async t => {
  const up = await fakeUpstream({ 'POST /youtubei/v1/updated_metadata': () => [200, liveMeta(152)] });
  t.after(up.close);
  const r = await fetchYouTubeViewers({ videoId: 'FAKEvideo01', apiKey: 'FAKE_INNERTUBE_KEY', clientVersion: '2.20261119.07.00', origin: up.base });
  assert.deepEqual(r, { live: true, count: 152 });
  assert.equal(up.calls.length, 1);
  assert.deepEqual(up.calls[0].query, { key: 'FAKE_INNERTUBE_KEY', prettyPrint: 'false' });
  assert.equal(up.calls[0].body.videoId, 'FAKEvideo01');
  assert.equal(up.calls[0].body.context.client.clientVersion, '2.20261119.07.00');
  assert.equal(up.calls[0].headers.authorization, undefined);     // anonymous: no token goes near it
  up.routes['POST /youtubei/v1/updated_metadata'] = () => [429, {}];
  assert.equal(await fetchYouTubeViewers({ videoId: 'FAKEvideo01', origin: up.base }), null);
});

function world({ twitch, youtube } = {}) {
  const sources = [];
  const changes = [];
  const calls = { twitch: [], youtube: [] };
  const vc = createViewerCounts({
    listSources: () => sources,
    twitch: async logins => { calls.twitch.push(logins); return twitch ? twitch(logins) : { state: 'ok', live: {} }; },
    youtube: async adapter => { calls.youtube.push(adapter.videoId); return youtube ? youtube(adapter) : { live: true, count: 1 }; },
    onChange: c => changes.push(JSON.parse(JSON.stringify(c))),
  });
  return { sources, changes, calls, vc };
}
const tw = channel => ({ platform: 'twitch', adapter: { channel } });
const yt = videoId => ({ platform: 'youtube', adapter: { videoId } });
const NONE = { state: 'none', count: null, note: '' };

test('poller: no sources, no chips, no requests', async () => {
  const w = world();
  assert.deepEqual(await w.vc.refresh(), { twitch: NONE, youtube: NONE });
  assert.deepEqual(w.calls, { twitch: [], youtube: [] });
  assert.equal(w.changes.length, 0);
});

test('poller: live counts, and a change is announced once', async () => {
  let n = 42;
  const w = world({ twitch: () => ({ state: 'ok', live: { examplechannel: n } }), youtube: () => ({ live: true, count: 17 }) });
  w.sources.push(tw('examplechannel'), yt('FAKEvideo01'));
  assert.deepEqual(await w.vc.refresh(), { twitch: { state: 'live', count: 42, note: '' }, youtube: { state: 'live', count: 17, note: '' } });
  await w.vc.refresh();
  assert.equal(w.changes.length, 1);                 // same numbers: nothing broadcast
  n = 43;
  await w.vc.refresh();
  assert.equal(w.changes.length, 2);
  assert.equal(w.changes[1].twitch.count, 43);
  assert.deepEqual(w.calls.twitch[0], ['examplechannel']);
  assert.deepEqual(w.vc.get(), w.changes[1]);
});

test('poller: offline is offline, not zero', async () => {
  const w = world({ twitch: () => ({ state: 'ok', live: {} }), youtube: () => ({ live: false, count: null }) });
  w.sources.push(tw('examplechannel'), yt('FAKEvideo01'));
  assert.deepEqual(await w.vc.refresh(), { twitch: { state: 'offline', count: null, note: '' }, youtube: { state: 'offline', count: null, note: '' } });
  // a YouTube source whose reader hasn't found a broadcast: offline, and nothing is asked
  const w2 = world();
  w2.sources.push(yt(null));
  assert.equal((await w2.vc.refresh()).youtube.state, 'offline');
  assert.deepEqual(w2.calls.youtube, []);
});

test('poller: Twitch not signed in says so instead of guessing', async () => {
  const w = world({ twitch: () => ({ state: 'signed_out', note: 'Sign in to Twitch on /setup to show viewers.' }) });
  w.sources.push(tw('examplechannel'));
  assert.deepEqual((await w.vc.refresh()).twitch, { state: 'unknown', count: null, note: 'Sign in to Twitch on /setup to show viewers.' });
});

test('poller: a failed poll keeps the last number briefly, then admits it doesn\'t know', async () => {
  let ok = true;
  const w = world({
    twitch: () => (ok ? { state: 'ok', live: { examplechannel: 42 } } : { state: 'error', note: 'Couldn\'t reach Twitch.' }),
    youtube: () => { if (!ok) throw new Error('network'); return { live: true, count: 17 }; },
  });
  w.sources.push(tw('examplechannel'), yt('FAKEvideo01'));
  await w.vc.refresh();
  ok = false;
  for (let i = 0; i < 2; i++) {
    const c = await w.vc.refresh();
    assert.deepEqual([c.twitch.count, c.youtube.count], [42, 17], 'poll ' + i);
  }
  const gone = await w.vc.refresh();
  assert.deepEqual(gone.twitch, { state: 'unknown', count: null, note: 'Couldn\'t reach Twitch.' });
  assert.deepEqual(gone.youtube, { state: 'unknown', count: null, note: 'Couldn\'t read the count from YouTube.' });
  ok = true;
  assert.equal((await w.vc.refresh()).twitch.count, 42);
});

test('poller: several sources of one platform add up; duplicates are asked once', async () => {
  const w = world({
    twitch: () => ({ state: 'ok', live: { examplechannel: 40, second: 2 } }),
    youtube: a => (a.videoId === 'FAKEvideo01' ? { live: true, count: 10 } : { live: false, count: null }),
  });
  w.sources.push(tw('examplechannel'), tw('second'), tw('examplechannel'), tw('third'), yt('FAKEvideo01'), yt('FAKEvideo02'));
  const c = await w.vc.refresh();
  assert.equal(c.twitch.count, 42);
  assert.equal(c.youtube.count, 10);
  assert.deepEqual(w.calls.twitch[0], ['examplechannel', 'second', 'third']);
});

test('poller: the timer only polls while a page is connected', async () => {
  let looking = false;
  let polls = 0;
  const vc = createViewerCounts({
    listSources: () => [tw('examplechannel')],
    twitch: async () => { polls++; return { state: 'ok', live: {} }; },
    youtube: async () => null,
    active: () => looking,
    intervalMs: 5,
  });
  vc.start();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(polls, 0);
  looking = true;
  await new Promise(r => setTimeout(r, 40));
  assert.ok(polls >= 1);
  vc.stop();
  const after = polls;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(polls, after);
});

test('poller: after a sign-in it asks again, even if a poll was already on the wire', async () => {
  // The poll in flight asked before the sign-in and will say "signed out".
  // refreshNow must not hand that stale answer back as the fresh one.
  let signedIn = false;
  let release;
  const held = new Promise(r => { release = r; });
  let first = true;
  const w = world({
    twitch: async () => {
      const answer = signedIn ? { state: 'ok', live: { examplechannel: 42 } } : { state: 'signed_out', note: 'Sign in to Twitch on /setup to show viewers.' };
      if (first) { first = false; await held; }
      return answer;
    },
  });
  w.sources.push(tw('examplechannel'));
  const inFlight = w.vc.refresh();
  await new Promise(r => setImmediate(r));
  signedIn = true;
  const after = w.vc.refreshNow();
  release();
  assert.equal((await inFlight).twitch.state, 'unknown');
  assert.deepEqual((await after).twitch, { state: 'live', count: 42, note: '' });
  assert.equal(w.calls.twitch.length, 2);
  assert.deepEqual(w.changes.map(c => c.twitch.state), ['unknown', 'live']);
  // with nothing in flight it's just a poll
  await w.vc.refreshNow();
  assert.equal(w.calls.twitch.length, 3);
});

// As returned on 2026-11-23 for a broadcast that was scheduled and not yet
// started, with one browser on its page. Trimmed.
const waitingMeta = (n, { text, date = 'Scheduled for Nov 22, 2026' } = {}) => ({
  actions: [
    { updateViewershipAction: { viewCount: { videoViewCountRenderer: {
      viewCount: { simpleText: text || `${n} waiting` }, isLive: true,
      extraShortViewCount: { simpleText: String(n) }, unlabeledViewCountValue: { simpleText: String(n) }, originalViewCount: String(n),
    } } } },
    { updateDateTextAction: { dateText: { simpleText: date } } },
    { updateTitleAction: {} },
  ],
});

test('parse: people waiting for a broadcast to start are not people watching it', () => {
  assert.deepEqual(parseYouTubeViewers(waitingMeta(1)), { live: false, count: null });
  assert.deepEqual(parseYouTubeViewers(waitingMeta(250)), { live: false, count: null });
  // either sign is enough on its own
  assert.deepEqual(parseYouTubeViewers(waitingMeta(1, { date: '' })), { live: false, count: null });
  assert.deepEqual(parseYouTubeViewers(waitingMeta(1, { text: '1 watching now' })), { live: false, count: null });
  assert.deepEqual(parseYouTubeViewers(waitingMeta(1, { text: 'Waiting', date: '' })), { live: false, count: null });
  // once it has started, the same shape counts again
  assert.deepEqual(parseYouTubeViewers(waitingMeta(7, { text: '7 watching now', date: 'Started streaming 4 minutes ago' })), { live: true, count: 7 });
  // wording this doesn't recognise is counted, as it was before
  assert.deepEqual(parseYouTubeViewers(waitingMeta(7, { text: '7 Zuschauer', date: 'Livestream vom 22.11.2026' })), { live: true, count: 7 });
  // a title with the word in it is not a sign of anything
  const live = liveMeta(12);
  live.actions.push({ updateTitleAction: { title: { simpleText: 'Scheduled maintenance, waiting on parts' } } });
  assert.deepEqual(parseYouTubeViewers(live), { live: true, count: 12 });
});

test('the bar shows no YouTube number while the broadcast is only scheduled', async () => {
  const source = { platform: 'youtube', adapter: { videoId: 'FAKEvideo01' } };
  let answer = parseYouTubeViewers(waitingMeta(1));
  const counts = createViewerCounts({ listSources: () => [source], twitch: async () => ({ state: 'ok', live: {} }), youtube: async () => answer });
  assert.deepEqual((await counts.refresh()).youtube, { state: 'offline', count: null, note: '' });
  answer = parseYouTubeViewers(liveMeta(3));
  assert.deepEqual((await counts.refresh()).youtube, { state: 'live', count: 3, note: '' });
});
