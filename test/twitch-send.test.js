'use strict';
// Twitch sending against a fake Twitch: the device code flow, refresh, the
// send call and every way it can be turned down. No real Twitch involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretStore } = require('../lib/tokens');
const { TwitchSender, INFO_SCOPE } = require('../lib/twitch-send');
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
  const state = {
    n: 0, access: null, refresh: null, pendingLeft: pendingPolls, deny: null, chat: null, users: null, streams: null, revoked: [],
    asked: 'user:write:chat',   // what the last device request asked for; the token carries exactly that
    channel: { broadcaster_id: '1001', broadcaster_login: 'example_user', broadcaster_name: 'Example_User', game_id: '100', game_name: 'Old Category', title: 'Old title', tags: ['old'] },
    patch: null, patches: [],
  };
  const issue = () => {
    state.n++;
    state.access = 'FAKE_ACCESS_' + state.n;
    state.refresh = 'FAKE_REFRESH_' + state.n;
    return [200, { access_token: state.access, refresh_token: state.refresh, expires_in: 14400, scope: state.asked.split(' '), token_type: 'bearer' }];
  };
  const authed = c => c.headers.authorization === 'Bearer ' + state.access && c.headers['client-id'] === CLIENT_ID;
  const up = await fakeUpstream({
    'GET /helix/channels': c => {
      if (!authed(c)) return [401, { status: 401, message: 'Invalid OAuth token' }];
      return [200, { data: c.query.broadcaster_id === state.channel.broadcaster_id ? [state.channel] : [] }];
    },
    'PATCH /helix/channels': c => {
      if (!authed(c)) return [401, { status: 401, message: 'Invalid OAuth token' }];
      state.patches.push(c);
      if (state.patch) return state.patch(c);
      if (!state.asked.includes('channel:manage:broadcast')) return [401, { status: 401, message: 'Missing scope: channel:manage:broadcast or user:edit:broadcast' }];
      return [204];
    },
    'GET /helix/search/categories': c => {
      if (!authed(c)) return [401, { status: 401, message: 'Invalid OAuth token' }];
      return [200, { data: [{ id: '509670', name: 'Example Category', box_art_url: 'https://static-cdn.jtvnw.net/ttv-boxart/509670-52x72.jpg' }, { name: 'no id' }], pagination: {} }];
    },
    'POST /oauth2/device': c => { state.asked = c.body.scopes; return [200, { device_code: 'FAKE_DEVICE_CODE', expires_in: 1800, interval: 5, user_code: 'ABCDEFGH', verification_uri: VERIFY }]; },
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
    'GET /helix/streams': c => {
      if (!authed(c)) return [401, { status: 401, message: 'Invalid OAuth token' }];
      if (state.streams) return state.streams(c);
      return [200, { data: [{ user_login: 'examplechannel', type: 'live', viewer_count: 42, started_at: '2026-11-20T10:00:00Z' }] }];
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

// ---------- review fixes ----------

test('a refresh in flight when I sign out does not sign me back in', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, clock, file } = makeSender(t, up);
  await signIn(sender);
  // hold Twitch's answer to the refresh until after the sign-out
  let release;
  const held = new Promise(r => { release = r; });
  const real = up.routes['POST /oauth2/token'];
  let refreshSeen;
  const seen = new Promise(r => { refreshSeen = r; });
  up.routes['POST /oauth2/token'] = c => { if (c.body.grant_type === 'refresh_token') refreshSeen(); return real(c); };
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const r = await realFetch(url, opts);
    if (String(url).endsWith('/oauth2/token') && String(opts.body).includes('grant_type=refresh_token')) await held;
    return r;
  };
  t.after(() => { global.fetch = realFetch; });

  clock.t += (14400 - 60) * 1000;                    // close to expiry: the next send refreshes first
  const sending = sender.send('x', TARGET);
  await seen;                                        // the refresh is on the wire
  await sender.setup({ action: 'signout', body: {} });
  release();
  assert.equal((await sending).code, 'not_signed_in');
  assert.equal(sender.status().signedIn, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).twitch, undefined);   // the late answer was dropped
  assert.equal(up.count('POST /helix/chat/messages'), 0);
  assert.ok(state.access);
});

