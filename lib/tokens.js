'use strict';
// Where sign-in tokens and client secrets live: one JSON file beside
// config.json, readable by the owner only (mode 0600). Nothing in here is
// ever logged or sent to a page — callers hand out names and booleans, not
// values. On Windows the mode bits don't apply; the file inherits the
// folder's ACL.
const fs = require('fs');
const path = require('path');

class SecretStore {
  constructor(file) {
    this.file = file;
    this.cache = null;
  }

  _load() {
    if (this.cache) return this.cache;
    let data = {};
    try {
      const st = fs.statSync(this.file);
      // Someone (an editor, a restore from backup) loosened it: tighten before use.
      if (process.platform !== 'win32' && (st.mode & 0o077)) fs.chmodSync(this.file, 0o600);
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch (e) { /* missing or unreadable: start empty */ }
    this.cache = data;
    return data;
  }

  get(section) {
    const v = this._load()[section];
    return v && typeof v === 'object' ? { ...v } : null;
  }

  // value null removes the section. Written to a temp file created 0600 and
  // renamed over the real one, so the secrets never sit in a wider-mode file
  // and a crash mid-write can't leave half a token behind.
  set(section, value) {
    const data = { ...this._load() };
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
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    this.cache = data;
  }
}

module.exports = { SecretStore };
