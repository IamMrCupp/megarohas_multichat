'use strict';
// Sending to YouTube live chat. Reading stays on the chat page's own
// interface in lib/youtube.js — free, no quota — and never moves here. This
// file makes three kinds of API call and no others:
//   channels.list?mine=true   once per sign-in, to learn which channel it is
//   videos.list               once per broadcast, to turn the video the reader
//                             is already following into a live chat ID
//   liveChatMessages.insert   once per reply
// It never calls liveChatMessages.list. If the reader can't find the stream,
// the fix belongs in the reader.
//
// Sign-in is Google's installed-app flow: the user's own OAuth client, a
// loopback redirect back to this server, PKCE.
//   https://developers.google.com/youtube/v3/guides/auth/installed-apps
// The insert call accepts either the youtube or the youtube.force-ssl scope;
// Google has no chat-only scope.
//   https://developers.google.com/youtube/v3/live/docs/liveChatMessages/insert
// Quota costs and the daily reset:
//   https://developers.google.com/youtube/v3/determine_quota_cost
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
// Units, from the quota cost table linked above.
const COST = { insert: 20, videosList: 1, channelsList: 1, dailyDefault: 10000 };
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SIGNIN_WINDOW_MS = 10 * 60 * 1000;
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const DEFAULT_ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/youtube/v3',
};
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{10,200}$/;

class SignedOut extends Error {}

