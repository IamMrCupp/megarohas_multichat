'use strict';
// Twitch sending against a fake Twitch: the device code flow, refresh, the
// send call and every way it can be turned down. No real Twitch involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretStore } = require('../lib/tokens');
const { TwitchSender } = require('../lib/twitch-send');
const { fakeUpstream, startApp } = require('./helpers');

const CLIENT_ID = 'fakeclientid0123456789abcdefgh';
const VERIFY = 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH';

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('timed out waiting');
}

// A fake Twitch with real token bookkeeping: single-use refresh tokens, access
// tokens that must match, and a chat endpoint the test can script.
async function fakeTwitch(t, { pendingPolls = 1 } = {}) {
  const state = { n: 0, access: null, refresh: null, pendingLeft: pendingPolls, deny: null, chat: null, users: null, revoked: [] };
  const issue = () => {
    state.n++;
    state.access = 'FAKE_ACCESS_' + state.n;
    state.refresh = 'FAKE_REFRESH_' + state.n;
    return [200, { access_token: state.access, refresh_token: state.refresh, expires_in: 14400, scope: ['user:write:chat'], token_type: 'bearer' }];
  };
  const authed = c => c.headers.authorization === 'Bearer ' + state.access && c.headers['client-id'] === CLIENT_ID;
  const up = await fakeUpstream({
    'POST /oauth2/device': () => [200, { device_code: 'FAKE_DEVICE_CODE', expires_in: 1800, interval: 5, user_code: 'ABCDEFGH', verification_uri: VERIFY }],
    'POST /oauth2/token': c => {
      if (c.body.grant_type === 'refresh_token') {
        if (c.body.refresh_token !== state.refresh) return [400, { status: 400, message: 'Invalid refresh token' }];
        return issue();
      }
      if (state.deny) return [400, { status: 400, message: state.deny }];
      if (state.pendingLeft-- > 0) return [400, { status: 400, message: 'authorization_pending' }];
      return issue();
    },
    'POST /oauth2/revoke': c => { state.revoked.push(c.body.token); return [200]; },
    'GET /helix/users': c => {
      if (!authed(c)) return [401, { status: 401, message: 'Invalid OAuth token' }];
      if (state.users) return state.users(c);
      if (c.query.login) return [200, { data: [{ id: '9001', login: c.query.login, display_name: c.query.login }] }];
      return [200, { data: [{ id: '1001', login: 'example_user', display_name: 'Example_User' }] }];
    },
    'POST /helix/chat/messages': c => {
      if (!authed(c)) return [401, { status: 401, message: 'Invalid OAuth token' }];
      if (state.chat) return state.chat(c);
      return [200, { data: [{ message_id: 'fake-msg-1', is_sent: true, drop_reason: null }] }];
    },
  });
  t.after(up.close);
  return { up, state };
}

function makeSender(t, up, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multichat-twitch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'secrets.json');
  const cfg = { clientId: CLIENT_ID };
  const clock = { t: Date.now() };
  const sender = new TwitchSender({
    store: new SecretStore(file),
    getClientId: () => cfg.clientId,
    setClientId: id => { cfg.clientId = id; },
    endpoints: { id: up.base, api: up.base },
    now: () => clock.t,
    pollIntervalMs: 5,
    ...extra,
  });
  return { sender, file, cfg, clock };
}

async function signIn(sender) {
  const r = await sender.setup({ action: 'signin', body: {} });
  assert.equal(r.status, 200);
  await waitFor(() => sender.status().signedIn);
  return r;
}

const TARGET = { channel: 'examplechannel' };

