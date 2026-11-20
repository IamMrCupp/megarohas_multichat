'use strict';
// The dock's endpoints over real HTTP, with a fake sender behind them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, fakeSender, request, TARGETS } = require('./helpers');

test('session hands the dock its token and platform state', async t => {
  const app = await startApp({ senders: { twitch: fakeSender() } });
  t.after(app.close);
  const r = await request(app.port, { path: '/api/dock/session' });
  assert.equal(r.status, 200);
  assert.equal(r.json.token, app.token);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(r.json.platforms.twitch, {
    available: true, configured: true, signedIn: true, as: 'example_user', detail: '',
    connected: true, target: '#examplechannel', targetKey: 'aaaa1111:examplechannel',
    choices: [{ id: 'aaaa1111', label: '#examplechannel' }], maxLength: 500,
  });
  assert.equal(r.json.platforms.youtube.available, false);
  assert.equal(r.json.platforms.youtube.signedIn, false);
});

test('session refuses a foreign Host, a foreign Origin and a LAN client', async t => {
  const app = await startApp({ senders: { twitch: fakeSender() } });
  t.after(app.close);
  let r = await request(app.port, { path: '/api/dock/session', headers: { host: 'evil.example:' + app.port } });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'bad_host'); assert.equal(r.json.token, undefined);
  r = await request(app.port, { path: '/api/dock/session', headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'bad_origin'); assert.equal(r.json.token, undefined);
  r = await request(app.port, { path: '/api/dock/session', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403); assert.equal(r.json.token, undefined);

  const lan = await startApp({ senders: { twitch: fakeSender() }, remoteAddress: () => '192.168.1.20' });
  t.after(lan.close);
  r = await request(lan.port, { path: '/api/dock/session' });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'not_loopback'); assert.equal(r.json.token, undefined);
});