test('a refresh in flight when the client ID changes does not restore the old sign-in', async t => {
  const { up } = await fakeTwitch(t);
  const { sender, clock, file, cfg } = makeSender(t, up);
  await signIn(sender);
  let release;
  const held = new Promise(r => { release = r; });
  let refreshSeen;
  const seen = new Promise(r => { refreshSeen = r; });
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const isRefresh = String(url).endsWith('/oauth2/token') && String(opts.body).includes('grant_type=refresh_token');
    if (isRefresh) refreshSeen();
    const r = await realFetch(url, opts);
    if (isRefresh) await held;
    return r;
  };
  t.after(() => { global.fetch = realFetch; });
  clock.t += (14400 - 60) * 1000;
  const sending = sender.send('x', TARGET);
  await seen;
  await sender.setup({ action: 'client', body: { clientId: 'anotherfakeclientid0123456789' } });
  release();
  assert.equal((await sending).ok, false);
  assert.equal(cfg.clientId, 'anotherfakeclientid0123456789');
  assert.equal(sender.status().signedIn, false);
  assert.ok(!fs.existsSync(file) || JSON.parse(fs.readFileSync(file, 'utf8')).twitch === undefined);
});

test('two copies on one folder: the second uses the rotated refresh token instead of signing everyone out', async t => {
  const { up, state } = await fakeTwitch(t);
  const a = makeSender(t, up);
  await signIn(a.sender);
  // a second process: its own store object, same file
  const b = new TwitchSender({
    store: new SecretStore(a.file), getClientId: () => CLIENT_ID, setClientId: () => {},
    endpoints: { id: up.base, api: up.base }, now: () => a.clock.t,
  });
  assert.equal(b.status().signedIn, true);
  a.clock.t += (14400 - 60) * 1000;
  assert.equal((await a.sender.send('from a', TARGET)).ok, true);     // a refreshes: the old refresh token is spent
  const rotated = state.refresh;
  assert.equal((await b.send('from b', TARGET)).ok, true);            // b reads the file, sees the new tokens
  assert.equal(up.calls.filter(c => c.body && c.body.grant_type === 'refresh_token').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(a.file, 'utf8')).twitch.refreshToken, rotated);

  // the worst case: both start a refresh with the same token; the loser gets a
  // 400, finds the winner's token on disk and carries on with it
  a.clock.t += 14400 * 1000;
  const results = await Promise.all([a.sender.send('race a', TARGET), b.send('race b', TARGET)]);
  assert.deepEqual(results.map(r => r.ok), [true, true], JSON.stringify(results));
  assert.equal(a.sender.status().signedIn, true);
  assert.equal(b.status().signedIn, true);
  assert.equal(JSON.parse(fs.readFileSync(a.file, 'utf8')).twitch.refreshToken, state.refresh);
});

test('device flow keeps polling through network errors until the code expires', async t => {
  const { up, state } = await fakeTwitch(t, { pendingPolls: 1 });
  const { sender, clock } = makeSender(t, up);
  const realFetch = global.fetch;
  let failing = 3;
  let attempts = 0;
  global.fetch = async (url, opts) => {
    if (String(url).endsWith('/oauth2/token')) {
      attempts++;
      if (failing-- > 0) throw new TypeError('fetch failed');     // what a dropped connection looks like
    }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; });
  await sender.setup({ action: 'signin', body: {} });
  await waitFor(() => sender.status().signedIn);
  assert.ok(attempts >= 5, String(attempts));          // 3 failures, 1 pending, 1 success
  assert.equal(sender.setupState().pendingError, '');

  // and it does stop: errors all the way to expiry end the flow with the expiry message
  await sender.setup({ action: 'signout', body: {} });
  failing = Infinity;
  state.pendingLeft = 0;
  await sender.setup({ action: 'signin', body: {} });
  await new Promise(r => setTimeout(r, 40));
  assert.ok(sender.setupState().pending, 'still pending after repeated errors');
  clock.t += 1801 * 1000;
  await waitFor(() => sender.setupState().pendingError);
  assert.match(sender.setupState().pendingError, /expired/);
});