test('device code flow: code shown, polled, signed in, stored owner-only', async t => {
  const { up, state } = await fakeTwitch(t, { pendingPolls: 2 });
  const { sender, file } = makeSender(t, up);
  assert.deepEqual(sender.status(), { configured: true, signedIn: false, as: null, detail: '' });

  const r = await sender.setup({ action: 'signin', body: {} });
  assert.deepEqual(Object.keys(r.body).sort(), ['expiresAt', 'userCode', 'verificationUri']);
  assert.equal(r.body.userCode, 'ABCDEFGH');
  assert.equal(r.body.verificationUri, VERIFY);
  assert.equal(sender.setupState().pending.userCode, 'ABCDEFGH');

  await waitFor(() => sender.status().signedIn);
  assert.equal(sender.status().as, 'Example_User');
  assert.equal(sender.setupState().pending, null);
  assert.equal(up.count('POST /oauth2/token'), 3);

  // exactly the documented request: public client, one scope, no secret
  const device = up.calls.find(c => c.key === 'POST /oauth2/device');
  assert.deepEqual(device.body, { client_id: CLIENT_ID, scopes: 'user:write:chat' });
  const poll = up.calls.find(c => c.key === 'POST /oauth2/token');
  assert.deepEqual(poll.body, { client_id: CLIENT_ID, scopes: 'user:write:chat', device_code: 'FAKE_DEVICE_CODE', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  assert.ok(!up.calls.some(c => c.body && c.body.client_secret !== undefined));

  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).twitch;
  assert.equal(saved.accessToken, state.access);
  assert.equal(saved.refreshToken, state.refresh);
  assert.equal(saved.userId, '1001');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // nothing the pages can see carries a token or the device code
  const visible = JSON.stringify([sender.status(), sender.setupState(), r.body]);
  for (const secret of [state.access, state.refresh, 'FAKE_DEVICE_CODE']) assert.ok(!visible.includes(secret));
});

test('device flow: refused, and expired before approval', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, clock } = makeSender(t, up);
  state.deny = 'invalid device code';
  await sender.setup({ action: 'signin', body: {} });
  await waitFor(() => sender.setupState().pendingError);
  assert.match(sender.setupState().pendingError, /invalid device code/);
  assert.equal(sender.status().signedIn, false);

  state.deny = 'authorization_pending';
  await sender.setup({ action: 'signin', body: {} });
  assert.equal(sender.setupState().pendingError, '');
  clock.t += 1801 * 1000;
  await waitFor(() => sender.setupState().pendingError);
  assert.match(sender.setupState().pendingError, /expired/);
  assert.equal(sender.setupState().pending, null);
});

test('device flow: cancel stops polling; no client ID is refused before any request', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, cfg } = makeSender(t, up);
  state.deny = 'authorization_pending';
  await sender.setup({ action: 'signin', body: {} });
  await sender.setup({ action: 'cancel', body: {} });
  const polls = up.count('POST /oauth2/token');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(up.count('POST /oauth2/token'), polls);
  assert.equal(sender.setupState().pending, null);

  cfg.clientId = '';
  const before = up.calls.length;
  const r = await sender.setup({ action: 'signin', body: {} });
  assert.equal(r.body.code, 'no_client_id');
  assert.equal(up.calls.length, before);
  assert.equal(sender.status().detail, 'Needs a Twitch client ID.');
});

test('client ID: validated, and changing it signs out', async t => {
  const { up } = await fakeTwitch(t);
  const { sender, cfg } = makeSender(t, up);
  await signIn(sender);
  assert.equal((await sender.setup({ action: 'client', body: { clientId: 'has spaces!' } })).body.code, 'bad_client_id');
  assert.equal(sender.status().signedIn, true);
  assert.equal((await sender.setup({ action: 'client', body: { clientId: CLIENT_ID } })).status, 200);
  assert.equal(sender.status().signedIn, true);       // same ID: nothing changes
  await sender.setup({ action: 'client', body: { clientId: 'anotherfakeclientid0123456789' } });
  assert.equal(cfg.clientId, 'anotherfakeclientid0123456789');
  assert.equal(sender.status().signedIn, false);
});

test('send: looks the channel up once, posts as the signed-in user', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  await signIn(sender);
  assert.deepEqual(await sender.send('hello chat', TARGET), { ok: true, id: 'fake-msg-1' });
  assert.deepEqual(await sender.send('second', TARGET), { ok: true, id: 'fake-msg-1' });
  assert.equal(up.calls.filter(c => c.key === 'GET /helix/users' && c.query.login).length, 1);
  const posts = up.calls.filter(c => c.key === 'POST /helix/chat/messages');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, { broadcaster_id: '9001', sender_id: '1001', message: 'hello chat' });
  assert.equal(posts[0].headers.authorization, 'Bearer ' + state.access);
  assert.equal(posts[0].headers['client-id'], CLIENT_ID);
});

