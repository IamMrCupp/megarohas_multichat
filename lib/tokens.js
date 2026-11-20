'use strict';
// Where sign-in tokens and client secrets live: one JSON file beside
// config.json, readable by the owner only (mode 0600). Nothing in here is
// ever logged or sent to a page — callers hand out names and booleans, not
// values. On Windows the mode bits don't apply; the file inherits the
// folder's ACL.
//
// Nothing is cached. Every read goes to the file and every write is
// read-merge-write of one section, so two processes pointed at the same
// folder see each other's changes instead of overwriting them from a stale
// copy — which matters most for Twitch, whose refresh tokens are single-use.
const fs = require('fs');
const path = require('path');

const POSIX = process.platform !== 'win32';

class SecretStore {
  // log(kind, message) is only ever given fixed text and an error code —
  // never file contents, and never a JSON parse message (Node quotes the
  // offending text in those).
  constructor(file, { log = () => {}, now = Date.now } = {}) {
    this.file = file;
    this.log = log;
    this.now = now;
    this.readError = '';   // the file is there and can't be read
    this.brokenNote = '';  // the file was unparseable and has been set aside
  }

  // For /setup: what the owner should know about the file, or ''.
  get problem() { return [this.readError, this.brokenNote].filter(Boolean).join(' '); }

  _setAside() {
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const aside = `${this.file}.broken-${stamp}`;
    try {
      fs.renameSync(this.file, aside);
      if (POSIX) fs.chmodSync(aside, 0o600);
      this.brokenNote = `${path.basename(this.file)} couldn't be parsed, so it was moved to ${path.basename(aside)} and sign-ins start fresh.`;
    } catch (e) {
      this.brokenNote = `${path.basename(this.file)} couldn't be parsed and couldn't be moved aside (${e.code || 'error'}).`;
    }
    this.log('secrets', this.brokenNote);
  }

  _read() {
    let raw;
    try {
      const st = fs.statSync(this.file);
      // Someone (an editor, a restore from backup) loosened it: tighten before use.
      if (POSIX && (st.mode & 0o077)) fs.chmodSync(this.file, 0o600);
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') { this.readError = ''; return {}; }
      const msg = `${path.basename(this.file)} can't be read (${e.code || 'error'}). Sending is off until that's fixed.`;
      if (msg !== this.readError) this.log('secrets', msg);
      this.readError = msg;
      return {};
    }
    this.readError = '';
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { /* handled below, message deliberately unused */ }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { this._setAside(); return {}; }
    return parsed;
  }

  get(section) {
    const v = this._read()[section];
    return v && typeof v === 'object' ? { ...v } : null;
  }

  // value null removes the section. Read-merge-write: only this section
  // changes. Written to a temp file created 0600 and renamed over the real
  // one, so the secrets never sit in a wider-mode file and a crash mid-write
  // can't leave half a token behind.
  set(section, value) {
    const data = this._read();
    // An unreadable file may be full of good tokens: never write over it.
    if (this.readError) throw new Error('secrets file is unreadable');
    const remove = value === null || value === undefined;
    if (remove && !(section in data)) return;   // nothing to forget: don't create the file
    if (remove) delete data[section];
    else data[section] = { ...value };
    const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${process.pid}.tmp`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (POSIX) fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}

// One process per folder may send. The server falls back to the next free
// port when its own is taken, so a second copy started by accident would
// otherwise share secrets.json with the first and race it for single-use
// refresh tokens. The second copy still reads chat; it just won't send.
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function acquireSendLock(dir, { pid = process.pid, isAlive = alive } = {}) {
  const file = path.join(dir, 'sending.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      return { held: true, file, release() { try { if (fs.readFileSync(file, 'utf8') === String(pid)) fs.unlinkSync(file); } catch (e) {} } };
    } catch (e) {
      if (e.code !== 'EEXIST') return { held: false, file, owner: null, reason: `Sending is off: couldn't create ${path.basename(file)} (${e.code || 'error'}).`, release() {} };
      let owner = NaN;
      try { owner = Number(fs.readFileSync(file, 'utf8').trim()); } catch (e2) {}
      if (owner === pid) return { held: true, file, release() { try { fs.unlinkSync(file); } catch (e3) {} } };
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
        return {
          held: false, file, owner,
          reason: `Sending is off in this copy: another copy of the server (process ${owner}) is already running from this folder and owns sending. Use that one's dock, or stop it.`,
          release() {},
        };
      }
      try { fs.unlinkSync(file); } catch (e2) {}   // left behind by a copy that's gone
    }
  }
  return { held: false, file, owner: null, reason: 'Sending is off: the sending lock is contested.', release() {} };
}

module.exports = { SecretStore, acquireSendLock };