test('a second copy of the server does not send, and says why', async t => {
  const { up } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  await signIn(sender);
  const why = 'Sending is off in this copy: another copy of the server (process 1001) is already running from this folder and owns sending.';
  const app = await startApp({ senders: { twitch: sender }, disabled: () => why, notices: () => ['secrets.json couldn\'t be parsed, so it was moved to secrets.json.broken-20261120T101500Z and sign-ins start fresh.'] });
  t.after(app.close);
  const calls = up.calls.length;
  const session = await app.get('/api/dock/session');
  assert.equal(session.json.platforms.twitch.available, false);
  assert.equal(session.json.platforms.twitch.signedIn, false);
  assert.equal(session.json.platforms.twitch.detail, why);
  const sent = await app.post('/api/send', { target: 'twitch', text: 'x' });
  assert.deepEqual(sent.json.results.twitch, { ok: false, code: 'sending_disabled', reason: why });
  const signin = await app.post('/api/setup/twitch/signin', {});
  assert.equal(signin.status, 409);
  assert.equal(signin.json.code, 'sending_disabled');
  const st = await app.get('/api/setup/state');
  assert.equal(st.json.notices.length, 2);
  assert.equal(st.json.notices[0], why);
  assert.match(st.json.notices[1], /moved to secrets\.json\.broken-/);
  assert.equal(st.json.platforms.twitch.clientId, undefined);
  assert.equal(up.calls.length, calls);            // nothing reached Twitch
});

// ---------- viewer counts ----------

test('viewers: Get Streams with the dock\'s sign-in; offline channels are simply absent', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  assert.deepEqual(await sender.viewers(['examplechannel']), { state: 'signed_out', note: 'Sign in to Twitch on /setup to show viewers.' });
  assert.equal(up.calls.length, 0);                    // not signed in: nothing is asked
  await signIn(sender);
  assert.deepEqual(await sender.viewers(['examplechannel', 'second']), { state: 'ok', live: { examplechannel: 42 } });
  const call = up.calls.at(-1);
  assert.equal(call.key, 'GET /helix/streams');
  assert.equal(call.headers.authorization, 'Bearer ' + state.access);
  assert.equal(call.headers['client-id'], CLIENT_ID);
  state.streams = () => [200, { data: [] }];
  assert.deepEqual(await sender.viewers(['examplechannel']), { state: 'ok', live: {} });
  state.streams = () => [200, { data: [{ user_login: 'ExampleChannel', type: 'live', viewer_count: 7 }, { user_login: 'rerun', type: '', viewer_count: 3 }] }];
  assert.deepEqual((await sender.viewers(['examplechannel'])).live, { examplechannel: 7 });
});

test('viewers: rate limit holds off, a dead token says signed out, errors are errors', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, clock } = makeSender(t, up);
  await signIn(sender);
  state.streams = () => [429, { status: 429, message: 'Too Many Requests' }, { 'Ratelimit-Reset': String(Math.floor(clock.t / 1000) + 20) }];
  assert.equal((await sender.viewers(['examplechannel'])).state, 'error');
  const n = up.count('GET /helix/streams');
  assert.equal((await sender.viewers(['examplechannel'])).state, 'error');
  assert.equal(up.count('GET /helix/streams'), n);     // held locally
  clock.t += 21000;
  state.streams = () => [503, undefined];
  assert.deepEqual(await sender.viewers(['examplechannel']), { state: 'error', note: 'Twitch answered HTTP 503.' });
  state.streams = null;
  state.refresh = 'FAKE_REFRESH_GONE';
  clock.t += 14400 * 1000;
  assert.equal((await sender.viewers(['examplechannel'])).state, 'signed_out');
});

test('auth change is announced: sign-in landing, sign-out, client ID change — and a listener that throws breaks nothing', async t => {
  const { up } = await fakeTwitch(t, { pendingPolls: 2 });
  let n = 0;
  const { sender } = makeSender(t, up, { onAuthChange: () => { n++; throw new Error('listener bug'); } });
  await sender.setup({ action: 'signin', body: {} });
  assert.equal(n, 0);                                  // a code on screen isn't a sign-in
  await waitFor(() => sender.status().signedIn);
  assert.equal(n, 1);
  assert.equal(sender.status().as, 'Example_User');    // the throwing listener didn't undo it
  assert.equal((await sender.setup({ action: 'signout', body: {} })).status, 200);
  assert.equal(n, 2);
  assert.equal(sender.status().signedIn, false);
  await sender.setup({ action: 'client', body: { clientId: CLIENT_ID } });
  assert.equal(n, 2);                                  // same client: nothing changed
  await sender.setup({ action: 'client', body: { clientId: 'otherfakeclientid0123456789abcd' } });
  assert.equal(n, 3);
});

// ---------- stream info ----------
const BOTH_SCOPES = 'user:write:chat ' + INFO_SCOPE;

async function signInForInfo(sender) {
  const r = await sender.setup({ action: 'signin', body: { info: true } });
  assert.equal(r.status, 200);
  await waitFor(() => sender._hasInfoScope());
}