test('send: Twitch\'s own reason comes back', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  await signIn(sender);
  const dropped = (code, message) => () => [200, { data: [{ message_id: '', is_sent: false, drop_reason: { code, message } }] }];

  state.chat = dropped('user_banned', 'You are permanently banned from talking in examplechannel.');
  assert.deepEqual(await sender.send('x', TARGET), { ok: false, code: 'user_banned', reason: 'You are permanently banned from talking in examplechannel.' });
  state.chat = dropped('slow_mode', 'This room is in slow mode and you are sending messages too quickly.');
  assert.equal((await sender.send('x', TARGET)).code, 'slow_mode');
  state.chat = dropped('followers_only', 'This room is in followers-only mode.');
  assert.equal((await sender.send('x', TARGET)).reason, 'This room is in followers-only mode.');

  state.chat = () => [403, { status: 403, message: 'The sender is not permitted to send chat messages to the broadcaster\'s chat room.' }];
  assert.deepEqual(await sender.send('x', TARGET), { ok: false, code: 'forbidden', reason: 'The sender is not permitted to send chat messages to the broadcaster\'s chat room.' });
  state.chat = () => [422, { status: 422, message: 'The message is too large.' }];
  assert.equal((await sender.send('x', TARGET)).code, 'too_long');
  state.chat = () => [400, { status: 400, message: 'The parameter "message" was malformed.' }];
  assert.equal((await sender.send('x', TARGET)).reason, 'The parameter "message" was malformed.');
  state.chat = () => [503, undefined];
  assert.equal((await sender.send('x', TARGET)).reason, 'Twitch answered HTTP 503.');

  // too long never leaves the machine
  const before = up.calls.length;
  assert.equal((await sender.send('x'.repeat(501), TARGET)).code, 'too_long');
  assert.equal(up.calls.length, before);

  state.users = c => (c.query.login ? [200, { data: [] }] : [200, { data: [{ id: '1001' }] }]);
  assert.equal((await sender.send('x', { channel: 'nosuchchannel' })).code, 'no_channel');
});

test('send: rate limited — backs off until Ratelimit-Reset and does not retry blind', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, clock } = makeSender(t, up);
  await signIn(sender);
  const reset = Math.floor(clock.t / 1000) + 20;
  state.chat = () => [429, { status: 429, message: 'Too Many Requests' }, { 'Ratelimit-Reset': String(reset) }];
  const first = await sender.send('x', TARGET);
  assert.equal(first.code, 'rate_limited');
  assert.ok(first.retryAfter >= 19 && first.retryAfter <= 20, String(first.retryAfter));
  assert.equal(up.count('POST /helix/chat/messages'), 1);     // one attempt, no retry

  state.chat = null;
  clock.t += 5000;
  const held = await sender.send('x', TARGET);
  assert.equal(held.code, 'rate_limited');
  assert.ok(held.retryAfter >= 14 && held.retryAfter <= 15);
  assert.equal(up.count('POST /helix/chat/messages'), 1);     // held locally, nothing sent

  clock.t += 16000;
  assert.equal((await sender.send('x', TARGET)).ok, true);
  assert.equal(up.count('POST /helix/chat/messages'), 2);
});

test('send: rate limited with no reset header waits a minute', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  await signIn(sender);
  state.chat = () => [429, { status: 429, message: 'Too Many Requests' }];
  assert.equal((await sender.send('x', TARGET)).retryAfter, 60);
});

test('refresh: before expiry, once for concurrent sends, new refresh token persisted', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, clock, file } = makeSender(t, up);
  await signIn(sender);
  const oldRefresh = state.refresh;
  clock.t += (14400 - 120) * 1000;              // two minutes of life left
  const results = await Promise.all([sender.send('a', TARGET), sender.send('b', TARGET), sender.send('c', TARGET)]);
  assert.ok(results.every(r => r.ok));
  const refreshes = up.calls.filter(c => c.key === 'POST /oauth2/token' && c.body.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.deepEqual(refreshes[0].body, { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: oldRefresh });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).twitch;
  assert.equal(saved.refreshToken, state.refresh);
  assert.notEqual(saved.refreshToken, oldRefresh);
  assert.equal(saved.userId, '1001');
  // a healthy token is not refreshed again
  await sender.send('d', TARGET);
  assert.equal(up.calls.filter(c => c.body && c.body.grant_type === 'refresh_token').length, 1);
});