test('send: one platform', async t => {
  const twitch = fakeSender();
  const app = await startApp({ senders: { twitch } });
  t.after(app.close);
  const r = await app.post('/api/send', { target: 'twitch', text: '  hello chat  ' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { results: { twitch: { ok: true, id: 'fake-1' } } });
  assert.equal(twitch.sent.length, 1);
  assert.equal(twitch.sent[0].text, 'hello chat');
  assert.equal(twitch.sent[0].target.channel, 'examplechannel');
});

test('send: both, where one fails with the platform\'s reason', async t => {
  const twitch = fakeSender();
  const youtube = fakeSender({ reply: { ok: false, code: 'liveChatDisabled', reason: 'The owner disabled live chat.' } });
  const app = await startApp({ senders: { twitch, youtube } });
  t.after(app.close);
  const r = await app.post('/api/send', { target: 'both', text: 'hi' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.twitch, { ok: true, id: 'fake-1' });
  assert.deepEqual(r.json.results.youtube, { ok: false, code: 'liveChatDisabled', reason: 'The owner disabled live chat.' });
});

test('send: not signed in, no chat connected, platform not built', async t => {
  const twitch = fakeSender({ signedIn: false });
  const youtube = fakeSender();
  const app = await startApp({ senders: { twitch, youtube }, targets: { twitch: TARGETS.twitch, youtube: { pinned: false, choices: [] } } });
  t.after(app.close);
  const r = await app.post('/api/send', { target: 'both', text: 'hi' });
  assert.equal(r.json.results.twitch.code, 'not_signed_in');
  assert.equal(r.json.results.youtube.code, 'no_target');
  assert.equal(twitch.sent.length + youtube.sent.length, 0);

  const bare = await startApp({});
  t.after(bare.close);
  const b = await bare.post('/api/send', { target: 'twitch', text: 'hi' });
  assert.equal(b.json.results.twitch.code, 'unavailable');
});

test('send: rate limit carries retryAfter; a throwing sender does not leak its error', async t => {
  const twitch = fakeSender({ reply: { ok: false, code: 'rate_limited', reason: 'Twitch rate limit hit.', retryAfter: 12 } });
  const youtube = fakeSender({ reply: () => { throw new Error('boom with secret-looking detail FAKE_TOKEN_abc'); } });
  const app = await startApp({ senders: { twitch, youtube } });
  t.after(app.close);
  const r = await app.post('/api/send', { target: 'both', text: 'hi' });
  assert.deepEqual(r.json.results.twitch, { ok: false, code: 'rate_limited', reason: 'Twitch rate limit hit.', retryAfter: 12 });
  assert.equal(r.json.results.youtube.code, 'error');
  assert.ok(!r.text.includes('FAKE_TOKEN_abc'));
});

test('send: bad bodies', async t => {
  const twitch = fakeSender();
  const app = await startApp({ senders: { twitch } });
  t.after(app.close);
  assert.equal((await app.post('/api/send', { target: 'discord', text: 'hi' })).json.code, 'bad_target');
  assert.equal((await app.post('/api/send', { target: 'twitch', text: '   ' })).json.code, 'empty');
  assert.equal((await app.post('/api/send', { target: 'twitch' })).json.code, 'empty');
  assert.equal((await app.post('/api/send', { target: 'twitch', text: 'x'.repeat(501) })).json.code, 'too_long');
  assert.equal((await app.post('/api/send', '{not json')).json.code, 'bad_request');
  // valid JSON that isn't an object is a 400, not a crash
  for (const raw of ['null', '42', '"text"', '[]', 'true']) {
    const r = await app.post('/api/send', raw);
    assert.equal(r.status, 400, raw);
    assert.equal(r.json.code, 'bad_request', raw);
  }
  assert.equal((await app.post('/api/send', { target: 'twitch', text: 'x'.repeat(500) })).status, 200);
  assert.equal((await app.post('/api/send', { target: 'twitch', text: 'a\r\nb' })).status, 200);
  assert.equal(twitch.sent[1].text, 'a b');
  assert.equal(twitch.sent.length, 2);
});

test('send gating: no token, wrong token, foreign Host, cross-origin, non-loopback', async t => {
  const twitch = fakeSender();
  const app = await startApp({ senders: { twitch } });
  t.after(app.close);
  const body = { target: 'twitch', text: 'should never arrive' };
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
  for (const [code, headers] of cases) {
    const r = await app.post('/api/send', body, headers);
    assert.equal(r.status, 403, code);
    assert.equal(r.json.code, code);
  }
  // no Origin header at all
  let r = await request(app.port, { method: 'POST', path: '/api/send', body, headers: { 'x-dock-token': app.token } });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'bad_origin');
  // no token header at all
  r = await request(app.port, { method: 'POST', path: '/api/send', body, headers: { origin: app.origin } });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'no_token');

  // the right token from the wrong machine
  const lan = await startApp({ senders: { twitch }, remoteAddress: () => '192.168.1.20' });
  t.after(lan.close);
  r = await lan.post('/api/send', body);
  assert.equal(r.status, 403); assert.equal(r.json.code, 'not_loopback');

  assert.equal(twitch.sent.length, 0);
});