test('stream info: an ordinary sign-in asks for chat only, and a save is refused before Twitch hears of it', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, file } = makeSender(t, up);
  await signIn(sender);
  assert.equal(up.calls.find(c => c.key === 'POST /oauth2/device').body.scopes, 'user:write:chat');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).twitch.scopes, ['user:write:chat']);
  const st = sender.infoStatus();
  assert.deepEqual([st.signedIn, st.needsPermission, st.ready], [true, true, false]);
  assert.equal(sender.setupState().hasInfoScope, false);
  const r = await sender.setInfo({ title: 'New title', tags: [] });
  assert.equal(r.code, 'needs_permission');
  assert.equal(state.patches.length, 0);
  // reading what's there needs no extra scope
  const got = await sender.getInfo();
  assert.deepEqual(got.info, { title: 'Old title', category: { id: '100', name: 'Old Category' }, tags: ['old'], where: '#example_user' });
});

test('stream info: a sign-in from before scopes were recorded counts as chat only', async t => {
  const { up } = await fakeTwitch(t);
  const { sender, file } = makeSender(t, up);
  await signIn(sender);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.twitch.scopes;
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(sender.infoStatus().needsPermission, true);
  assert.equal((await sender.setInfo({ title: 'x', tags: [] })).code, 'needs_permission');
});

test('stream info: the panel\'s sign-in asks for both scopes, and later sign-ins keep asking for both', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, file } = makeSender(t, up);
  await signIn(sender);
  await signInForInfo(sender);
  const device = up.calls.filter(c => c.key === 'POST /oauth2/device');
  assert.equal(device[1].body.scopes, BOTH_SCOPES);
  // the poll carries the same list it asked for
  const polls = up.calls.filter(c => c.key === 'POST /oauth2/token' && c.body.device_code);
  assert.equal(polls[polls.length - 1].body.scopes, BOTH_SCOPES);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).twitch.scopes, BOTH_SCOPES.split(' '));
  const st = sender.infoStatus();
  assert.deepEqual([st.needsPermission, st.ready, st.limits.title, st.limits.tags, st.limits.tagLength], [false, true, 140, 10, 25]);

  // a refresh doesn't lose them
  await sender.session.tokens(true);
  assert.equal(sender._hasInfoScope(), true);
  // signing in again from /setup — no info flag — must not drop the permission
  state.pendingLeft = 0;
  await sender.setup({ action: 'signin', body: {} });
  assert.equal(up.calls.filter(c => c.key === 'POST /oauth2/device')[2].body.scopes, BOTH_SCOPES);
  // after a deliberate sign-out it's back to asking for chat only
  sender.setup({ action: 'cancel' });
  await sender.setup({ action: 'signout', body: {} });
  await signIn(sender);
  assert.equal(up.calls.filter(c => c.key === 'POST /oauth2/device')[3].body.scopes, 'user:write:chat');
});

test('stream info: save patches my own channel with exactly what the form held', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  await signInForInfo(sender);
  assert.deepEqual(await sender.setInfo({ title: 'Fixing an example board', categoryId: '509670', tags: ['repair', 'soldering'] }), { ok: true });
  const c = state.patches[0];
  assert.equal(c.query.broadcaster_id, '1001');
  assert.deepEqual(c.body, { title: 'Fixing an example board', tags: ['repair', 'soldering'], game_id: '509670' });
  // category left alone: no game_id at all. Cleared: an empty one.
  await sender.setInfo({ title: 'x', tags: [] });
  assert.deepEqual(state.patches[1].body, { title: 'x', tags: [] });
  await sender.setInfo({ title: 'x', categoryId: '', tags: [] });
  assert.equal(state.patches[2].body.game_id, '');
});

