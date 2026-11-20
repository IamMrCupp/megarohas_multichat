'use strict';
// What the Twitch and YouTube senders share: the HTTP helpers, and the
// life of an OAuth sign-in on disk — read the tokens, refresh them once
// when they're close to expiring, retry one call after a 401, and forget
// them when the platform says they're dead.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

class SignedOut extends Error {}

function fail(code, reason, extra) { return { ok: false, code, reason, ...(extra || {}) }; }

async function fetchJson(url, opts, timeoutMs = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    let json = null;
    try { json = await r.json(); } catch (e) { /* empty or non-JSON body */ }
    return { status: r.status, json, headers: r.headers };
  } finally { clearTimeout(timer); }
}

function postForm(url, params, timeoutMs) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  }, timeoutMs);
}

class TokenSession {
  // store           SecretStore
  // section         its key in the secrets file ('twitch', 'youtube')
  // refreshRequest  tokens => { url, params } for the refresh grant
  // keep            tokens => what survives losing the sign-in (the client
  //                 credentials), or null when nothing does
  // expiredMessage  what the pages are told when the platform kills the sign-in
  constructor({ store, section, refreshRequest, keep = () => null, expiredMessage, now = Date.now, timeoutMs = 10000 }) {
    this.store = store;
    this.section = section;
    this.refreshRequest = refreshRequest;
    this.keep = keep;
    this.expiredMessage = expiredMessage;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.problem = '';        // why the last sign-in stopped working
    this.generation = 0;      // bumped by anything that ends or replaces the sign-in
    this.refreshing = null;   // single-flight refresh
  }

  read() { return this.store.get(this.section); }

  // Call before a sign-out, a client change or a fresh sign-in writes the
  // section. A refresh already on the wire belongs to the old sign-in: when
  // its answer arrives it must not be written back over what replaced it.
  invalidate() {
    this.generation++;
    this.refreshing = null;
  }

  write(value) { this.store.set(this.section, value); }

  // The platform says the sign-in is dead.
  expire() {
    const cur = this.read();
    this.write(cur ? this.keep(cur) : null);
    this.problem = this.expiredMessage;
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    const mine = (async () => {
      const t = this.read();     // from disk, not memory: another process may have rotated it
      if (!t || !t.refreshToken) throw new SignedOut();
      const { url, params } = this.refreshRequest(t);
      const r = await postForm(url, params, this.timeoutMs);
      // Signed out, or a different client pasted in, while this was in flight.
      if (generation !== this.generation) throw new SignedOut();
      const j = r.json || {};
      if (r.status === 200 && j.access_token) {
        const next = {
          ...t,
          accessToken: j.access_token,
          expiresAt: this.now() + (Number(j.expires_in) || 0) * 1000,
          // Twitch rotates the refresh token on every use; Google usually keeps it.
          ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
        };
        this.write(next);        // a single-use refresh token is spent: persist before anything else
        return next;
      }
      if (r.status === 400 || r.status === 401) {
        // Refused — but if the file now holds a different refresh token,
        // another process spent ours and saved its replacement. Use that.
        const cur = this.read();
        if (cur && cur.refreshToken && cur.refreshToken !== t.refreshToken) return cur;
        this.expire();
        throw new SignedOut();
      }
      throw new Error('refresh failed: HTTP ' + r.status);
    })();
    this.refreshing = mine;
    const done = () => { if (this.refreshing === mine) this.refreshing = null; };
    mine.then(done, done);
    return mine;
  }

  async tokens(force) {
    const t = this.read();
    if (!t || !t.refreshToken) throw new SignedOut();
    if (force || !t.accessToken || t.expiresAt - this.now() < REFRESH_MARGIN_MS) return this.refresh();
    return t;
  }

  // An authorised call: request(tokens) => fetchJson result. A 401 gets
  // exactly one refresh and one retry — the documented answer to a dead
  // access token, not a blind retry.
  async authorized(request) {
    let t = await this.tokens(false);
    for (let attempt = 0; ; attempt++) {
      const r = await request(t);
      if (r.status !== 401 || attempt > 0) return r;
      t = await this.tokens(true);
    }
  }
}

module.exports = { TokenSession, SignedOut, fail, fetchJson, postForm, REFRESH_MARGIN_MS };
