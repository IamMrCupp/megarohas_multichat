'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretStore } = require('../lib/tokens');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multichat-secrets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'secrets.json');
}
const mode = f => fs.statSync(f).mode & 0o777;
const posix = process.platform !== 'win32';

test('missing file reads as empty and is not created by reading', t => {
  const f = tmp(t);
  const s = new SecretStore(f);
  assert.equal(s.get('twitch'), null);
  assert.equal(fs.existsSync(f), false);
});

test('written owner-only, round-trips, sections are independent', { skip: !posix }, t => {
  const f = tmp(t);
  const s = new SecretStore(f);
  s.set('twitch', { accessToken: 'FAKE_ACCESS', refreshToken: 'FAKE_REFRESH' });
  s.set('youtube', { clientSecret: 'FAKE_SECRET' });
  assert.equal(mode(f), 0o600);
  const again = new SecretStore(f);
  assert.deepEqual(again.get('twitch'), { accessToken: 'FAKE_ACCESS', refreshToken: 'FAKE_REFRESH' });
  again.set('twitch', null);
  assert.equal(new SecretStore(f).get('twitch'), null);
  assert.deepEqual(new SecretStore(f).get('youtube'), { clientSecret: 'FAKE_SECRET' });
  assert.equal(mode(f), 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['secrets.json']);   // no temp file left behind
});

test('a file someone loosened is tightened before it is used', { skip: !posix }, t => {
  const f = tmp(t);
  fs.writeFileSync(f, JSON.stringify({ twitch: { refreshToken: 'FAKE_REFRESH' } }), { mode: 0o644 });
  fs.chmodSync(f, 0o644);
  const s = new SecretStore(f);
  assert.equal(s.get('twitch').refreshToken, 'FAKE_REFRESH');
  assert.equal(mode(f), 0o600);
});

test('a corrupt file reads as empty instead of throwing', t => {
  const f = tmp(t);
  fs.writeFileSync(f, '{nope');
  assert.equal(new SecretStore(f).get('twitch'), null);
});

test('get returns a copy', t => {
  const s = new SecretStore(tmp(t));
  s.set('twitch', { refreshToken: 'FAKE_REFRESH' });
  s.get('twitch').refreshToken = 'changed';
  assert.equal(s.get('twitch').refreshToken, 'FAKE_REFRESH');
});
