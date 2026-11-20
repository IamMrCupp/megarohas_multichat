'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretStore, acquireSendLock } = require('../lib/tokens');

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

test('a file that can\'t be parsed is set aside, reported, and never overwritten in place', { skip: !posix }, t => {
  const f = tmp(t);
  fs.writeFileSync(f, '{"twitch": {"refreshToken": "FAKE_REFRESH_in_a_broken_file"', { mode: 0o600 });
  const logged = [];
  const s = new SecretStore(f, { log: (kind, msg) => logged.push([kind, String(msg)]), now: () => Date.UTC(2026, 10, 20, 10, 15, 0) });
  assert.equal(s.get('twitch'), null);
  const aside = f + '.broken-20261120T101500Z';
  assert.equal(fs.readFileSync(aside, 'utf8'), '{"twitch": {"refreshToken": "FAKE_REFRESH_in_a_broken_file"');   // kept, byte for byte
  assert.equal(mode(aside), 0o600);
  assert.equal(fs.existsSync(f), false);
  assert.match(s.problem, /couldn't be parsed, so it was moved to secrets\.json\.broken-20261120T101500Z/);
  // logged once, by name — no contents, no parser message quoting them
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], 'secrets');
  assert.ok(!JSON.stringify(logged).includes('FAKE_REFRESH'));
  assert.ok(!s.problem.includes('FAKE_REFRESH'));
  // a new sign-in writes a fresh file; the broken copy is still there
  s.set('twitch', { refreshToken: 'FAKE_REFRESH_new' });
  assert.equal(new SecretStore(f).get('twitch').refreshToken, 'FAKE_REFRESH_new');
  assert.ok(fs.existsSync(aside));
  // valid JSON that isn't an object counts as broken too
  const g = tmp(t);
  fs.writeFileSync(g, '[1,2,3]');
  const s2 = new SecretStore(g, { now: () => Date.UTC(2026, 10, 20, 10, 15, 0) });
  assert.equal(s2.get('twitch'), null);
  assert.ok(fs.existsSync(g + '.broken-20261120T101500Z'));
});

test('a file that can\'t be read is reported and never written over', { skip: !posix || process.getuid() === 0 }, t => {
  const f = tmp(t);
  fs.writeFileSync(f, JSON.stringify({ twitch: { refreshToken: 'FAKE_REFRESH' } }), { mode: 0o600 });
  fs.chmodSync(path.dirname(f), 0o000);          // the folder: stat fails with EACCES
  const logged = [];
  const s = new SecretStore(f, { log: (kind, msg) => logged.push(String(msg)) });
  try {
    assert.equal(s.get('twitch'), null);
    s.get('twitch');
    assert.match(s.problem, /can't be read \(EACCES\)/);
    assert.equal(logged.length, 1);                 // not once per read
    assert.throws(() => s.set('twitch', { refreshToken: 'FAKE_REFRESH_new' }), /unreadable/);
  } finally { fs.chmodSync(path.dirname(f), 0o700); }
  assert.equal(s.get('twitch').refreshToken, 'FAKE_REFRESH');   // untouched, and the problem clears
  assert.equal(s.problem, '');
});

test('two stores on one file see each other\'s writes and merge by section', t => {
  const f = tmp(t);
  const a = new SecretStore(f);
  const b = new SecretStore(f);
  a.set('twitch', { refreshToken: 'FAKE_REFRESH_1' });
  assert.equal(b.get('twitch').refreshToken, 'FAKE_REFRESH_1');       // no stale cache
  b.set('youtube', { clientSecret: 'FAKE_SECRET' });                  // must not drop a's section
  a.set('twitch', { refreshToken: 'FAKE_REFRESH_2' });                // must not drop b's section
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { twitch: { refreshToken: 'FAKE_REFRESH_2' }, youtube: { clientSecret: 'FAKE_SECRET' } });
  b.set('youtube', null);
  assert.equal(a.get('youtube'), null);
  assert.equal(b.get('twitch').refreshToken, 'FAKE_REFRESH_2');
});

test('send lock: one process per folder; a dead owner\'s lock is taken over', t => {
  const dir = path.dirname(tmp(t));
  const first = acquireSendLock(dir, { pid: 1001, isAlive: () => true });
  assert.equal(first.held, true);
  if (posix) assert.equal(mode(first.file), 0o600);
  const second = acquireSendLock(dir, { pid: 1002, isAlive: pid => pid === 1001 });
  assert.equal(second.held, false);
  assert.equal(second.owner, 1001);
  assert.match(second.reason, /another copy of the server \(process 1001\)/);
  second.release();                                   // releasing what you don't hold does nothing
  assert.equal(fs.readFileSync(first.file, 'utf8'), '1001');
  assert.equal(acquireSendLock(dir, { pid: 1001, isAlive: () => true }).held, true);   // same process again
  // the owner died without cleaning up
  const third = acquireSendLock(dir, { pid: 1003, isAlive: () => false });
  assert.equal(third.held, true);
  assert.equal(fs.readFileSync(third.file, 'utf8'), '1003');
  third.release();
  assert.equal(fs.existsSync(third.file), false);
  // garbage in the lock file is treated as stale
  fs.writeFileSync(path.join(dir, 'sending.lock'), 'not a pid');
  assert.equal(acquireSendLock(dir, { pid: 1004, isAlive: () => true }).held, true);
});

test('get returns a copy', t => {
  const s = new SecretStore(tmp(t));
  s.set('twitch', { refreshToken: 'FAKE_REFRESH' });
  s.get('twitch').refreshToken = 'changed';
  assert.equal(s.get('twitch').refreshToken, 'FAKE_REFRESH');
});
