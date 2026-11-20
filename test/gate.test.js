'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../lib/gate');

const PORT = 3131;
const TOKEN = 'fake-token-for-tests';
function req(headers = {}, remoteAddress = '127.0.0.1') {
  return { headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'x-dock-token': TOKEN, ...headers }, socket: { remoteAddress } };
}
const opts = { port: PORT, origin: 'require', token: TOKEN };
const code = r => (r ? r.code : null);

test('loopback addresses', () => {
  for (const a of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) assert.equal(gate.isLoopbackAddress(a), true, a);
  for (const a of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', 'fe80::1', '0.0.0.0', '', undefined, '127.0.0.1.evil', '1127.0.0.1']) {
    assert.equal(gate.isLoopbackAddress(a), false, String(a));
  }
});

test('a well-formed local request passes', () => {
  assert.equal(gate.check(req(), opts), null);
  assert.equal(gate.check(req({ host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }), opts), null);
  assert.equal(gate.check(req({ host: `[::1]:${PORT}`, origin: `http://[::1]:${PORT}` }, '::1'), opts), null);
  assert.equal(gate.check(req({ 'sec-fetch-site': 'same-origin' }), opts), null);
});

test('non-loopback peer is refused, whatever else it sends', () => {
  assert.equal(code(gate.check(req({}, '192.168.1.20'), opts)), 'not_loopback');
  assert.equal(code(gate.check(req({}, '::ffff:10.0.0.5'), opts)), 'not_loopback');
  assert.equal(code(gate.check({ headers: req().headers, socket: {} }, opts)), 'not_loopback');
});

test('a request relayed by a proxy is refused', () => {
  assert.equal(code(gate.check(req({ 'x-forwarded-for': '203.0.113.9' }), opts)), 'proxied');
  assert.equal(code(gate.check(req({ forwarded: 'for=203.0.113.9' }), opts)), 'proxied');
});

test('foreign Host is refused (DNS rebinding)', () => {
  for (const host of ['evil.example:3131', 'evil.example', '127.0.0.1:9999', '127.0.0.1', '127.0.0.1:3131.evil.example', '192.168.1.20:3131']) {
    assert.equal(code(gate.check(req({ host }), opts)), 'bad_host', host);
  }
  const noHost = req(); delete noHost.headers.host;
  assert.equal(code(gate.check(noHost, opts)), 'bad_host');
});

test('cross-origin is refused', () => {
  for (const origin of ['https://evil.example', 'http://evil.example:3131', 'null', `https://127.0.0.1:${PORT}`, 'http://127.0.0.1:9999', `http://127.0.0.1:${PORT}.evil.example`]) {
    assert.equal(code(gate.check(req({ origin }), opts)), 'bad_origin', origin);
  }
  assert.equal(code(gate.check(req({ 'sec-fetch-site': 'cross-site' }), opts)), 'bad_origin');
  assert.equal(code(gate.check(req({ 'sec-fetch-site': 'same-site' }), opts)), 'bad_origin');
});

test('a write with no Origin at all is refused; a read may omit it', () => {
  const r = req(); delete r.headers.origin;
  assert.equal(code(gate.check(r, opts)), 'bad_origin');
  assert.equal(gate.check(r, { ...opts, origin: 'if-present' }), null);
  assert.equal(code(gate.check(req({ origin: 'https://evil.example' }), { ...opts, origin: 'if-present' })), 'bad_origin');
});

test('token: missing, empty and wrong are refused', () => {
  const none = req(); delete none.headers['x-dock-token'];
  assert.equal(code(gate.check(none, opts)), 'no_token');
  assert.equal(code(gate.check(req({ 'x-dock-token': '' }), opts)), 'no_token');
  assert.equal(code(gate.check(req({ 'x-dock-token': 'wrong' }), opts)), 'bad_token');
  assert.equal(code(gate.check(req({ 'x-dock-token': TOKEN + 'x' }), opts)), 'bad_token');
  assert.equal(code(gate.check(req({ 'x-dock-token': TOKEN.slice(0, -1) + 'X' }), opts)), 'bad_token');
});

test('tokens are long and never repeat', () => {
  const a = gate.newToken(), b = gate.newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 43);
});
