'use strict';
// YouTube sending against a fake Google: the OAuth redirect flow, refresh,
// the chat ID lookup, the insert and every refusal. No real Google involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretStore } = require('../lib/tokens');
const { YouTubeSender, msUntilPacificMidnight, tagsLength } = require('../lib/youtube-send');
const { fakeUpstream, startApp, request, fakeSender } = require('./helpers');

const CLIENT_ID = '000000000000-fakefakefakefake.apps.googleusercontent.com';
const CLIENT_SECRET = 'FAKE_CLIENT_SECRET_do_not_use';
const VIDEO = 'FAKEvideo01';
const TARGET = { videoId: VIDEO, channel: 'Example Channel' };
const gErr = (status, reason, message) => [status, { error: { code: status, message, errors: [{ domain: 'youtube.liveChat', reason, message }] } }];

async function fakeGoogle(t) {
  const state = { n: 0, access: null, refresh: null, code: 'FAKE_AUTH_CODE', verifierOk: null, insert: null, video: null, revoked: [], noRefresh: false, noChannel: false };
  const authed = c => c.headers.authorization === 'Bearer ' + state.access;
  const up = await fakeUpstream({
    'POST /token': c => {
      if (c.body.grant_type === 'refresh_token') {
        if (c.body.refresh_token !== state.refresh) return [400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }];
        state.access = 'FAKE_YT_ACCESS_' + (++state.n);
        return [200, { access_token: state.access, expires_in: 3599, scope: 'https://www.googleapis.com/auth/youtube.force-ssl', token_type: 'Bearer' }];
      }
      if (c.body.code !== state.code) return [400, { error: 'invalid_grant', error_description: 'Bad Request' }];
      state.verifier = c.body.code_verifier;
      state.access = 'FAKE_YT_ACCESS_' + (++state.n);
      state.refresh = 'FAKE_YT_REFRESH_' + state.n;
      return [200, { access_token: state.access, expires_in: 3599, token_type: 'Bearer', ...(state.noRefresh ? {} : { refresh_token: state.refresh }) }];
    },
    'POST /revoke': c => { state.revoked.push(c.body.token); return [200, {}]; },
    'GET /youtube/v3/channels': c => {
      if (!authed(c)) return gErr(401, 'authError', 'Invalid Credentials');
      return [200, { items: state.noChannel ? [] : [{ id: 'UCfakefakefakefakefakefa', snippet: { title: 'Example Channel' } }] }];
    },
    'GET /youtube/v3/videos': c => {
      if (!authed(c)) return gErr(401, 'authError', 'Invalid Credentials');
      if (state.video) return state.video(c);
      return [200, { items: [{ id: c.query.id, liveStreamingDetails: { activeLiveChatId: 'FAKE_LIVE_CHAT_ID' } }] }];
    },
    'POST /youtube/v3/liveChat/messages': c => {
      if (!authed(c)) return gErr(401, 'authError', 'Invalid Credentials');
      if (state.insert) return state.insert(c);
      return [200, { kind: 'youtube#liveChatMessage', id: 'fake-yt-msg-1', snippet: c.body.snippet }];
    },
  });
  t.after(up.close);
  return { up, state };
}

async function setup(t, { signIn = true } = {}) {
  const { up, state } = await fakeGoogle(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multichat-youtube-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'secrets.json');
  const clock = { t: Date.now() };
  const sender = new YouTubeSender({
    store: new SecretStore(file),
    endpoints: { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: up.base + '/token', revoke: up.base + '/revoke', api: up.base + '/youtube/v3' },
    now: () => clock.t,
  });
  const app = await startApp({ senders: { youtube: sender } });
  t.after(app.close);
  const ctx = { up, state, sender, app, file, clock };
  ctx.saved = () => (JSON.parse(fs.readFileSync(file, 'utf8')).youtube);
  // what the browser does: POST signin, go to Google, come back to the redirect URI
  ctx.begin = async () => {
    const r = await app.post('/api/setup/youtube/signin', {});
    assert.equal(r.status, 200);
    return new URL(r.json.url);
  };
  ctx.comeBack = (params, headers = {}) => request(app.port, { path: '/?' + new URLSearchParams(params), headers });
  ctx.signIn = async () => {
    const auth = await ctx.begin();
    const r = await ctx.comeBack({ state: auth.searchParams.get('state'), code: state.code });
    assert.equal(r.status, 302, r.text);
    return auth;
  };
  assert.equal((await app.post('/api/setup/youtube/client', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })).status, 200);
  if (signIn) await ctx.signIn();
  return ctx;
}

const apiCalls = up => up.calls.filter(c => c.path.startsWith('/youtube/v3/'));

