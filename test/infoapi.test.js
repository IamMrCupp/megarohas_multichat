'use strict';
// The stream info panel's HTTP surface against fake senders: what a save
// sends, what it refuses, the gate, and presets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, fakeSender, fakeInfoSender, request } = require('./helpers');
const { cleanTags, cleanPresets, MAX_PRESETS } = require('../lib/infoapi');

const FORM = { platforms: ['twitch', 'youtube'], title: 'Fixing an example board', tags: ['repair', 'soldering'] };

async function both(t, opts = {}) {
  const twitch = fakeInfoSender(opts.twitch);
  const youtube = fakeInfoSender({ limits: { title: 100 }, search: false, ...(opts.youtube || {}) });
  const app = await startApp({ senders: { twitch, youtube }, ...(opts.app || {}) });
  t.after(app.close);
  return { app, twitch, youtube };
}

test('info state: who is ready, what the limits are, presets — and nothing secret', async t => {
  const { app } = await both(t, { twitch: { needsPermission: true }, app: { presets: [{ name: 'Repair night', title: 'Fixing things', tags: ['repair'] }] } });
  const r = await app.get('/api/info/state');
  assert.equal(r.status, 200);
  const { twitch, youtube } = r.json.platforms;
  assert.deepEqual([twitch.available, twitch.signedIn, twitch.needsPermission, twitch.ready], [true, true, true, false]);
  assert.deepEqual([youtube.ready, youtube.limits.title, youtube.categories], [true, 100, 'list']);
  assert.equal(twitch.categories, 'search');
  assert.deepEqual(r.json.presets, [{ name: 'Repair night', title: 'Fixing things', tags: ['repair'], category: {} }]);
  assert.doesNotMatch(r.text, /token|secret/i);
});

test('info state: a sender that only sends has no stream info', async t => {
  const app = await startApp({ senders: { twitch: fakeSender() } });
  t.after(app.close);
  const r = await app.get('/api/info/state');
  assert.equal(r.json.platforms.twitch.available, false);
  assert.equal(r.json.platforms.youtube.available, false);
  const save = await app.post('/api/info/save', { ...FORM, platforms: ['twitch'] });
  assert.equal(save.json.results.twitch.code, 'unavailable');
});

test('current: what the platform has now, per platform', async t => {
  const { app } = await both(t);
  let r = await app.get('/api/info/current?platform=twitch');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.info.title, 'Old title');
  r = await app.get('/api/info/current?platform=youtube&want=FAKEbroadcast2');
  assert.equal(r.json.info.key, 'FAKEbroadcast2');
  // a want that isn't an ID never reaches the sender
  r = await app.get('/api/info/current?platform=youtube&want=' + encodeURIComponent('../x'));
  assert.equal(r.json.info.key, undefined);
  assert.equal((await app.get('/api/info/current?platform=kick')).status, 400);
});

test('categories: Twitch is searched, YouTube is a list; an empty search asks nobody', async t => {
  const { app } = await both(t);
  let r = await app.get('/api/info/categories?platform=twitch&q=solder');
  assert.deepEqual(r.json.categories, [{ id: '509670', name: 'Example Category solder' }]);
  r = await app.get('/api/info/categories?platform=twitch');
  assert.deepEqual(r.json, { ok: true, categories: [] });
  r = await app.get('/api/info/categories?platform=youtube');
  assert.deepEqual(r.json.categories, [{ id: '28', name: 'Example Science' }]);
});