function fail(code, reason, extra) { return { ok: false, code, reason, ...(extra || {}) }; }
function b64url(buf) { return buf.toString('base64url'); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Google's daily quota resets at midnight Pacific. Seconds until then, read
// off the Pacific wall clock (so it's up to an hour off on the two days a year
// the clocks change).
function msUntilPacificMidnight(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(nowMs));
  const n = t => Number(parts.find(p => p.type === t).value);
  return (86400 - (n('hour') * 3600 + n('minute') * 60 + n('second'))) * 1000;
}
function pacificDay(nowMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(nowMs));
}
function inHoursMinutes(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

class YouTubeSender {
  // store: SecretStore. endpoints/now are test seams.
  constructor({ store, endpoints, now, timeoutMs = 10000 }) {
    this.store = store;
    this.ep = { ...DEFAULT_ENDPOINTS, ...(endpoints || {}) };
    this.now = now || Date.now;
    this.timeoutMs = timeoutMs;
    this.pending = null;            // sign-in in progress: { state, verifier, redirectUri, expiresAt }
    this.signinError = '';
    this.problem = '';
    this.refreshing = null;
    this.chatIds = new Map();       // videoId -> liveChatId
    this.quotaBlockedUntil = 0;
    this.used = { day: '', units: 0 };
    this.callback = {
      matches: (req, url) => req.method === 'GET' && url.pathname === '/' && url.searchParams.has('state')
        && (url.searchParams.has('code') || url.searchParams.has('error')),
      handle: (req, res, url) => this._callback(res, url),
    };
  }

  redirectUri(port) { return `http://127.0.0.1:${port}`; }

  // ---------- state the pages may see ----------
  status() {
    const y = this.store.get('youtube') || {};
    const signedIn = !!(y.clientId && y.refreshToken);
    let detail = '';
    if (!y.clientId) detail = 'Needs your own Google OAuth client.';
    else if (!signedIn && this.problem) detail = this.problem;
    return { configured: !!y.clientId, signedIn, as: signedIn ? (y.channelTitle || null) : null, detail };
  }

  _spend(units) {
    const day = pacificDay(this.now());
    if (this.used.day !== day) this.used = { day, units: 0 };
    this.used.units += units;
  }

  setupState({ port } = {}) {
    const y = this.store.get('youtube') || {};
    const now = this.now();
    if (this.used.day !== pacificDay(now)) this.used = { day: pacificDay(now), units: 0 };
    return {
      clientId: y.clientId || '',
      hasSecret: !!y.clientSecret,
      redirectUri: port ? this.redirectUri(port) : '',
      scope: SCOPE,
      signinError: this.signinError,
      quota: {
        perSend: COST.insert,
        perBroadcastLookup: COST.videosList,
        dailyDefault: COST.dailyDefault,
        usedTodayEstimate: this.used.units,
        resetsInMs: msUntilPacificMidnight(now),
        exhausted: now < this.quotaBlockedUntil,
      },
    };
  }

  // ---------- http ----------
  async _fetch(url, opts) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ac.signal });
      let json = null;
      try { json = await r.json(); } catch (e) { /* empty or non-JSON body */ }
      return { status: r.status, json };
    } finally { clearTimeout(timer); }
  }

  _form(url, params) {
    return this._fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  }

  // ---------- setup actions (POST /api/setup/youtube/<action>) ----------
  async setup({ action, body, port }) {
    if (action === 'client') return this._setClient(body || {});
    if (action === 'signin') return this._startSignin(port);
    if (action === 'signout') return this._signOut();
    return null;
  }

  _setClient(body) {
    const y = this.store.get('youtube') || {};
    const clientId = String(body.clientId || '').trim();
    const given = String(body.clientSecret || '').trim();
    if (!clientId) {
      this.pending = null; this.problem = ''; this.signinError = '';
      this.store.set('youtube', null);
      return { status: 200, body: { ok: true } };
    }
    if (!CLIENT_ID_RE.test(clientId)) {
      return { status: 400, body: { error: 'That doesn\'t look like a Google OAuth client ID.', code: 'bad_client_id' } };
    }
    if (given.length > 200) return { status: 400, body: { error: 'That client secret is too long to be real.', code: 'bad_client_secret' } };
    const same = clientId === y.clientId;
    // An empty secret field on the same client means "keep what you have".
    const clientSecret = given || (same ? (y.clientSecret || '') : '');
    if (same && clientSecret === (y.clientSecret || '')) return { status: 200, body: { ok: true } };
    this.pending = null; this.problem = ''; this.signinError = '';
    this.chatIds.clear();
    this.store.set('youtube', { clientId, ...(clientSecret ? { clientSecret } : {}) });   // tokens belong to the old client
    return { status: 200, body: { ok: true } };
  }

  _startSignin(port) {
    const y = this.store.get('youtube') || {};
    if (!y.clientId) return { status: 400, body: { error: 'Paste your Google OAuth client first.', code: 'no_client_id' } };
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const redirectUri = this.redirectUri(port);
    this.pending = { state, verifier, redirectUri, expiresAt: this.now() + SIGNIN_WINDOW_MS };
    this.signinError = '';
    const q = new URLSearchParams({
      client_id: y.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
    return { status: 200, body: { url: `${this.ep.auth}?${q}` } };
  }

  _page(res, status, title, message) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>`
      + '<body style="background:#161310;color:#f0e8da;font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px">'
      + `<h1 style="font-size:20px">${esc(title)}</h1><p>${esc(message)}</p><p><a style="color:#ffb454" href="/setup">Back to setup</a></p>`);
  }

  // The browser lands here from Google. The state value is what ties this
  // request to a sign-in this server started; it's single-use.
  async _callback(res, url) {
    const p = this.pending;
    const state = url.searchParams.get('state') || '';
    const known = p && state.length === p.state.length
      && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(p.state));
    if (!known) return this._page(res, 400, 'Not signed in', 'This isn\'t a sign-in this server started. Start again from the setup page.');
    this.pending = null;
    const bad = why => { this.signinError = why; this._page(res, 400, 'Not signed in', why); };
    if (this.now() > p.expiresAt) return bad('That sign-in took too long. Start again.');
    if (url.searchParams.has('error')) {
      const e = url.searchParams.get('error');
      return bad(e === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google refused the sign-in.');
    }
    const y = this.store.get('youtube') || {};
    const tok = await this._form(this.ep.token, {
      client_id: y.clientId,
      ...(y.clientSecret ? { client_secret: y.clientSecret } : {}),
      code: url.searchParams.get('code'),
      code_verifier: p.verifier,
      grant_type: 'authorization_code',
      redirect_uri: p.redirectUri,
    });
    const j = tok.json || {};
    if (tok.status !== 200 || !j.access_token) {
      return bad(`Google wouldn't finish the sign-in: ${j.error_description || j.error || 'HTTP ' + tok.status}`);
    }
    if (!j.refresh_token) return bad('Google didn\'t return a refresh token, so the sign-in wouldn\'t last. Start again.');
    const who = await this._fetch(`${this.ep.api}/channels?part=snippet&mine=true`, {
      headers: { authorization: 'Bearer ' + j.access_token },
    });
    this._spend(COST.channelsList);
    const ch = who.json && Array.isArray(who.json.items) && who.json.items[0];
    if (who.status !== 200 || !ch) return bad('Signed in, but that Google account has no YouTube channel to chat as.');
    this.store.set('youtube', {
      clientId: y.clientId,
      ...(y.clientSecret ? { clientSecret: y.clientSecret } : {}),
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: this.now() + (Number(j.expires_in) || 0) * 1000,
      channelId: ch.id || '',
      channelTitle: (ch.snippet && ch.snippet.title) || '',
    });
    this.problem = '';
    this.signinError = '';
    res.writeHead(302, { Location: '/setup', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  async _signOut() {
    const y = this.store.get('youtube') || {};
    this.pending = null; this.problem = ''; this.signinError = '';
    this.chatIds.clear();
    // keep the client, drop the tokens
    this.store.set('youtube', y.clientId ? { clientId: y.clientId, ...(y.clientSecret ? { clientSecret: y.clientSecret } : {}) } : null);
    if (y.refreshToken) {
      try { await this._form(this.ep.revoke, { token: y.refreshToken }); } catch (e) { /* offline is fine */ }
    }
    return { status: 200, body: { ok: true } };
  }

  // ---------- tokens ----------
  _expire(why) {
    const y = this.store.get('youtube') || {};
    this.store.set('youtube', y.clientId ? { clientId: y.clientId, ...(y.clientSecret ? { clientSecret: y.clientSecret } : {}) } : null);
    this.problem = why;
  }

  async _refresh() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const y = this.store.get('youtube');
        if (!y || !y.refreshToken) throw new SignedOut();
        const r = await this._form(this.ep.token, {
          client_id: y.clientId,
          ...(y.clientSecret ? { client_secret: y.clientSecret } : {}),
          grant_type: 'refresh_token',
          refresh_token: y.refreshToken,
        });
        const j = r.json || {};
        if (r.status === 200 && j.access_token) {
          const next = {
            ...y,
            accessToken: j.access_token,
            expiresAt: this.now() + (Number(j.expires_in) || 0) * 1000,
            ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
          };
          this.store.set('youtube', next);
          return next;
        }
        if (r.status === 400 || r.status === 401) {
          // invalid_grant: revoked, unused for six months, or a 7-day token from
          // a project still in Testing. Either way: sign in again.
          this._expire('Google sign-in expired — sign in again.');
          throw new SignedOut();
        }
        throw new Error('refresh failed: HTTP ' + r.status);
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async _tokens(force) {
    const y = this.store.get('youtube');
    if (!y || !y.refreshToken) throw new SignedOut();
    if (force || !y.accessToken || y.expiresAt - this.now() < REFRESH_MARGIN_MS) return this._refresh();
    return y;
  }

  // An authorised API call; a 401 gets one refresh and one retry.
  async _api(method, pathAndQuery, body, cost) {
    let y = await this._tokens(false);
    for (let attempt = 0; ; attempt++) {
      const r = await this._fetch(this.ep.api + pathAndQuery, {
        method,
        headers: { authorization: 'Bearer ' + y.accessToken, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      this._spend(cost);
      if (r.status !== 401 || attempt > 0) return r;
      y = await this._tokens(true);
    }
  }

  _quotaBlocked() {
    const ms = Math.max(0, this.quotaBlockedUntil - this.now());
    return fail('quota_exhausted',
      `YouTube API quota is used up for today — it resets at midnight Pacific, in about ${inHoursMinutes(ms)}.`,
      { retryAfter: Math.ceil(ms / 1000) });
  }

  // Google's error envelope -> a failure in Google's words.
  _refusal(r, videoId) {
    const err = (r.json && r.json.error) || {};
    const first = (Array.isArray(err.errors) && err.errors[0]) || {};
    const reason = first.reason || '';
    const message = first.message || err.message || `YouTube answered HTTP ${r.status}.`;
    if (QUOTA_REASONS.has(reason)) {
      this.quotaBlockedUntil = this.now() + msUntilPacificMidnight(this.now());
      return this._quotaBlocked();
    }
    if (r.status === 401) {
      this._expire('Google sign-in expired — sign in again.');
      return fail('not_signed_in', 'Google sign-in expired — sign in again.');
    }
    // the chat we cached is gone: look it up fresh next time
    if (reason === 'liveChatEnded' || reason === 'liveChatNotFound') this.chatIds.delete(videoId);
    return fail(reason || 'rejected', message);
  }

  // ---------- send ----------
  async send(text, target) {
    if (this.now() < this.quotaBlockedUntil) return this._quotaBlocked();
    const videoId = target && target.videoId;
    if (!videoId) return fail('not_live', 'The reader hasn\'t found a live broadcast yet, so there\'s no chat to reply in.');
    try {
      let chatId = this.chatIds.get(videoId);
      if (!chatId) {
        const r = await this._api('GET', `/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}`, null, COST.videosList);
        if (r.status !== 200) return this._refusal(r, videoId);
        const v = r.json && Array.isArray(r.json.items) && r.json.items[0];
        chatId = v && v.liveStreamingDetails && v.liveStreamingDetails.activeLiveChatId;
        if (!chatId) return fail('not_live', 'That broadcast has no active live chat — it isn\'t live yet, or it has ended.');
        this.chatIds.set(videoId, chatId);
      }
      const r = await this._api('POST', '/liveChat/messages?part=snippet', {
        snippet: { liveChatId: chatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } },
      }, COST.insert);
      if (r.status === 200) return { ok: true, id: (r.json && r.json.id) || '' };
      return this._refusal(r, videoId);
    } catch (e) {
      if (e instanceof SignedOut) return fail('not_signed_in', this.problem || 'Not signed in to YouTube.');
      return fail('unreachable', 'Couldn\'t reach YouTube.');
    }
  }
}

module.exports = { YouTubeSender, SCOPE, COST, msUntilPacificMidnight };