test('sign-in: authorization URL is exactly the documented installed-app request, with PKCE', async t => {
  const c = await setup(t, { signIn: false });
  assert.deepEqual(c.sender.status(), { configured: true, signedIn: false, as: null, detail: '' });
  const auth = await c.begin();
  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = Object.fromEntries(auth.searchParams);
  assert.equal(q.client_id, CLIENT_ID);
  assert.equal(q.redirect_uri, `http://127.0.0.1:${c.app.port}`);
  assert.equal(q.response_type, 'code');
  assert.equal(q.scope, 'https://www.googleapis.com/auth/youtube.force-ssl');
  assert.equal(q.code_challenge_method, 'S256');
  assert.ok(q.state.length >= 32);
  assert.ok(!auth.search.includes(CLIENT_SECRET));

  const back = await c.comeBack({ state: q.state, code: c.state.code });
  assert.equal(back.status, 302);
  assert.equal(back.headers.location, '/setup');
  // the verifier sent to the token endpoint hashes to the challenge sent to the browser
  assert.equal(crypto.createHash('sha256').update(c.state.verifier).digest('base64url'), q.code_challenge);
  const exchange = c.up.calls.find(x => x.key === 'POST /token');
  assert.deepEqual(Object.keys(exchange.body).sort(), ['client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
  assert.equal(exchange.body.grant_type, 'authorization_code');
  assert.equal(exchange.body.redirect_uri, q.redirect_uri);

  assert.deepEqual(c.sender.status(), { configured: true, signedIn: true, as: 'Example Channel', detail: '' });
  const saved = c.saved();
  assert.equal(saved.refreshToken, c.state.refresh);
  assert.equal(saved.clientSecret, CLIENT_SECRET);
  if (process.platform !== 'win32') assert.equal(fs.statSync(c.file).mode & 0o777, 0o600);
});

test('sign-in: the callback only honours a state this server issued, once', async t => {
  const c = await setup(t, { signIn: false });
  // nothing pending
  let r = await c.comeBack({ state: 'made-up', code: c.state.code });
  assert.equal(r.status, 400);
  const auth = await c.begin();
  const good = auth.searchParams.get('state');
  // wrong state while one is pending
  r = await c.comeBack({ state: good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A'), code: c.state.code });
  assert.equal(r.status, 400);
  assert.equal(c.up.count('POST /token'), 0);
  assert.equal(c.sender.status().signedIn, false);
  // right state from a foreign Host or another machine
  assert.equal((await c.comeBack({ state: good, code: c.state.code }, { host: 'evil.example:' + c.app.port })).status, 403);
  // the real one works, and can't be replayed
  assert.equal((await c.comeBack({ state: good, code: c.state.code })).status, 302);
  assert.equal((await c.comeBack({ state: good, code: c.state.code })).status, 400);
  assert.equal(c.up.count('POST /token'), 1);
  // an ordinary visit to the panel's address is not ours
  assert.equal((await request(c.app.port, { path: '/' })).status, 404);
  assert.equal((await request(c.app.port, { path: '/?code=x' })).status, 404);
});

test('sign-in: cancelled, expired, bad code, no refresh token, no channel', async t => {
  const c = await setup(t, { signIn: false });
  const tryWith = async (params, mutate) => {
    const auth = await c.begin();
    if (mutate) mutate();
    const r = await c.comeBack({ state: auth.searchParams.get('state'), ...params });
    assert.equal(r.status, 400);
    assert.equal(c.sender.status().signedIn, false);
    return c.sender.setupState({ port: c.app.port }).signinError;
  };
  assert.match(await tryWith({ error: 'access_denied' }), /cancelled/);
  const xss = await tryWith({ error: '<script>alert(1)</script>' });
  assert.ok(!xss.includes('<script>'));
  assert.match(await tryWith({ code: c.state.code }, () => { c.clock.t += 11 * 60 * 1000; }), /too long/);
  assert.match(await tryWith({ code: 'WRONG_CODE' }), /wouldn't finish/);
  c.state.noRefresh = true;
  assert.match(await tryWith({ code: c.state.code }), /refresh token/);
  c.state.noRefresh = false; c.state.noChannel = true;
  assert.match(await tryWith({ code: c.state.code }), /no YouTube channel/);
  assert.equal(c.saved().refreshToken, undefined);
});

test('send: one lookup per broadcast, then liveChatMessages.insert — and never a read', async t => {
  const c = await setup(t);
  const before = apiCalls(c.up).length;   // the channels.list from sign-in
  assert.deepEqual(await c.sender.send('hello chat', TARGET), { ok: true, id: 'fake-yt-msg-1' });
  assert.deepEqual(await c.sender.send('second', TARGET), { ok: true, id: 'fake-yt-msg-1' });
  const calls = apiCalls(c.up).slice(before);
  assert.deepEqual(calls.map(x => x.key), ['GET /youtube/v3/videos', 'POST /youtube/v3/liveChat/messages', 'POST /youtube/v3/liveChat/messages']);
  assert.deepEqual(calls[0].query, { part: 'liveStreamingDetails', id: VIDEO });
  assert.deepEqual(calls[1].query, { part: 'snippet' });
  assert.deepEqual(calls[1].body, { snippet: { liveChatId: 'FAKE_LIVE_CHAT_ID', type: 'textMessageEvent', textMessageDetails: { messageText: 'hello chat' } } });
  assert.equal(calls[1].headers.authorization, 'Bearer ' + c.state.access);
  // the whole run: no GET on liveChat/messages, i.e. no reading chat through the API
  assert.ok(!c.up.calls.some(x => x.method === 'GET' && x.path.includes('liveChat')));
  // quota bookkeeping: 1 (channels) + 1 (videos) + 20 + 20
  const q = c.sender.setupState({ port: c.app.port }).quota;
  assert.equal(q.usedTodayEstimate, 42);
  assert.deepEqual([q.perSend, q.perBroadcastLookup, q.dailyDefault], [20, 1, 10000]);
});

test('send: not live yet — no broadcast found, or no active chat on it', async t => {
  const c = await setup(t);
  const before = c.up.calls.length;
  assert.equal((await c.sender.send('x', { videoId: null, channel: 'Example Channel' })).code, 'not_live');
  assert.equal(c.up.calls.length, before);
  c.state.video = () => [200, { items: [{ id: VIDEO, liveStreamingDetails: { scheduledStartTime: '2030-01-01T00:00:00Z' } }] }];
  const r = await c.sender.send('x', TARGET);
  assert.equal(r.code, 'not_live');
  assert.match(r.reason, /isn't live yet/);
  assert.equal(c.up.count('POST /youtube/v3/liveChat/messages'), 0);
  // not cached: once it goes live the next send works
  c.state.video = null;
  assert.equal((await c.sender.send('x', TARGET)).ok, true);
});

test('send: YouTube\'s own reason comes back', async t => {
  const c = await setup(t);
  c.state.insert = () => gErr(403, 'liveChatDisabled', 'The live chat is disabled by the owner.');
  assert.deepEqual(await c.sender.send('x', TARGET), { ok: false, code: 'liveChatDisabled', reason: 'The live chat is disabled by the owner.' });
  c.state.insert = () => gErr(403, 'forbidden', 'You do not have the permissions required to create the specified live chat message.');
  assert.equal((await c.sender.send('x', TARGET)).reason, 'You do not have the permissions required to create the specified live chat message.');
  c.state.insert = () => gErr(400, 'messageTextInvalid', 'The message text is not valid.');
  assert.equal((await c.sender.send('x', TARGET)).code, 'messageTextInvalid');
  c.state.insert = () => gErr(403, 'rateLimitExceeded', 'The user has posted too many chat messages in a given timeframe.');
  assert.equal((await c.sender.send('x', TARGET)).code, 'rateLimitExceeded');
  assert.equal(c.up.count('POST /youtube/v3/liveChat/messages'), 4);   // one attempt each, no retries
  c.state.insert = () => [500, undefined];
  assert.equal((await c.sender.send('x', TARGET)).reason, 'YouTube answered HTTP 500.');
});

test('send: an ended chat is forgotten, so the next broadcast gets a fresh lookup', async t => {
  const c = await setup(t);
  await c.sender.send('x', TARGET);
  c.state.insert = () => gErr(403, 'liveChatEnded', 'The specified live chat is no longer live.');
  assert.equal((await c.sender.send('x', TARGET)).code, 'liveChatEnded');
  c.state.insert = null;
  await c.sender.send('x', TARGET);
  assert.equal(c.up.count('GET /youtube/v3/videos'), 2);
});

test('quota exhausted: says so, says when it resets, and stops calling until then', async t => {
  const c = await setup(t);
  c.state.insert = () => gErr(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.');
  const untilReset = msUntilPacificMidnight(c.clock.t);
  const r = await c.sender.send('x', TARGET);
  assert.equal(r.code, 'quota_exhausted');
  assert.match(r.reason, /resets at midnight Pacific, in about \d+(h \d+)?m/);
  assert.ok(Math.abs(r.retryAfter - untilReset / 1000) <= 1);
  assert.equal(c.sender.setupState({ port: c.app.port }).quota.exhausted, true);

  c.state.insert = null;
  const calls = c.up.calls.length;
  assert.equal((await c.sender.send('x', TARGET)).code, 'quota_exhausted');
  assert.equal(c.up.calls.length, calls);          // nothing sent while exhausted

  c.clock.t += untilReset + 1000;                  // past midnight Pacific
  assert.equal((await c.sender.send('x', TARGET)).ok, true);
  assert.equal(c.sender.setupState({ port: c.app.port }).quota.exhausted, false);
});

test('Pacific midnight arithmetic', () => {
  // 2026-01-15 07:59:30 UTC is 23:59:30 PST the day before
  assert.equal(msUntilPacificMidnight(Date.UTC(2026, 0, 15, 7, 59, 30)), 30000);
  // 2026-07-15 07:00:00 UTC is 00:00:00 PDT
  assert.equal(msUntilPacificMidnight(Date.UTC(2026, 6, 15, 7, 0, 0)), 86400000);
  assert.equal(msUntilPacificMidnight(Date.UTC(2026, 6, 15, 19, 0, 0)), 43200000);
});

test('refresh: before expiry, once for concurrent sends; a 401 gets one refresh and one retry', async t => {
  const c = await setup(t);
  const refreshes = () => c.up.calls.filter(x => x.key === 'POST /token' && x.body.grant_type === 'refresh_token');
  c.clock.t += (3599 - 120) * 1000;
  const results = await Promise.all([c.sender.send('a', TARGET), c.sender.send('b', TARGET), c.sender.send('c', TARGET)]);
  assert.ok(results.every(r => r.ok), JSON.stringify(results));
  assert.equal(refreshes().length, 1);
  assert.deepEqual(Object.keys(refreshes()[0].body).sort(), ['client_id', 'client_secret', 'grant_type', 'refresh_token']);
  assert.equal(c.saved().accessToken, c.state.access);
  assert.equal(c.saved().refreshToken, c.state.refresh);      // Google keeps the same refresh token

  c.state.access = 'FAKE_YT_ACCESS_REVOKED';
  assert.equal((await c.sender.send('d', TARGET)).ok, true);
  assert.equal(refreshes().length, 2);
});

test('a dead refresh token signs out, keeps the client, and says so', async t => {
  const c = await setup(t);
  c.state.refresh = 'FAKE_YT_REFRESH_GONE';
  c.clock.t += 3600 * 1000;
  assert.deepEqual(await c.sender.send('x', TARGET), { ok: false, code: 'not_signed_in', reason: 'Google sign-in expired — sign in again.' });
  assert.deepEqual(c.sender.status(), { configured: true, signedIn: false, as: null, detail: 'Google sign-in expired — sign in again.' });
  assert.deepEqual(c.saved(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
});

test('sign out revokes and forgets the tokens; changing the client forgets everything', async t => {
  const c = await setup(t);
  const refresh = c.state.refresh;
  assert.equal((await c.app.post('/api/setup/youtube/signout', {})).status, 200);
  assert.deepEqual(c.state.revoked, [refresh]);
  assert.deepEqual(c.saved(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal((await c.sender.send('x', TARGET)).code, 'not_signed_in');

  await c.signIn();
  // blank secret on the same client keeps it and keeps the sign-in
  await c.app.post('/api/setup/youtube/client', { clientId: CLIENT_ID, clientSecret: '' });
  assert.equal(c.sender.status().signedIn, true);
  assert.equal((await c.app.post('/api/setup/youtube/client', { clientId: 'bad id with spaces' })).json.code, 'bad_client_id');
  await c.app.post('/api/setup/youtube/client', { clientId: '111111111111-otherfakeclient.apps.googleusercontent.com', clientSecret: 'FAKE_OTHER_SECRET' });
  assert.equal(c.sender.status().signedIn, false);
  assert.deepEqual(c.saved(), { clientId: '111111111111-otherfakeclient.apps.googleusercontent.com', clientSecret: 'FAKE_OTHER_SECRET' });
  await c.app.post('/api/setup/youtube/client', { clientId: '' });
  assert.equal(c.saved(), undefined);
});

test('over HTTP: gated, and no token, secret, code or verifier in any response', async t => {
  const c = await setup(t, { signIn: false });
  const seen = [];
  const keep = r => { seen.push(r.text + JSON.stringify(r.headers)); return r; };
  assert.equal((await c.app.post('/api/setup/youtube/signin', {}, { 'x-dock-token': 'wrong' })).json.code, 'bad_token');
  assert.equal((await c.app.post('/api/setup/youtube/client', { clientId: 'x' }, { origin: 'https://evil.example' })).json.code, 'bad_origin');
  assert.equal((await c.app.post('/api/setup/youtube/signout', {}, { host: 'evil.example:' + c.app.port })).json.code, 'bad_host');

  const start = keep(await c.app.post('/api/setup/youtube/signin', {}));
  const auth = new URL(start.json.url);
  keep(await c.comeBack({ state: auth.searchParams.get('state'), code: c.state.code }));
  const st = keep(await c.app.get('/api/setup/state'));
  assert.equal(st.json.platforms.youtube.signedIn, true);
  assert.equal(st.json.platforms.youtube.as, 'Example Channel');
  assert.equal(st.json.platforms.youtube.hasSecret, true);
  assert.equal(st.json.platforms.youtube.redirectUri, `http://127.0.0.1:${c.app.port}`);
  keep(await c.app.get('/api/dock/session'));
  const sent = keep(await c.app.post('/api/send', { target: 'youtube', text: 'hello from the dock' }));
  assert.deepEqual(sent.json, { results: { youtube: { ok: true, id: 'fake-yt-msg-1' } } });
  c.state.insert = () => gErr(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.');
  const q = keep(await c.app.post('/api/send', { target: 'youtube', text: 'x' }));
  assert.equal(q.json.results.youtube.code, 'quota_exhausted');
  assert.ok(q.json.results.youtube.retryAfter > 0);
  keep(await c.app.post('/api/setup/youtube/signout', {}));

  const all = seen.join('\n');
  for (const secret of ['FAKE_YT_ACCESS_', 'FAKE_YT_REFRESH_', CLIENT_SECRET, c.state.code, c.state.verifier]) {
    assert.ok(!all.includes(secret), secret);
  }
});

// ---------- review fixes ----------

// Hold Google's answer to the next refresh until release() is called.
function holdRefresh(t) {
  let release, seenIt;
  const held = new Promise(r => { release = r; });
  const seen = new Promise(r => { seenIt = r; });
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const isRefresh = String(url).endsWith('/token') && String(opts && opts.body).includes('grant_type=refresh_token');
    if (isRefresh) seenIt();
    const r = await realFetch(url, opts);
    if (isRefresh) await held;
    return r;
  };
  t.after(() => { global.fetch = realFetch; });
  return { release, seen };
}

test('a refresh in flight when I sign out does not sign me back in', async t => {
  const c = await setup(t);
  const hold = holdRefresh(t);
  c.clock.t += (3599 - 60) * 1000;
  const sending = c.sender.send('x', TARGET);
  await hold.seen;
  await c.app.post('/api/setup/youtube/signout', {});
  hold.release();
  assert.equal((await sending).code, 'not_signed_in');
  assert.equal(c.sender.status().signedIn, false);
  assert.deepEqual(c.saved(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(c.up.count('POST /youtube/v3/liveChat/messages'), 0);
});

test('a refresh in flight when the client changes does not put the old client back', async t => {
  const c = await setup(t);
  const hold = holdRefresh(t);
  c.clock.t += (3599 - 60) * 1000;
  const sending = c.sender.send('x', TARGET);
  await hold.seen;
  const other = { clientId: '111111111111-otherfakeclient.apps.googleusercontent.com', clientSecret: 'FAKE_OTHER_SECRET' };
  await c.app.post('/api/setup/youtube/client', other);
  hold.release();
  assert.equal((await sending).ok, false);
  assert.deepEqual(c.saved(), other);              // not the old client, and no tokens
  assert.equal(c.sender.status().signedIn, false);
});

test('the client changing while the browser is at Google cancels that sign-in', async t => {
  const c = await setup(t, { signIn: false });
  const auth = await c.begin();
  // _setClient clears the pending sign-in, so the callback no longer knows the state
  await c.app.post('/api/setup/youtube/client', { clientId: '111111111111-otherfakeclient.apps.googleusercontent.com', clientSecret: 'FAKE_OTHER_SECRET' });
  const r = await c.comeBack({ state: auth.searchParams.get('state'), code: c.state.code });
  assert.equal(r.status, 400);
  assert.equal(c.up.count('POST /token'), 0);
  assert.equal(c.saved().refreshToken, undefined);
});

test('callback: a non-ASCII or wrong-length state gets the 400 page, not an exception', async t => {
  const c = await setup(t, { signIn: false });
  const auth = await c.begin();
  const good = auth.searchParams.get('state');
  // same number of characters, more bytes — the case that used to throw inside timingSafeEqual
  const sameChars = 'é'.repeat(good.length);
  assert.equal(sameChars.length, good.length);
  for (const state of [sameChars, good + 'é', '😀', 'x', good.slice(1), '']) {
    const r = await c.comeBack({ state, code: c.state.code });
    assert.equal(r.status, 400, JSON.stringify(state));
    assert.match(r.text, /a sign-in this server started/);
    assert.match(r.headers['content-type'], /text\/html/);
  }
  assert.equal(c.up.count('POST /token'), 0);
  // and the real one still works afterwards: a bad guess doesn't burn the pending sign-in
  assert.equal((await c.comeBack({ state: good, code: c.state.code })).status, 302);
});

test('length: YouTube\'s 200 characters is enforced before any quota is spent', async t => {
  const c = await setup(t);
  assert.equal(c.sender.maxLength, 200);
  const before = c.up.calls.length;
  const used = c.sender.setupState({ port: c.app.port }).quota.usedTodayEstimate;
  const r = await c.sender.send('x'.repeat(201), TARGET);
  assert.deepEqual(r, { ok: false, code: 'too_long', reason: 'YouTube live chat messages are 200 characters at most.' });
  assert.equal(c.up.calls.length, before);
  assert.equal(c.sender.setupState({ port: c.app.port }).quota.usedTodayEstimate, used);
  assert.equal((await c.sender.send('x'.repeat(200), TARGET)).ok, true);
});

test('length: a Both that fits Twitch but not YouTube sends to neither', async t => {
  const c = await setup(t);
  const twitch = fakeSender({ maxLength: 500 });
  const app = await startApp({ senders: { twitch, youtube: c.sender } });
  t.after(app.close);
  const session = await app.get('/api/dock/session');
  assert.equal(session.json.platforms.youtube.maxLength, 200);
  assert.equal(session.json.platforms.twitch.maxLength, 500);
  const calls = c.up.calls.length;
  const r = await app.post('/api/send', { target: 'both', text: 'x'.repeat(300) });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'too_long');
  assert.equal(r.json.platform, 'youtube');
  assert.equal(r.json.limit, 200);
  assert.equal(twitch.sent.length, 0);             // Twitch did not get it on its own
  assert.equal(c.up.calls.length, calls);          // and no quota was spent
  const ok = await app.post('/api/send', { target: 'both', text: 'x'.repeat(200) });
  assert.deepEqual([ok.json.results.twitch.ok, ok.json.results.youtube.ok], [true, true]);
});

// ---------- viewer count through the official API (opt-in) ----------

test('viewers via the API: one videos.list a poll, counted against the quota estimate', async t => {
  const c = await setup(t);
  const used = () => c.sender.setupState({ port: c.app.port }).quota.usedTodayEstimate;
  const before = used();
  c.state.video = () => [200, { items: [{ id: VIDEO, liveStreamingDetails: { actualStartTime: '2026-11-20T10:00:00Z', concurrentViewers: '152', activeLiveChatId: 'FAKE_LIVE_CHAT_ID' } }] }];
  assert.deepEqual(await c.sender.viewers(VIDEO), { live: true, count: 152 });
  assert.equal(used(), before + 1);
  assert.deepEqual(c.up.calls.at(-1).query, { part: 'liveStreamingDetails', id: VIDEO });
  // not started yet, and ended
  c.state.video = () => [200, { items: [{ id: VIDEO, liveStreamingDetails: { scheduledStartTime: '2030-01-01T00:00:00Z' } }] }];
  assert.deepEqual(await c.sender.viewers(VIDEO), { live: false, count: null });
  c.state.video = () => [200, { items: [{ id: VIDEO, liveStreamingDetails: { actualStartTime: '2026-11-20T10:00:00Z', actualEndTime: '2026-11-20T12:00:00Z' } }] }];
  assert.deepEqual(await c.sender.viewers(VIDEO), { live: false, count: null });
  // live but the owner hid the count: can't tell, so the caller falls back to the free path
  c.state.video = () => [200, { items: [{ id: VIDEO, liveStreamingDetails: { actualStartTime: '2026-11-20T10:00:00Z' } }] }];
  assert.equal(await c.sender.viewers(VIDEO), null);
  // still never a read of the chat
  assert.ok(!c.up.calls.some(x => x.method === 'GET' && x.path.includes('liveChat')));
});

test('viewers via the API: no answer when signed out or out of quota — and nothing is spent asking', async t => {
  const c = await setup(t, { signIn: false });
  assert.equal(await c.sender.viewers(VIDEO), null);
  assert.equal(c.up.calls.length, 0);
  await c.signIn();
  assert.equal(await c.sender.viewers(null), null);
  c.state.video = () => gErr(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.');
  assert.equal(await c.sender.viewers(VIDEO), null);
  const n = c.up.calls.length;
  assert.equal(await c.sender.viewers(VIDEO), null);
  assert.equal(c.up.calls.length, n);                // quota gone: no further calls until the reset
  assert.equal((await c.sender.send('x', TARGET)).code, 'quota_exhausted');
});

test('viewer source: free unless switched, switched through the gated setup route', async t => {
  const { up } = await fakeGoogle(t);
  const cfg = { source: 'free' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multichat-youtube-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sender = new YouTubeSender({
    store: new SecretStore(path.join(dir, 'secrets.json')),
    endpoints: { token: up.base + '/token', revoke: up.base + '/revoke', api: up.base + '/youtube/v3' },
    getViewerSource: () => cfg.source, setViewerSource: s => { cfg.source = s; },
  });
  const app = await startApp({ senders: { youtube: sender } });
  t.after(app.close);
  assert.equal(sender.setupState({ port: app.port }).viewerSource, 'free');
  assert.equal((await app.post('/api/setup/youtube/viewers', { source: 'api' }, { 'x-dock-token': 'wrong' })).status, 403);
  assert.equal((await app.post('/api/setup/youtube/viewers', { source: 'everything' })).json.code, 'bad_source');
  assert.equal(cfg.source, 'free');
  assert.equal((await app.post('/api/setup/youtube/viewers', { source: 'api' })).status, 200);
  assert.equal(cfg.source, 'api');
  const st = await app.get('/api/setup/state');
  assert.equal(st.json.platforms.youtube.viewerSource, 'api');
  assert.equal(st.json.platforms.youtube.viewerPollCost, 1);
  await app.post('/api/setup/youtube/viewers', { source: 'free' });
  assert.equal(cfg.source, 'free');
});

test('auth change is announced: sign-in landing, sign-out, client change — not a failed callback', async t => {
  const c = await setup(t, { signIn: false });
  let n = 0;
  c.sender.onAuthChange = () => { n++; throw new Error('listener bug'); };
  const auth = await c.begin();
  assert.equal((await c.comeBack({ state: auth.searchParams.get('state'), error: 'access_denied' })).status, 400);
  assert.equal(n, 0);                                  // cancelled at Google: nothing changed
  await c.signIn();
  assert.equal(n, 1);
  assert.equal(c.sender.status().signedIn, true);      // the throwing listener didn't undo it
  assert.equal((await c.app.post('/api/setup/youtube/signout', {})).status, 200);
  assert.equal(n, 2);
  await c.app.post('/api/setup/youtube/client', { clientId: CLIENT_ID, clientSecret: '' });
  assert.equal(n, 2);                                  // same client, secret kept: nothing changed
  await c.app.post('/api/setup/youtube/client', { clientId: '' });
  assert.equal(n, 3);
});

// ---------- stream info ----------
// A fake channel: broadcasts by status, the video behind each one, and a
// record of every write.
function withBroadcasts(ctx, { active = [], upcoming = [], videos } = {}) {
  const { up, state } = ctx;
  const authed = c => c.headers.authorization === 'Bearer ' + state.access;
  const world = { active, upcoming, puts: [], refuse: null };
  const bc = (id, title, extra = {}) => ({
    id, snippet: { title, description: 'Example description for ' + id, scheduledStartTime: '2026-11-23T18:00:00Z', channelId: 'UCfakefakefakefakefakefa', ...extra },
  });
  world.bc = bc;
  world.videos = videos || (id => ({ id, snippet: { title: 'video title', description: 'Example video description', categoryId: '22', tags: ['old', 'two words'], defaultLanguage: 'en', channelId: 'UCfakefakefakefakefakefa', liveBroadcastContent: 'live' } }));
  up.routes['GET /youtube/v3/liveBroadcasts'] = c => {
    if (!authed(c)) return gErr(401, 'authError', 'Invalid Credentials');
    return [200, { items: world[c.query.broadcastStatus] || [] }];
  };
  state.video = c => { const v = world.videos(c.query.id); return [200, { items: v ? [v] : [] }]; };
  for (const key of ['PUT /youtube/v3/liveBroadcasts', 'PUT /youtube/v3/videos']) {
    up.routes[key] = c => {
      if (!authed(c)) return gErr(401, 'authError', 'Invalid Credentials');
      world.puts.push(c);
      return world.refuse ? world.refuse(c) : [200, c.body];
    };
  }
  up.routes['GET /youtube/v3/videoCategories'] = c => {
    if (!authed(c)) return gErr(401, 'authError', 'Invalid Credentials');
    return [200, { items: [
      { id: '28', snippet: { title: 'Science & Technology', assignable: true } },
      { id: '20', snippet: { title: 'Gaming', assignable: true } },
      { id: '30', snippet: { title: 'Movies', assignable: false } },
    ] }];
  };
  return world;
}

test('stream info: finds the live broadcast and its tags in two calls', async t => {
  const ctx = await setup(t);
  const w = withBroadcasts(ctx);
  w.active = [w.bc('FAKElive001', 'Live title', { categoryId: '22' })];
  const before = apiCalls(ctx.up).length;
  const r = await ctx.sender.getInfo();
  assert.deepEqual(r.info, {
    title: 'Live title', category: { id: '22', name: '' }, tags: ['old', 'two words'], tagsKnown: true,
    where: 'YouTube (live)', key: 'FAKElive001', choices: [{ id: 'FAKElive001', label: 'Live title (live)' }],
  });
  const calls = apiCalls(ctx.up).slice(before);
  assert.deepEqual(calls.map(c => c.key), ['GET /youtube/v3/liveBroadcasts', 'GET /youtube/v3/videos']);
  assert.deepEqual(calls[0].query, { part: 'id,snippet', broadcastStatus: 'active', broadcastType: 'all', maxResults: '50' });
  assert.deepEqual(calls[1].query, { part: 'snippet', id: 'FAKElive001' });
  const st = ctx.sender.infoStatus();
  assert.deepEqual([st.ready, st.needsPermission, st.limits.title, st.quota.saveTitle, st.quota.saveTags], [true, false, 100, 3, 52]);
});

test('stream info: nothing live means the soonest upcoming broadcast; nothing at all says so and stops', async t => {
  const ctx = await setup(t);
  const w = withBroadcasts(ctx);
  w.upcoming = [
    w.bc('FAKElater01', 'Later', { scheduledStartTime: '2026-12-01T18:00:00Z' }),
    w.bc('FAKEsooner1', 'Sooner', { scheduledStartTime: '2026-11-24T18:00:00Z' }),
  ];
  let r = await ctx.sender.getInfo();
  assert.equal(r.info.key, 'FAKEsooner1');
  assert.equal(r.info.where, 'YouTube (upcoming)');
  assert.deepEqual(r.info.choices.map(c => c.id), ['FAKEsooner1', 'FAKElater01']);
  // the page can ask for the other one
  assert.equal((await ctx.sender.getInfo('FAKElater01')).info.key, 'FAKElater01');

  w.upcoming = [];
  const before = apiCalls(ctx.up).length;
  r = await ctx.sender.getInfo();
  assert.deepEqual([r.ok, r.code], [false, 'no_broadcast']);
  assert.match(r.reason, /No live or upcoming broadcast/);
  assert.deepEqual(apiCalls(ctx.up).slice(before).map(c => c.query.broadcastStatus), ['active', 'upcoming']);
  assert.equal((await ctx.sender.setInfo({ title: 'x', tags: [], expect: 'FAKEsooner1' })).code, 'no_broadcast');
  assert.equal(w.puts.length, 0);
});

test('stream info: title and category go through the broadcast for 1 unit, keeping what the form does not hold', async t => {
  const ctx = await setup(t);
  const w = withBroadcasts(ctx);
  w.active = [w.bc('FAKElive001', 'Live title', { scheduledEndTime: '2026-11-23T22:00:00Z', categoryId: '22' })];
  const r = await ctx.sender.setInfo({ title: 'Fixing an example board', categoryId: '28', tags: ['old', 'two words'], expect: 'FAKElive001' });
  assert.deepEqual(r, { ok: true, cost: 1 });
  assert.equal(w.puts.length, 1);
  assert.equal(w.puts[0].key, 'PUT /youtube/v3/liveBroadcasts');
  assert.deepEqual(w.puts[0].query, { part: 'snippet' });
  assert.deepEqual(w.puts[0].body, {
    id: 'FAKElive001',
    snippet: {
      title: 'Fixing an example board', description: 'Example description for FAKElive001',
      scheduledStartTime: '2026-11-23T18:00:00Z', scheduledEndTime: '2026-11-23T22:00:00Z', categoryId: '28',
    },
  });
  // no category picked: the one it has is sent back, not dropped
  await ctx.sender.setInfo({ title: 'Again', tags: ['old', 'two words'], expect: 'FAKElive001' });
  assert.equal(w.puts[1].body.snippet.categoryId, '22');
});

test('stream info: changed tags go through the video for 50 units, in one call, keeping its description', async t => {
  const ctx = await setup(t);
  const w = withBroadcasts(ctx);
  w.active = [w.bc('FAKElive001', 'Live title')];
  const r = await ctx.sender.setInfo({ title: 'Fixing an example board', tags: ['repair', 'soldering'], expect: 'FAKElive001' });
  assert.deepEqual(r, { ok: true, cost: 50 });
  assert.equal(w.puts.length, 1);
  assert.equal(w.puts[0].key, 'PUT /youtube/v3/videos');
  assert.deepEqual(w.puts[0].query, { part: 'snippet' });
  assert.deepEqual(w.puts[0].body, {
    id: 'FAKElive001',
    snippet: { title: 'Fixing an example board', categoryId: '22', tags: ['repair', 'soldering'], description: 'Example video description', defaultLanguage: 'en' },
  });
  // a video with no category yet, and none picked: refused before the 50 units
  w.videos = id => ({ id, snippet: { title: 't', tags: [] } });
  const none = await ctx.sender.setInfo({ title: 'x', tags: ['new'], expect: 'FAKElive001' });
  assert.equal(none.code, 'no_category');
  assert.equal(w.puts.length, 1);
});

test('stream info: a save only lands on the broadcast the page was showing', async t => {
  const ctx = await setup(t);
  const w = withBroadcasts(ctx);
  w.active = [w.bc('FAKEnewlive', 'A different stream')];
  for (const expect of ['FAKEoldlive', undefined, '']) {
    const r = await ctx.sender.setInfo({ title: 'x', tags: [], expect });
    assert.equal(r.code, 'target_changed');
    assert.match(r.reason, /A different stream/);
  }
  assert.equal(w.puts.length, 0);
});

test('stream info: no video under the broadcast\'s ID — title is saved, tags are left alone and it says so', async t => {
  const ctx = await setup(t);
  const w = withBroadcasts(ctx, { videos: () => null });
  w.active = [w.bc('FAKElive001', 'Live title')];
  const got = await ctx.sender.getInfo();
  assert.deepEqual([got.info.tags, got.info.tagsKnown], [[], false]);
  const r = await ctx.sender.setInfo({ title: 'New title', tags: ['repair'], expect: 'FAKElive001' });
  assert.equal(r.ok, true);
  assert.match(r.note, /Tags were not/);
  assert.deepEqual(w.puts.map(c => c.key), ['PUT /youtube/v3/liveBroadcasts']);
  // a video that answers under some other ID is not this broadcast's
  w.videos = () => ({ id: 'FAKEother01', snippet: { tags: ['x'] } });
  assert.equal((await ctx.sender.getInfo()).info.tagsKnown, false);
});

test('stream info: Google\'s refusals in its words; quota gone stops everything until midnight Pacific', async t => {
  const ctx = await setup(t);
  const w = withBroadcasts(ctx);
  w.active = [w.bc('FAKElive001', 'Live title')];
  const form = { title: 'x', tags: ['old', 'two words'], expect: 'FAKElive001' };
  w.refuse = () => gErr(400, 'invalidScheduledStartTime', 'The scheduled start time is invalid.');
  let r = await ctx.sender.setInfo(form);
  assert.deepEqual([r.code, r.reason], ['invalidScheduledStartTime', 'The scheduled start time is invalid.']);

  w.refuse = () => gErr(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.');
  r = await ctx.sender.setInfo(form);
  assert.equal(r.code, 'quota_exhausted');
  assert.ok(r.retryAfter > 0);
  const before = apiCalls(ctx.up).length;
  assert.equal((await ctx.sender.getInfo()).code, 'quota_exhausted');
  assert.equal((await ctx.sender.setInfo(form)).code, 'quota_exhausted');
  assert.equal((await ctx.sender.categories()).code, 'quota_exhausted');
  assert.equal(apiCalls(ctx.up).length, before);
  assert.equal(ctx.sender.infoStatus().quota.exhausted, true);
  ctx.clock.t += msUntilPacificMidnight(ctx.clock.t) + 1000;

  // a dead sign-in on the read
  ctx.state.refresh = 'ROTATED_AWAY';
  ctx.state.access = 'SOMETHING_ELSE';
  r = await ctx.sender.getInfo();
  assert.equal(r.code, 'not_signed_in');
  assert.equal(ctx.sender.status().signedIn, false);
  assert.equal((await ctx.sender.setInfo(form)).code, 'not_signed_in');
});

test('stream info: categories are asked for once, and only the assignable ones are offered', async t => {
  const ctx = await setup(t);
  withBroadcasts(ctx);
  const a = await ctx.sender.categories();
  assert.deepEqual(a.categories, [{ id: '28', name: 'Science & Technology' }, { id: '20', name: 'Gaming' }]);
  await ctx.sender.categories();
  const calls = ctx.up.calls.filter(c => c.key === 'GET /youtube/v3/videoCategories');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].query, { part: 'snippet', regionCode: 'US' });
});

test('stream info: the rules checked before any quota is spent, and the estimate counts what was spent', async t => {
  const ctx = await setup(t);
  const { sender } = ctx;
  const ok = { title: 'x'.repeat(100), tags: ['repair', 'two words'] };
  assert.equal(sender.checkInfo(ok), '');
  assert.match(sender.checkInfo({ ...ok, title: '' }), /needs a title/);
  assert.match(sender.checkInfo({ ...ok, title: 'x'.repeat(101) }), /100/);
  assert.match(sender.checkInfo({ ...ok, title: 'a <b> c' }), /< or >/);
  assert.match(sender.checkInfo({ ...ok, tags: ['a,b'] }), /comma/);
  // the reference's own example: Foo-Baz is 7, "Foo Baz" is 9 with its quotes, plus the comma between
  assert.equal(tagsLength(['Foo-Baz', 'Foo Baz']), 17);
  assert.equal(sender.checkInfo({ ...ok, tags: ['x'.repeat(500)] }), '');
  assert.match(sender.checkInfo({ ...ok, tags: ['x'.repeat(499), 'y'] }), /500/);

  const w = withBroadcasts(ctx);
  w.active = [w.bc('FAKElive001', 'Live title')];
  const used = () => sender.setupState({ port: 1 }).quota.usedTodayEstimate;
  const start = used();
  await sender.getInfo();
  assert.equal(used() - start, 2);
  await sender.setInfo({ title: 'x', tags: ['old', 'two words'], expect: 'FAKElive001' });
  assert.equal(used() - start, 2 + 3);
  await sender.setInfo({ title: 'x', tags: ['new'], expect: 'FAKElive001' });
  assert.equal(used() - start, 2 + 3 + 52);
});

test('stream info over HTTP: read, pick a category, save to the shown broadcast — no token or secret in any response', async t => {
  const ctx = await setup(t);
  const w = withBroadcasts(ctx);
  w.active = [w.bc('FAKElive001', 'Live title')];
  const seen = [];
  const get = async p => { const r = await ctx.app.get(p); seen.push(r.text); return r; };
  assert.equal((await get('/api/info/state')).json.platforms.youtube.ready, true);
  const cur = await get('/api/info/current?platform=youtube');
  assert.equal(cur.json.info.key, 'FAKElive001');
  assert.equal((await get('/api/info/categories?platform=youtube')).json.categories.length, 2);
  const r = await ctx.app.post('/api/info/save', {
    platforms: ['youtube'], title: 'Fixing an example board', tags: ['old', 'two words'],
    category: { youtube: { id: '28', name: 'Science & Technology' } }, expect: { youtube: cur.json.info.key },
  });
  seen.push(r.text);
  assert.deepEqual(r.json.results, { youtube: { ok: true, cost: 1 } });
  assert.equal(w.puts[0].body.snippet.categoryId, '28');
  // a page showing a broadcast that has since been replaced
  w.active = [w.bc('FAKEnewlive', 'A different stream')];
  const stale = await ctx.app.post('/api/info/save', { platforms: ['youtube'], title: 'x', tags: [], expect: { youtube: 'FAKElive001' } });
  assert.equal(stale.json.results.youtube.code, 'target_changed');
  assert.equal(w.puts.length, 1);
  for (const text of seen) assert.doesNotMatch(text, /FAKE_YT_ACCESS|FAKE_YT_REFRESH|FAKE_CLIENT_SECRET/);
});