test('stream info: Twitch\'s refusals come back in its words; a missing scope is not a dead sign-in', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender, clock } = makeSender(t, up);
  await signInForInfo(sender);
  const form = { title: 'x', tags: ['a'] };

  state.patch = () => [400, { status: 400, message: 'One or more tags were not applied because they failed AutoMod review.' }];
  let r = await sender.setInfo(form);
  assert.deepEqual([r.ok, r.code], [false, 'rejected']);
  assert.match(r.reason, /AutoMod/);

  // Twitch says the token lacks the scope although we thought it had it
  state.patch = () => [401, { status: 401, message: 'Missing scope: channel:manage:broadcast or user:edit:broadcast' }];
  r = await sender.setInfo(form);
  assert.equal(r.code, 'needs_permission');
  assert.equal(sender.status().signedIn, true);

  state.patch = () => [429, { status: 429, message: 'Too Many Requests' }, { 'ratelimit-reset': String(Math.ceil(clock.t / 1000) + 30) }];
  r = await sender.setInfo(form);
  assert.equal(r.code, 'rate_limited');
  assert.ok(r.retryAfter > 0 && r.retryAfter <= 31);
  const before = state.patches.length;
  assert.equal((await sender.setInfo(form)).code, 'rate_limited');      // held off: nothing sent
  assert.equal((await sender.getInfo()).code, 'rate_limited');
  assert.equal(state.patches.length, before);
  clock.t += 31000;

  state.patch = () => [401, { status: 401, message: 'Invalid OAuth token' }];
  r = await sender.setInfo(form);
  assert.equal(r.code, 'not_signed_in');
  assert.equal(sender.status().signedIn, false);
  assert.equal((await sender.getInfo()).code, 'not_signed_in');
  assert.equal((await sender.searchCategories('x')).code, 'not_signed_in');
});

test('stream info: category search, and the rules checked before Twitch is asked', async t => {
  const { up } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  await signIn(sender);                       // searching needs no extra scope
  const r = await sender.searchCategories('exam ple&x');
  assert.deepEqual(r, { ok: true, categories: [{ id: '509670', name: 'Example Category' }] });
  const call = up.calls.find(c => c.key === 'GET /helix/search/categories');
  assert.deepEqual(call.query, { first: '10', query: 'exam ple&x' });

  const ok = { title: 'x'.repeat(140), tags: Array.from({ length: 10 }, (_, i) => 'tag' + i) };
  assert.equal(sender.checkInfo(ok), '');
  assert.match(sender.checkInfo({ ...ok, title: '' }), /needs a title/);
  assert.match(sender.checkInfo({ ...ok, title: 'x'.repeat(141) }), /140/);
  assert.match(sender.checkInfo({ ...ok, tags: [...ok.tags, 'eleven'] }), /10 tags/);
  assert.match(sender.checkInfo({ ...ok, tags: ['two words'] }), /spaces/);
  assert.match(sender.checkInfo({ ...ok, tags: ['x'.repeat(26)] }), /25/);
  assert.equal(sender.checkInfo({ ...ok, tags: ['x'.repeat(25)] }), '');
});

test('stream info over HTTP: grant from the panel, read, save — no token in any response', async t => {
  const { up, state } = await fakeTwitch(t);
  const { sender } = makeSender(t, up);
  const app = await startApp({ senders: { twitch: sender } });
  t.after(app.close);
  await signIn(sender);
  const seen = [];
  const get = async p => { const r = await app.get(p); seen.push(r.text); return r; };
  const post = async (p, b) => { const r = await app.post(p, b); seen.push(r.text); return r; };

  assert.equal((await get('/api/info/state')).json.platforms.twitch.needsPermission, true);
  assert.equal((await post('/api/info/save', { platforms: ['twitch'], title: 'New title', tags: [] })).json.results.twitch.code, 'needs_permission');
  const grant = await post('/api/setup/twitch/signin', { info: true });
  assert.equal(grant.json.userCode, 'ABCDEFGH');
  await waitFor(() => sender._hasInfoScope());
  assert.equal((await get('/api/setup/state')).json.platforms.twitch.hasInfoScope, true);
  assert.equal((await get('/api/info/state')).json.platforms.twitch.ready, true);
  assert.equal((await get('/api/info/current?platform=twitch')).json.info.title, 'Old title');
  assert.equal((await get('/api/info/categories?platform=twitch&q=exam')).json.categories[0].id, '509670');

  const r = await post('/api/info/save', { platforms: ['twitch'], title: 'New title', tags: ['repair'], category: { twitch: { id: '509670', name: 'Example Category' } } });
  assert.deepEqual(r.json.results, { twitch: { ok: true } });
  assert.deepEqual(state.patches[0].body, { title: 'New title', tags: ['repair'], game_id: '509670' });
  // too long for Twitch: refused here, Twitch never asked
  const long = await post('/api/info/save', { platforms: ['twitch'], title: 'x'.repeat(141), tags: [] });
  assert.equal(long.status, 400);
  assert.equal(state.patches.length, 1);
  for (const text of seen) assert.doesNotMatch(text, /FAKE_ACCESS|FAKE_REFRESH|FAKE_DEVICE/);
});
