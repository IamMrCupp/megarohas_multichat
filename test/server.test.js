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
