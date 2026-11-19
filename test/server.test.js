'use strict';
// The real server.js, started in a throwaway directory with no sources, so it
// makes no outbound connection. Proves the dock is wired in and that the
// overlay's own routes behave as they did.
const test = require('node:test');
const assert = require('node:assert/strict');
const { request, startServer } = require('./helpers');

test('server: dock and setup pages are served, overlay routes are unchanged', async t => {
  const s = await startServer(t);
  for (const [p, needle] of [['/dock', 'id="composer"'], ['/setup', 'Sending setup'], ['/overlay', 'id="chat"'], ['/', 'id="rows"']]) {
    const r = await request(s.port, { path: p });
    assert.equal(r.status, 200, p);
    assert.ok(r.text.includes(needle), p);
  }
  const state = await request(s.port, { path: '/api/state' });
  assert.equal(state.status, 200);
  assert.deepEqual(state.json.sources, []);
  // the read-only feed stays as open as it was: no token, any Host
  const open = await request(s.port, { path: '/api/state', headers: { host: 'some-lan-name:' + s.port } });
  assert.equal(open.status, 200);
});

test('server: session, then a gated send that reports honest state', async t => {
  const s = await startServer(t);
  const session = await request(s.port, { path: '/api/dock/session' });
  assert.equal(session.status, 200);
  const token = session.json.token;
  assert.ok(token && token.length >= 43);
  assert.equal(session.json.platforms.twitch.signedIn, false);
  assert.equal(session.json.platforms.youtube.signedIn, false);

  const send = (headers, body = { target: 'both', text: 'hello' }) =>
    request(s.port, { method: 'POST', path: '/api/send', body, headers });

  const ok = await send({ origin: s.origin, 'x-dock-token': token });
  assert.equal(ok.status, 200);
  for (const p of ['twitch', 'youtube']) assert.equal(ok.json.results[p].ok, false);

  assert.equal((await send({ origin: s.origin })).json.code, 'no_token');
  assert.equal((await send({ origin: s.origin, 'x-dock-token': 'wrong' })).json.code, 'bad_token');
  assert.equal((await send({ origin: 'https://evil.example', 'x-dock-token': token })).json.code, 'bad_origin');
  assert.equal((await send({ origin: s.origin, 'x-dock-token': token, host: 'evil.example:' + s.port })).json.code, 'bad_host');
  assert.equal((await request(s.port, { path: '/api/dock/session', headers: { host: 'evil.example:' + s.port } })).status, 403);
});

test('server: Twitch client ID is saved to config.json and survives; no secrets file until sign-in', async t => {
  const fs = require('fs');
  const path = require('path');
  const s = await startServer(t);
  const token = (await request(s.port, { path: '/api/dock/session' })).json.token;
  const headers = { origin: s.origin, 'x-dock-token': token };
  let st = await request(s.port, { path: '/api/setup/state', headers: { 'x-dock-token': token } });
  assert.equal(st.json.platforms.twitch.available, true);
  assert.equal(st.json.platforms.twitch.configured, false);
  assert.equal(st.json.platforms.twitch.clientId, '');

  const save = await request(s.port, { method: 'POST', path: '/api/setup/twitch/client', body: { clientId: 'fakeclientid0123456789abcdefgh' }, headers });
  assert.equal(save.status, 200);
  const cfg = () => JSON.parse(fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8'));
  assert.equal(cfg().twitchClientId, 'fakeclientid0123456789abcdefgh');
  // the panel's own save path keeps it
  await request(s.port, { method: 'POST', path: '/api/clear' });
  await request(s.port, { method: 'DELETE', path: '/api/sources/abcd1234' });
  assert.equal(cfg().twitchClientId, 'fakeclientid0123456789abcdefgh');
  assert.equal(fs.existsSync(path.join(s.dir, 'secrets.json')), false);

  assert.equal((await request(s.port, { method: 'POST', path: '/api/setup/twitch/client', body: { clientId: 'x' }, headers: { ...headers, 'x-dock-token': 'wrong' } })).status, 403);
  const send = await request(s.port, { method: 'POST', path: '/api/send', body: { target: 'twitch', text: 'hi' }, headers });
  assert.equal(send.json.results.twitch.code, 'not_signed_in');
});

test('server: YouTube client goes to secrets.json (0600), never config.json; the panel still owns /', async t => {
  const fs = require('fs');
  const path = require('path');
  const s = await startServer(t);
  const token = (await request(s.port, { path: '/api/dock/session' })).json.token;
  const headers = { origin: s.origin, 'x-dock-token': token };
  const save = await request(s.port, {
    method: 'POST', path: '/api/setup/youtube/client', headers,
    body: { clientId: '000000000000-fakefakefakefake.apps.googleusercontent.com', clientSecret: 'FAKE_CLIENT_SECRET_do_not_use' },
  });
  assert.equal(save.status, 200);
  const secretsFile = path.join(s.dir, 'secrets.json');
  assert.equal(JSON.parse(fs.readFileSync(secretsFile, 'utf8')).youtube.clientSecret, 'FAKE_CLIENT_SECRET_do_not_use');
  if (process.platform !== 'win32') assert.equal(fs.statSync(secretsFile).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8').includes('FAKE_CLIENT_SECRET'));

  const st = await request(s.port, { path: '/api/setup/state', headers: { 'x-dock-token': token } });
  assert.equal(st.json.platforms.youtube.available, true);
  assert.equal(st.json.platforms.youtube.hasSecret, true);
  assert.equal(st.json.platforms.youtube.redirectUri, s.origin);
  assert.ok(!st.text.includes('FAKE_CLIENT_SECRET'));

  // a stray OAuth-shaped visit is refused; the panel is still the panel
  assert.equal((await request(s.port, { path: '/?state=made-up&code=made-up' })).status, 400);
  const panel = await request(s.port, { path: '/' });
  assert.equal(panel.status, 200);
  assert.ok(panel.text.includes('id="rows"'));
  // nothing was written to the log about any of it
  const log = path.join(s.dir, 'error.log');
  assert.ok(!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes('FAKE_'));
  assert.ok(!s.output().includes('FAKE_'));
});