test('save: one form to both platforms, each told its own category and broadcast', async t => {
  const { app, twitch, youtube } = await both(t);
  const r = await app.post('/api/info/save', {
    ...FORM, title: '  Fixing an\nexample board ', tags: ['repair', ' Repair ', '', 'soldering'],
    category: { twitch: { id: '509670', name: 'Example Category' }, youtube: { id: '28', name: 'Example Science' } },
    expect: { youtube: 'FAKEbroadcast1' },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results, { twitch: { ok: true }, youtube: { ok: true } });
  assert.deepEqual(twitch.saves, [{ title: 'Fixing an example board', tags: ['repair', 'soldering'], categoryId: '509670', expect: undefined }]);
  assert.deepEqual(youtube.saves, [{ title: 'Fixing an example board', tags: ['repair', 'soldering'], categoryId: '28', expect: 'FAKEbroadcast1' }]);
});

test('save: category left alone, cleared, or refused as nonsense — per platform', async t => {
  const { app, twitch, youtube } = await both(t);
  await app.post('/api/info/save', { ...FORM, category: { twitch: null } });
  assert.equal(twitch.saves[0].categoryId, '');          // null clears
  assert.equal(youtube.saves[0].categoryId, undefined);  // absent leaves it alone
  const r = await app.post('/api/info/save', { ...FORM, category: { twitch: { id: 'not an id!' }, youtube: { id: '28' } } });
  assert.equal(r.json.results.twitch.code, 'bad_category');
  assert.equal(r.json.results.youtube.ok, true);
  assert.equal(twitch.saves.length, 1);
});

test('save: one side failing does not hide the other side working', async t => {
  const { app, twitch, youtube } = await both(t, {
    youtube: { reply: { ok: false, code: 'quota_exhausted', reason: 'YouTube API quota is used up for today.', retryAfter: 3600 } },
  });
  const r = await app.post('/api/info/save', FORM);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.twitch, { ok: true });
  assert.deepEqual(r.json.results.youtube, { ok: false, code: 'quota_exhausted', reason: 'YouTube API quota is used up for today.', retryAfter: 3600 });
  assert.equal(twitch.saves.length, 1);
  assert.equal(youtube.saves.length, 1);
});

test('save: a title that fits one platform and not the other saves to neither', async t => {
  const { app, twitch, youtube } = await both(t);
  const title = 'x'.repeat(120);                         // fine for the fake Twitch (140), too long for the fake YouTube (100)
  const r = await app.post('/api/info/save', { ...FORM, title });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'invalid');
  assert.equal(r.json.platform, 'youtube');
  assert.match(r.json.error, /Nothing was saved/);
  assert.equal(twitch.saves.length + youtube.saves.length, 0);
  // the same title to Twitch alone is fine
  assert.equal((await app.post('/api/info/save', { ...FORM, title, platforms: ['twitch'] })).json.results.twitch.ok, true);
});

test('save: bad bodies', async t => {
  const { app, twitch } = await both(t);
  assert.equal((await app.post('/api/info/save', { ...FORM, platforms: [] })).json.code, 'bad_platforms');
  assert.equal((await app.post('/api/info/save', { ...FORM, platforms: ['kick'] })).json.code, 'bad_platforms');
  assert.equal((await app.post('/api/info/save', { ...FORM, title: '   ' })).json.code, 'invalid');
  assert.equal((await app.post('/api/info/save', 'null')).status, 400);
  assert.equal((await app.post('/api/info/save', '{nope')).status, 400);
  assert.equal(twitch.saves.length, 0);
});

test('save: a sender that throws does not leak its error; a note and a cost come through', async t => {
  const { app } = await both(t, {
    twitch: { reply: () => { throw new Error('FAKE_ACCESS_TOKEN in a stack trace'); } },
    youtube: { reply: { ok: true, note: 'Title saved. Tags were not.', cost: 1, accessToken: 'FAKE_SHOULD_NOT_PASS' } },
  });
  const r = await app.post('/api/info/save', FORM);
  assert.deepEqual(r.json.results.twitch, { ok: false, code: 'error', reason: 'Couldn\'t reach Twitch.' });
  assert.deepEqual(r.json.results.youtube, { ok: true, note: 'Title saved. Tags were not.', cost: 1 });
  assert.doesNotMatch(r.text, /FAKE_/);
});

