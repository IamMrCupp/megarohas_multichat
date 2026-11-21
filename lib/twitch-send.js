'use strict';
// Sending to Twitch chat. Reading stays on the anonymous IRC connection in
// lib/twitch.js and doesn't depend on any of this — if the token dies, the
// reader keeps reading.
//
// Sign-in is the device code grant flow with a public client: no redirect
// server, no client secret.
//   https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow
// Sending is the Send Chat Message endpoint with a user access token, which
// needs exactly one scope: user:write:chat.
//   https://dev.twitch.tv/docs/api/reference/#send-chat-message
// Refresh: a public client's refresh token is single-use, so the new one is
// written to disk before anything else happens.
//   https://dev.twitch.tv/docs/authentication/refresh-tokens/
// Rate limits: on HTTP 429 the Ratelimit-Reset header says when the bucket
// refills; nothing is sent again before then.
//   https://dev.twitch.tv/docs/api/guide/#twitch-rate-limits

const { TokenSession, SignedOut, fail, fetchJson, postForm } = require('./oauth-session');

const SCOPES = 'user:write:chat';
const MAX_MESSAGE = 500;            // "limited to a maximum of 500 characters" — Send Chat Message reference
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_ENDPOINTS = { id: 'https://id.twitch.tv', api: 'https://api.twitch.tv' };
const CLIENT_ID_RE = /^[a-z0-9]{10,64}$/i;
const EXPIRED = 'Twitch sign-in expired — sign in again.';

class TwitchSender {
  // store: SecretStore. getClientId/setClientId: the client ID lives in
  // config.json (it's public). endpoints/now/pollIntervalMs are test seams.
  // onAuthChange: called after a sign-in lands or a sign-in ends, so whoever
  // shows something that depends on it (the viewer count) can ask again now.
  constructor({ store, getClientId, setClientId, endpoints, now, pollIntervalMs = 0, timeoutMs = 10000, onAuthChange = () => {} }) {
    this.store = store;
    this.onAuthChange = onAuthChange;
    this.getClientId = getClientId;
    this.setClientId = setClientId;
    this.ep = { ...DEFAULT_ENDPOINTS, ...(endpoints || {}) };
    this.now = now || Date.now;
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
    this.pending = null;        // device flow in progress
    this.pendingError = '';
    this.blockedUntil = 0;      // rate limit: no sends before this time
    this.broadcasterIds = new Map();
    this.maxLength = MAX_MESSAGE;
    // tokens on disk, refresh, the 401 retry: shared with the YouTube sender
    this.session = new TokenSession({
      store, section: 'twitch', now: this.now, timeoutMs,
      expiredMessage: EXPIRED,
      refreshRequest: t => ({
        url: this.ep.id + '/oauth2/token',
        params: { client_id: this.getClientId(), grant_type: 'refresh_token', refresh_token: t.refreshToken },
      }),
    });
  }

  // ---------- state the pages may see ----------
  status() {
    const t = this.store.get('twitch');
    const clientId = this.getClientId();
    const signedIn = !!(clientId && t && t.refreshToken);
    let detail = '';
    if (!clientId) detail = 'Needs a Twitch client ID.';
    else if (!signedIn && this.session.problem) detail = this.session.problem;
    return { configured: !!clientId, signedIn, as: signedIn ? (t.displayName || t.login || null) : null, detail };
  }

  setupState() {
    return {
      clientId: this.getClientId() || '',
      scopes: SCOPES,
      pending: this.pending
        ? { userCode: this.pending.userCode, verificationUri: this.pending.verificationUri, expiresAt: this.pending.expiresAt }
        : null,
      pendingError: this.pendingError,
    };
  }

  // ---------- http ----------
  _fetch(url, opts) { return fetchJson(url, opts, this.timeoutMs); }
  _form(pathname, params) { return postForm(this.ep.id + pathname, params, this.timeoutMs); }

  // ---------- setup actions (POST /api/setup/twitch/<action>) ----------
  async setup({ action, body }) {
    if (action === 'client') return this._setClient(body);
    if (action === 'signin') return this._startDeviceFlow();
    if (action === 'cancel') { this._stopPending(); this.pendingError = ''; return { status: 200, body: { ok: true } }; }
    if (action === 'signout') return this._signOut();
    return null;
  }

  async _setClient(body) {
    const id = String((body && body.clientId) || '').trim();
    if (id && !CLIENT_ID_RE.test(id)) {
      return { status: 400, body: { error: 'That doesn\'t look like a Twitch client ID.', code: 'bad_client_id' } };
    }
    if (id !== this.getClientId()) {
      // tokens belong to the client that got them
      this._stopPending();
      this.session.invalidate();
      this.store.set('twitch', null);
      this.session.problem = '';
      this.pendingError = '';
      this.setClientId(id);
      this._authChanged();
    }
    return { status: 200, body: { ok: true } };
  }

