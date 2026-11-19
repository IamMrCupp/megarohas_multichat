'use strict';
// The dock's endpoints over real HTTP, with a fake sender behind them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, fakeSender, request } = require('./helpers');

test('session hands the dock its token and platform state', async t => {
  const app = await startApp({ senders: { twitch: fakeSender() } });
  t.after(app.close);
  const r = await request(app.port, { path: '/api/dock/session' });
  assert.equal(r.status, 200);
  assert.equal(r.json.token, app.token);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(r.json.platforms.twitch, { available: true, configured: true, signedIn: true, as: 'example_user', detail: '', target: 'examplechannel', connected: true });
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
  assert.deepEqual(twitch.sent, [{ text: 'hello chat', target: { channel: 'examplechannel' } }]);
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
  const app = await startApp({ senders: { twitch, youtube }, targets: { twitch: { channel: 'examplechannel' }, youtube: null } });
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