test('info gating: every route refuses what the send endpoint refuses', async t => {
  const { app, twitch } = await both(t);
  const cases = [
    ['no_token', { 'x-dock-token': '' }],
    ['bad_token', { 'x-dock-token': 'not-the-token' }],
    ['bad_host', { host: 'evil.example:' + app.port }],
    ['bad_host', { host: '192.168.1.20:' + app.port }],
    ['bad_origin', { origin: 'https://evil.example' }],
    ['bad_origin', { origin: 'null' }],
    ['bad_origin', { 'sec-fetch-site': 'cross-site' }],
    ['proxied', { 'x-forwarded-for': '203.0.113.9' }],
  ];
  const posts = [['/api/info/save', FORM], ['/api/info/presets', { name: 'x', title: 'y' }], ['/api/info/presets/delete', { name: 'x' }], ['/api/info/nothing', {}]];
  const gets = ['/api/info/state', '/api/info/current?platform=twitch', '/api/info/categories?platform=twitch&q=a', '/api/info/nothing'];
  for (const [code, headers] of cases) {
    for (const [path, body] of posts) {
      const r = await app.post(path, body, headers);
      assert.equal(r.status, 403, `${code} POST ${path}`);
      assert.equal(r.json.code, code, `${code} POST ${path}`);
    }
    for (const path of gets) {
      const r = await app.get(path, headers);
      assert.equal(r.status, 403, `${code} GET ${path}`);
      assert.equal(r.json.code, code, `${code} GET ${path}`);
    }
  }
  // a write with no Origin at all, and any route with no token at all
  let r = await request(app.port, { method: 'POST', path: '/api/info/save', body: FORM, headers: { 'x-dock-token': app.token } });
  assert.equal(r.json.code, 'bad_origin');
  for (const path of gets) assert.equal((await request(app.port, { path })).json.code, 'no_token', path);

  // the right token from the wrong machine
  const lan = await startApp({ senders: { twitch }, remoteAddress: () => '192.168.1.20' });
  t.after(lan.close);
  assert.equal((await lan.post('/api/info/save', FORM)).json.code, 'not_loopback');
  assert.equal((await lan.get('/api/info/state')).json.code, 'not_loopback');

  assert.equal(twitch.saves.length, 0);
  assert.deepEqual(app.kept.presets, []);
  // unknown paths under /api/info/ are answered here, gated; others fall through
  assert.equal((await app.get('/api/info/nothing')).status, 404);
  assert.equal((await app.get('/api/infox')).text, 'not found');
});

test('a copy that does not own sending does not touch stream info either', async t => {
  const { app, twitch } = await both(t, { app: { disabled: () => 'Sending is off here: another copy (pid 4242) owns it.' } });
  const st = await app.get('/api/info/state');
  assert.equal(st.json.platforms.twitch.available, false);
  assert.match(st.json.platforms.twitch.detail, /pid 4242/);
  assert.match(st.json.notices[0], /pid 4242/);
  const r = await app.post('/api/info/save', FORM);
  assert.equal(r.json.results.twitch.code, 'sending_disabled');
  assert.equal((await app.get('/api/info/current?platform=twitch')).json.code, 'sending_disabled');
  assert.equal(twitch.saves.length, 0);
});

test('presets: kept by name, replaced whatever the case, deleted, capped — and never sent anywhere', async t => {
  const { app, twitch, youtube } = await both(t);
  let r = await app.post('/api/info/presets', {
    name: '  Repair night ', title: 'Fixing an example board', tags: ['repair', 'repair', 'soldering'],
    category: { twitch: { id: '509670', name: 'Example Category' }, youtube: { id: 'bad id' }, kick: { id: '1' } },
    accessToken: 'FAKE_SHOULD_NOT_BE_KEPT',
  });
  assert.equal(r.status, 200);
  assert.deepEqual(app.kept.presets, [{
    name: 'Repair night', title: 'Fixing an example board', tags: ['repair', 'soldering'],
    category: { twitch: { id: '509670', name: 'Example Category' } },
  }]);
  r = await app.post('/api/info/presets', { name: 'REPAIR NIGHT', title: 'New title' });
  assert.equal(r.json.presets.length, 1);
  assert.equal(r.json.presets[0].title, 'New title');
  assert.equal((await app.post('/api/info/presets', { name: '   ' })).json.code, 'bad_preset');
  r = await app.post('/api/info/presets/delete', { name: 'repair night' });
  assert.deepEqual(r.json.presets, []);
  for (let i = 0; i < MAX_PRESETS; i++) assert.equal((await app.post('/api/info/presets', { name: 'p' + i })).status, 200);
  assert.equal((await app.post('/api/info/presets', { name: 'one too many' })).json.code, 'too_many');
  assert.equal((await app.post('/api/info/presets', { name: 'P0', title: 'replacing is still fine' })).status, 200);
  assert.equal(twitch.saves.length + youtube.saves.length, 0);
});

test('presets and tags from a hand-edited config are cleaned, not trusted', () => {
  assert.deepEqual(cleanPresets('nope'), []);
  assert.deepEqual(cleanPresets([null, 7, { title: 'no name' }, { name: 'ok', tags: 'nope', category: 'nope' }, { name: 'OK' }]),
    [{ name: 'ok', title: '', tags: [], category: {} }]);
  assert.equal(cleanPresets(Array.from({ length: 80 }, (_, i) => ({ name: 'n' + i }))).length, MAX_PRESETS);
  assert.deepEqual(cleanTags([' a ', 'A', 5, null, 'b\nc']), ['a', 'b c']);
  assert.equal(cleanTags(Array.from({ length: 500 }, (_, i) => 't' + i)).length, 50);
});
