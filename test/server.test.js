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