test('setup state is gated the same way and carries no secrets', async t => {
  const twitch = fakeSender();
  const app = await startApp({ senders: { twitch } });
  t.after(app.close);
  assert.equal((await request(app.port, { path: '/api/setup/state' })).json.code, 'no_token');
  assert.equal((await app.get('/api/setup/state', { host: 'evil.example' })).json.code, 'bad_host');
  const r = await app.get('/api/setup/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.platforms.twitch.signedIn, true);
  assert.equal((await app.post('/api/setup/twitch/signin', {})).status, 404);
  assert.equal((await app.post('/api/setup/twitch/signin', {}, { 'x-dock-token': 'nope' })).status, 403);
});

test('routes that are not ours fall through', async t => {
  const app = await startApp({});
  t.after(app.close);
  assert.equal((await request(app.port, { path: '/overlay' })).status, 404);
  assert.equal((await request(app.port, { method: 'PUT', path: '/api/send' })).status, 404);
});

test('reply target: a send only goes where the page said it would', async t => {
  const twitch = fakeSender();
  let targets = { twitch: TARGETS.twitch, youtube: { pinned: false, choices: [] } };
  const app = await startApp({ senders: { twitch }, targets: () => targets });
  t.after(app.close);
  const shown = TARGETS.twitch.key;

  // the source list changed under the page: another channel is now the target
  targets = { ...targets, twitch: { ...TARGETS.twitch, sourceId: 'cccc3333', channel: 'someoneelse', label: '#someoneelse', key: 'cccc3333:someoneelse' } };
  let r = await app.post('/api/send', { target: 'twitch', text: 'meant for my chat', expect: { twitch: shown } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.twitch, { ok: false, code: 'target_changed', reason: 'The Twitch reply target is now #someoneelse — check it and send again.' });
  // a page that says nothing about where it thinks it's sending is refused too
  r = await app.post('/api/send', { target: 'twitch', text: 'x', expect: {} });
  assert.equal(r.json.results.twitch.code, 'target_changed');
  r = await app.post('/api/send', { target: 'twitch', text: 'x', expect: { twitch: 42 } });
  assert.equal(r.json.results.twitch.code, 'target_changed');
  assert.equal(twitch.sent.length, 0);

  // the pinned source went away: no target, and no hop to another source
  targets = { ...targets, twitch: { pinned: false, choices: [{ id: 'cccc3333', label: '#someoneelse' }] } };
  r = await app.post('/api/send', { target: 'twitch', text: 'x', expect: { twitch: shown } });
  assert.deepEqual(r.json.results.twitch, { ok: false, code: 'no_target', reason: 'No Twitch reply target is chosen — pick one in the dock.' });
  const session = await request(app.port, { path: '/api/dock/session' });
  assert.equal(session.json.platforms.twitch.connected, false);
  assert.equal(session.json.platforms.twitch.target, null);
  assert.deepEqual(session.json.platforms.twitch.choices, [{ id: 'cccc3333', label: '#someoneelse' }]);
  assert.equal(twitch.sent.length, 0);
});

test('reply target: choosing one is gated and validated', async t => {
  const picks = [];
  const app = await startApp({ senders: { twitch: fakeSender() }, setTarget: (p, id) => { picks.push([p, id]); return id === 'aaaa1111'; } });
  t.after(app.close);
  assert.equal((await app.post('/api/dock/target', { platform: 'twitch', source: 'aaaa1111' })).status, 200);
  assert.equal((await app.post('/api/dock/target', { platform: 'twitch', source: 'nope' })).json.code, 'bad_target');
  assert.equal((await app.post('/api/dock/target', { platform: 'discord', source: 'aaaa1111' })).json.code, 'bad_target');
  assert.equal((await app.post('/api/dock/target', { platform: 'twitch' })).json.code, 'bad_target');
  assert.deepEqual(picks, [['twitch', 'aaaa1111'], ['twitch', 'nope']]);
  assert.equal((await app.post('/api/dock/target', { platform: 'twitch', source: 'aaaa1111' }, { 'x-dock-token': 'wrong' })).json.code, 'bad_token');
  assert.equal((await app.post('/api/dock/target', { platform: 'twitch', source: 'aaaa1111' }, { origin: 'https://evil.example' })).json.code, 'bad_origin');
  assert.equal(picks.length, 2);
});

test('length: each platform\'s own limit, checked for both before anything is sent', async t => {
  const twitch = fakeSender({ maxLength: 500 });
  const youtube = fakeSender({ maxLength: 200 });
  const app = await startApp({ senders: { twitch, youtube } });
  t.after(app.close);
  const session = await request(app.port, { path: '/api/dock/session' });
  assert.equal(session.json.platforms.twitch.maxLength, 500);
  assert.equal(session.json.platforms.youtube.maxLength, 200);

  const long = 'x'.repeat(201);
  // fits Twitch, not YouTube: a "both" must not land on Twitch alone
  let r = await app.post('/api/send', { target: 'both', text: long });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: 'Too long for YouTube — 200 characters at most, this is 201. Nothing was sent.', code: 'too_long', platform: 'youtube', limit: 200, length: 201 });
  assert.equal(twitch.sent.length + youtube.sent.length, 0);
  r = await app.post('/api/send', { target: 'youtube', text: long });
  assert.equal(r.json.platform, 'youtube');
  assert.equal(youtube.sent.length, 0);
  // the same text to Twitch alone is fine, and 200 exactly fits both
  assert.equal((await app.post('/api/send', { target: 'twitch', text: long })).status, 200);
  assert.equal((await app.post('/api/send', { target: 'both', text: 'x'.repeat(200) })).status, 200);
  assert.equal(twitch.sent.length, 2);
  assert.equal(youtube.sent.length, 1);
  // counted in characters, not UTF-16 units
  assert.equal((await app.post('/api/send', { target: 'youtube', text: '😀'.repeat(200) })).status, 200);
});