  async _startDeviceFlow() {
    const clientId = this.getClientId();
    if (!clientId) return { status: 400, body: { error: 'Paste a Twitch client ID first.', code: 'no_client_id' } };
    this._stopPending();
    this.pendingError = '';
    const r = await this._form('/oauth2/device', { client_id: clientId, scopes: SCOPES });
    const j = r.json || {};
    if (r.status !== 200 || !j.device_code || !j.user_code) {
      const why = j.message || `HTTP ${r.status}`;
      return { status: 502, body: { error: `Twitch wouldn't start sign-in: ${why}`, code: 'device_flow_failed' } };
    }
    this.pending = {
      deviceCode: j.device_code,
      userCode: String(j.user_code),
      verificationUri: String(j.verification_uri || ''),
      intervalMs: this.pollIntervalMs || Math.max(1000, (Number(j.interval) || 5) * 1000),
      expiresAt: this.now() + (Number(j.expires_in) || 1800) * 1000,
      timer: null,
    };
    this._schedulePoll(this.pending);
    return { status: 200, body: { userCode: this.pending.userCode, verificationUri: this.pending.verificationUri, expiresAt: this.pending.expiresAt } };
  }

  _schedulePoll(p) {
    // One poll failing — Wi-Fi blip, DNS, a timeout — isn't the flow failing.
    // Keep asking until the device code itself runs out; _poll checks that first.
    p.timer = setTimeout(() => {
      this._poll(p).catch(() => { if (this.pending === p) this._schedulePoll(p); });
    }, p.intervalMs);
    if (p.timer.unref) p.timer.unref();
  }

  _stopPending() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  _pendingFailed(p, why) {
    if (this.pending !== p) return;
    this._stopPending();
    this.pendingError = why;
  }

  async _poll(p) {
    if (this.pending !== p) return;
    if (this.now() >= p.expiresAt) return this._pendingFailed(p, 'The code expired before it was approved. Start again.');
    const clientId = this.getClientId();
    const r = await this._form('/oauth2/token', {
      client_id: clientId, scopes: SCOPES, device_code: p.deviceCode, grant_type: DEVICE_GRANT,
    });
    if (this.pending !== p) return;
    const j = r.json || {};
    if (r.status === 200 && j.access_token && j.refresh_token) {
      const tokens = this._tokensFrom(j);
      const who = await this._fetch(this.ep.api + '/helix/users', {
        headers: { authorization: 'Bearer ' + tokens.accessToken, 'client-id': clientId },
      });
      const u = who.json && Array.isArray(who.json.data) && who.json.data[0];
      if (this.pending !== p) return;
      if (who.status !== 200 || !u || !u.id) return this._pendingFailed(p, 'Signed in, but Twitch wouldn\'t say as whom. Start again.');
      this.session.invalidate();
      this.store.set('twitch', { ...tokens, userId: String(u.id), login: u.login || '', displayName: u.display_name || u.login || '' });
      this._stopPending();
      this.session.problem = '';
      this.pendingError = '';
      this._authChanged();
      return;
    }
    const msg = String(j.message || '');
    if (r.status === 400 && msg === 'authorization_pending') return this._schedulePoll(p);
    if (r.status === 400 && msg === 'slow_down') { p.intervalMs += 5000; return this._schedulePoll(p); }
    this._pendingFailed(p, `Twitch refused the sign-in: ${msg || 'HTTP ' + r.status}. Start again.`);
  }

  // A listener that throws must not undo a sign-in or a sign-out.
  _authChanged() { try { this.onAuthChange(); } catch (e) { /* theirs to fix */ } }