test('a 401 gets one refresh and one retry', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  await signIn(sender);
  await sender.send('warm the channel cache', TARGET);
  state.access = 'FAKE_ACCESS_REVOKED_SERVER_SIDE';     // our stored access token is now dead
  assert.equal((await sender.send('x', TARGET)).ok, true);
  assert.equal(up.calls.filter(c => c.body && c.body.grant_type === 'refresh_token').length, 1);
  assert.equal(up.count('POST /helix/chat/messages'), 3);   // ok, 401, ok
});

test('a dead refresh token signs out and says so', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, clock, file } = makeSender(t, up);
  await signIn(sender);
  state.refresh = 'FAKE_REFRESH_ROTATED_ELSEWHERE';
  clock.t += 14400 * 1000;
  const r = await sender.send('x', TARGET);
  assert.deepEqual(r, { ok: false, code: 'not_signed_in', reason: 'Twitch sign-in expired — sign in again.' });
  assert.deepEqual(sender.status(), { configured: true, signedIn: false, as: null, detail: 'Twitch sign-in expired — sign in again.' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).twitch, undefined);
  assert.equal(up.count('POST /helix/chat/messages'), 0);
});

test('sign out revokes the token and forgets it', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, file } = makeSender(t, up);
  await signIn(sender);
  const access = state.access;
  assert.equal((await sender.setup({ action: 'signout', body: {} })).status, 200);
  assert.deepEqual(state.revoked, [access]);
  assert.equal(sender.status().signedIn, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).twitch, undefined);
  assert.equal((await sender.send('x', TARGET)).code, 'not_signed_in');
});

test('Twitch unreachable: a plain failure, tokens kept', async t => {
  const { up } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  await signIn(sender);
  await up.close();
  assert.deepEqual(await sender.send('x', TARGET), { ok: false, code: 'unreachable', reason: 'Couldn\'t reach Twitch.' });
  assert.equal(sender.status().signedIn, true);
});

test('over HTTP: sign in from the setup page, send from the dock, no token in any response', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  const app = await startApp({ senders: { twitch: sender } });
  t.after(app.close);
  const seen = [];
  const keep = r => { seen.push(r.text); return r; };

  // gated like sending
  assert.equal((await app.post('/api/setup/twitch/signin', {}, { 'x-dock-token': 'wrong' })).json.code, 'bad_token');
  assert.equal((await app.post('/api/setup/twitch/signin', {}, { origin: 'https://evil.example' })).json.code, 'bad_origin');
  assert.equal((await app.post('/api/setup/twitch/signin', {}, { host: 'evil.example:' + app.port })).json.code, 'bad_host');
  assert.equal(up.calls.length, 0);

  const start = keep(await app.post('/api/setup/twitch/signin', {}));
  assert.equal(start.json.userCode, 'ABCDEFGH');
  let st = keep(await app.get('/api/setup/state'));
  assert.equal(st.json.platforms.twitch.clientId, CLIENT_ID);
  await waitFor(() => sender.status().signedIn);
  st = keep(await app.get('/api/setup/state'));
  assert.equal(st.json.platforms.twitch.signedIn, true);
  assert.equal(st.json.platforms.twitch.as, 'Example_User');
  keep(await app.get('/api/dock/session'));

  const sent = keep(await app.post('/api/send', { target: 'twitch', text: 'hello from the dock' }));
  assert.deepEqual(sent.json, { results: { twitch: { ok: true, id: 'fake-msg-1' } } });
  assert.equal(up.calls.at(-1).body.message, 'hello from the dock');

  keep(await app.post('/api/setup/twitch/signout', {}));
  assert.equal((await app.post('/api/send', { target: 'twitch', text: 'x' })).json.results.twitch.code, 'not_signed_in');
  assert.equal((await app.post('/api/setup/twitch/nonsense', {})).status, 404);

  const all = seen.join('\n');
  for (const secret of ['FAKE_ACCESS_', 'FAKE_REFRESH_', 'FAKE_DEVICE_CODE']) assert.ok(!all.includes(secret), secret);
  assert.ok(state.revoked.length === 1);
});
