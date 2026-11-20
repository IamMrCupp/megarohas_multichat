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

test('server: binds loopback by default', async t => {
  const s = await startServer(t, { host: undefined });
  const state = await request(s.port, { path: '/api/state' });
  assert.equal(state.json.host, '127.0.0.1');
  assert.deepEqual(state.json.lan, []);
  assert.ok(!s.output().includes('По локальной сети'));
});

test('server: the panel\'s controls are gated like sending, so nobody else can change the source list', async t => {
  const s = await startServer(t);
  const token = (await request(s.port, { path: '/api/dock/session' })).json.token;
  const good = { origin: s.origin, 'x-dock-token': token };
  const writes = [
    ['POST', '/api/sources', { url: 'https://www.twitch.tv/someoneelse' }],
    ['DELETE', '/api/sources/abcd1234'],
    ['POST', '/api/sources/abcd1234/reconnect'],
    ['POST', '/api/clear'],
    ['POST', '/api/test'],
  ];
  const refusals = [
    ['bad_origin', {}],                                                        // curl, or a LAN device with no Origin
    ['bad_origin', { origin: 'https://evil.example', 'content-type': 'text/plain' }],   // a web page's no-cors POST
    ['bad_origin', { ...good, 'sec-fetch-site': 'cross-site' }],
    ['no_token', { origin: s.origin }],
    ['bad_token', { origin: s.origin, 'x-dock-token': 'wrong' }],
    ['bad_host', { ...good, host: '192.168.1.20:' + s.port }],
    ['proxied', { ...good, 'x-forwarded-for': '192.168.1.20' }],
  ];
  for (const [method, path, body] of writes) {
    for (const [code, headers] of refusals) {
      const r = await request(s.port, { method, path, body, headers });
      assert.equal(r.status, 403, `${method} ${path} ${code}`);
      assert.equal(r.json.code, code, `${method} ${path}`);
    }
  }
  assert.deepEqual((await request(s.port, { path: '/api/state' })).json.sources, []);
  const session = (await request(s.port, { path: '/api/dock/session' })).json;
  assert.equal(session.platforms.twitch.connected, false);

  // the panel itself, on this machine, still works (a link that isn't a stream
  // is turned down by the panel's own check — so the gate let it through)
  const add = await request(s.port, { method: 'POST', path: '/api/sources', body: { url: 'https://example.com/not-a-stream' }, headers: good });
  assert.equal(add.status, 400);
  assert.ok(add.json.error && !add.json.code);
  assert.equal((await request(s.port, { method: 'POST', path: '/api/clear', headers: good })).status, 200);
  assert.equal((await request(s.port, { method: 'DELETE', path: '/api/sources/abcd1234', headers: good })).status, 404);
  // reading is as open as it was
  assert.equal((await request(s.port, { path: '/api/state', headers: { host: 'some-lan-name:' + s.port } })).status, 200);
  assert.equal((await request(s.port, { path: '/overlay', headers: { host: 'some-lan-name:' + s.port } })).status, 200);
});

test('server: dock-logic.js is served, and a null body is a 400', async t => {
  const s = await startServer(t);
  const js = await request(s.port, { path: '/dock-logic.js' });
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  assert.ok(js.text.includes('DockLogic'));
  const token = (await request(s.port, { path: '/api/dock/session' })).json.token;
  const r = await request(s.port, { method: 'POST', path: '/api/send', body: 'null', headers: { origin: s.origin, 'x-dock-token': token } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'bad_request');
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
  assert.equal((await request(s.port, { method: 'POST', path: '/api/clear', headers })).status, 200);
  assert.equal((await request(s.port, { method: 'DELETE', path: '/api/sources/abcd1234', headers })).status, 404);
  assert.equal(cfg().twitchClientId, 'fakeclientid0123456789abcdefgh');
  assert.equal(fs.existsSync(path.join(s.dir, 'secrets.json')), false);

  assert.equal((await request(s.port, { method: 'POST', path: '/api/setup/twitch/client', body: { clientId: 'x' }, headers: { ...headers, 'x-dock-token': 'wrong' } })).status, 403);
  const send = await request(s.port, { method: 'POST', path: '/api/send', body: { target: 'twitch', text: 'hi' }, headers });
  assert.equal(send.json.results.twitch.code, 'not_signed_in');
});

test('server: a second copy on the same folder reads chat but will not send; a broken secrets file is set aside and reported', async t => {
  const fs = require('fs');
  const path = require('path');
  const first = await startServer(t);
  fs.writeFileSync(path.join(first.dir, 'secrets.json'), '{"twitch": {"refreshToken": "FAKE_REFRESH_in_a_broken_file"', { mode: 0o600 });
  const tok1 = (await request(first.port, { path: '/api/dock/session' })).json.token;
  const st1 = await request(first.port, { path: '/api/setup/state', headers: { 'x-dock-token': tok1 } });
  assert.equal(st1.json.platforms.twitch.available, true);
  assert.equal(st1.json.notices.length, 1);
  assert.match(st1.json.notices[0], /couldn't be parsed, so it was moved to secrets\.json\.broken-/);
  const aside = fs.readdirSync(first.dir).filter(f => f.startsWith('secrets.json.broken-'));
  assert.equal(aside.length, 1);
  assert.ok(fs.readFileSync(path.join(first.dir, aside[0]), 'utf8').includes('FAKE_REFRESH_in_a_broken_file'));
  assert.ok(!first.output().includes('FAKE_REFRESH'));
  assert.ok(!fs.readFileSync(path.join(first.dir, 'error.log'), 'utf8').includes('FAKE_REFRESH'));

  const second = await startServer(t, {}, first.dir);
  assert.notEqual(second.port, first.port);
  for (let i = 0; i < 100 && !/Sending is off/.test(second.output()); i++) await new Promise(r => setTimeout(r, 20));   // the line after the one startServer waits for
  assert.match(second.output(), /Sending is off in this copy/);
  // the port fallback announces itself once, with the port it really got
  assert.equal(second.output().match(/Reply dock:/g).length, 1);
  assert.ok(second.output().includes(`http://127.0.0.1:${second.port}/dock`));
  assert.equal((await request(second.port, { path: '/api/state' })).json.port, second.port);
  const tok2 = (await request(second.port, { path: '/api/dock/session' })).json;
  assert.equal(tok2.platforms.twitch.available, false);
  assert.match(tok2.platforms.twitch.detail, /another copy of the server/);
  const send = await request(second.port, { method: 'POST', path: '/api/send', body: { target: 'twitch', text: 'x', expect: {} }, headers: { origin: second.origin, 'x-dock-token': tok2.token } });
  assert.equal(send.json.results.twitch.code, 'sending_disabled');
  assert.equal((await request(second.port, { path: '/overlay' })).status, 200);       // reading is unaffected
  // the first copy still owns sending
  assert.equal((await request(first.port, { path: '/api/dock/session' })).json.platforms.twitch.available, true);
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