  _tokensFrom(j) {
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: this.now() + (Number(j.expires_in) || 0) * 1000,
    };
  }

  async _signOut() {
    this._stopPending();
    const t = this.store.get('twitch');
    const clientId = this.getClientId();
    this.session.invalidate();      // a refresh in flight must not write the tokens back
    this.store.set('twitch', null);
    this.session.problem = '';
    this.pendingError = '';
    this.broadcasterIds.clear();
    this._authChanged();
    // Best effort: the local copy is gone either way.
    //   https://dev.twitch.tv/docs/authentication/revoke-tokens/
    if (t && t.accessToken && clientId) {
      try { await this._form('/oauth2/revoke', { client_id: clientId, token: t.accessToken }); } catch (e) { /* offline is fine */ }
    }
    return { status: 200, body: { ok: true } };
  }

  // An authorised Helix call (one refresh and one retry on a 401).
  _helix(method, pathAndQuery, body) {
    return this.session.authorized(t => this._fetch(this.ep.api + pathAndQuery, {
      method,
      headers: {
        authorization: 'Bearer ' + t.accessToken,
        'client-id': this.getClientId(),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }));
  }

  _rateLimited(r) {
    const reset = Number(r.headers.get('ratelimit-reset')) * 1000;
    // No header: the Helix bucket is counted per minute, so wait one out.
    this.blockedUntil = reset > this.now() ? reset : this.now() + 60000;
    return this._blocked();
  }

  _blocked() {
    const retryAfter = Math.max(1, Math.ceil((this.blockedUntil - this.now()) / 1000));
    return fail('rate_limited', 'Twitch rate limit hit — holding off.', { retryAfter });
  }

  // ---------- viewer counts (for the overlay bar) ----------
  // Get Streams: any user token, no scope beyond what sending already has.
  // Offline channels are simply absent from the answer.
  //   https://dev.twitch.tv/docs/api/reference/#get-streams
  // -> { state: 'ok', live: { login: viewer_count } } | { state: 'signed_out' | 'error', note }
  async viewers(logins) {
    if (!this.status().signedIn) return { state: 'signed_out', note: 'Sign in to Twitch on /setup to show viewers.' };
    if (this.now() < this.blockedUntil) return { state: 'error', note: 'Twitch rate limit hit — holding off.' };
    try {
      const qs = logins.slice(0, 100).map(l => 'user_login=' + encodeURIComponent(l)).join('&');
      const r = await this._helix('GET', '/helix/streams?' + qs);
      if (r.status === 429) { this._rateLimited(r); return { state: 'error', note: 'Twitch rate limit hit — holding off.' }; }
      if (r.status === 401) { this.session.expire(); return { state: 'signed_out', note: EXPIRED }; }
      if (r.status !== 200 || !r.json || !Array.isArray(r.json.data)) return { state: 'error', note: `Twitch answered HTTP ${r.status}.` };
      const live = {};
      for (const d of r.json.data) {
        if (d && d.type === 'live' && d.user_login && Number.isFinite(Number(d.viewer_count))) live[String(d.user_login).toLowerCase()] = Number(d.viewer_count);
      }
      return { state: 'ok', live };
    } catch (e) {
      if (e instanceof SignedOut) return { state: 'signed_out', note: this.session.problem || 'Sign in to Twitch on /setup to show viewers.' };
      return { state: 'error', note: 'Couldn\'t reach Twitch.' };
    }
  }

  // ---------- send ----------
  async send(text, target) {
    if (this.now() < this.blockedUntil) return this._blocked();
    if (Array.from(text).length > MAX_MESSAGE) return fail('too_long', `Twitch messages are ${MAX_MESSAGE} characters at most.`);
    const channel = target && target.channel;
    if (!channel) return fail('no_target', 'No Twitch chat is connected in the panel.');
    try {
      let broadcasterId = this.broadcasterIds.get(channel);
      if (!broadcasterId) {
        const r = await this._helix('GET', '/helix/users?login=' + encodeURIComponent(channel));
        if (r.status === 429) return this._rateLimited(r);
        if (r.status === 401) { this.session.expire(); return fail('not_signed_in', EXPIRED); }
        const u = r.json && Array.isArray(r.json.data) && r.json.data[0];
        if (r.status !== 200) return fail('lookup_failed', `Twitch couldn't look up ${channel}: ${(r.json && r.json.message) || 'HTTP ' + r.status}`);
        if (!u || !u.id) return fail('no_channel', `Twitch has no channel called ${channel}.`);
        broadcasterId = String(u.id);
        this.broadcasterIds.set(channel, broadcasterId);
      }
      const me = this.store.get('twitch') || {};
      const r = await this._helix('POST', '/helix/chat/messages', {
        broadcaster_id: broadcasterId, sender_id: me.userId, message: text,
      });
      const j = r.json || {};
      if (r.status === 200) {
        const d = Array.isArray(j.data) && j.data[0];
        if (d && d.is_sent) return { ok: true, id: d.message_id || '' };
        const dr = (d && d.drop_reason) || {};
        return fail(dr.code || 'dropped', dr.message || 'Twitch dropped the message.');
      }
      if (r.status === 429) return this._rateLimited(r);
      if (r.status === 401) { this.session.expire(); return fail('not_signed_in', EXPIRED); }
      if (r.status === 422) return fail('too_long', j.message || 'The message is too large.');
      if (r.status === 403) return fail('forbidden', j.message || 'Twitch says this account can\'t chat there.');
      return fail('rejected', j.message || `Twitch answered HTTP ${r.status}.`);
    } catch (e) {
      if (e instanceof SignedOut) return fail('not_signed_in', this.session.problem || 'Not signed in to Twitch.');
      return fail('unreachable', 'Couldn\'t reach Twitch.');
    }
  }
}

module.exports = { TwitchSender, SCOPES, MAX_MESSAGE };
