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
//
// Stream info (title, category, tags) uses the same sign-in and scope, and
// spends quota only when the info panel is opened, refreshed or saved:
//   liveBroadcasts.list     1 unit   find the live (or next upcoming) broadcast
//   videos.list             1 unit   its tags — a broadcast resource has none
//   videoCategories.list    1 unit   once per run, for the category menu
//   liveBroadcasts.update   1 unit   title and category
//   videos.update          50 units  only when the tags changed
//     https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list
//     https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/update
//     https://developers.google.com/youtube/v3/docs/videos/update
//     https://developers.google.com/youtube/v3/docs/videoCategories/list
// Both update calls delete any property the request leaves out, so each one
// sends back what it read for the fields it isn't changing.
const crypto = require('crypto');
const { TokenSession, SignedOut, fail, fetchJson, postForm } = require('./oauth-session');

const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
// Units, from the quota cost table linked above.
const COST = {
  insert: 20, videosList: 1, channelsList: 1, dailyDefault: 10000,
  broadcastsList: 1, broadcastsUpdate: 1, videosUpdate: 50, categoriesList: 1,
};
// liveBroadcasts.update: "snippet.title must be between 1 and 100 characters
// long". Video resource: title "may contain all valid UTF-8 characters except
// < and >"; snippet.tags[] "has a maximum length of 500 characters", counting
// the commas between tags and two quotation marks for a tag with a space in it.
//   https://developers.google.com/youtube/v3/docs/videos#snippet.tags[]
const INFO_LIMITS = { title: 100, tagsTotal: 500 };
const CATEGORY_REGION = 'US';

function tagsLength(tags) {
  return tags.reduce((n, t) => n + Array.from(t).length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}
function sameList(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
// YouTube Help puts the live chat limit at 200 characters a message; the API
// reference gives no number of its own, so that's the one enforced here,
// before any quota is spent.
//   https://support.google.com/youtube/answer/2524549
const MAX_MESSAGE = 200;
const EXPIRED = 'Google sign-in expired — sign in again.';
const SIGNIN_WINDOW_MS = 10 * 60 * 1000;
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const DEFAULT_ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/youtube/v3',
};
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{10,200}$/;

// the client credentials outlive a sign-in
function clientOnly(y) {
  return y && y.clientId ? { clientId: y.clientId, ...(y.clientSecret ? { clientSecret: y.clientSecret } : {}) } : null;
}
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
  // store: SecretStore. getViewerSource/setViewerSource: where the overlay's
  // YouTube viewer count comes from, kept in config.json ('free' unless the
  // owner opts into 'api'). endpoints/now are test seams.
  // onAuthChange: called after a sign-in lands or a sign-in ends (see the
  // Twitch sender).
  constructor({ store, endpoints, now, timeoutMs = 10000, getViewerSource = () => 'free', setViewerSource = () => {}, onAuthChange = () => {} }) {
    this.onAuthChange = onAuthChange;
    this.getViewerSource = getViewerSource;
    this.setViewerSource = setViewerSource;
    this.store = store;
    this.ep = { ...DEFAULT_ENDPOINTS, ...(endpoints || {}) };
    this.now = now || Date.now;
    this.timeoutMs = timeoutMs;
    this.pending = null;            // sign-in in progress: { state, verifier, redirectUri, expiresAt }
    this.signinError = '';
    this.maxLength = MAX_MESSAGE;
    this.chatIds = new Map();       // videoId -> liveChatId
    this.categoryList = null;       // videoCategories.list, asked once per run
    // tokens on disk, refresh, the 401 retry: shared with the Twitch sender
    this.session = new TokenSession({
      store, section: 'youtube', now: this.now, timeoutMs,
      expiredMessage: EXPIRED,   // invalid_grant: revoked, unused for six months, or a 7-day token from a project still in Testing
      keep: clientOnly,
      refreshRequest: y => ({
        url: this.ep.token,
        params: {
          client_id: y.clientId,
          ...(y.clientSecret ? { client_secret: y.clientSecret } : {}),
          grant_type: 'refresh_token',
          refresh_token: y.refreshToken,
        },
      }),
    });
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
    else if (!signedIn && this.session.problem) detail = this.session.problem;
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
      // free = the watch page's own interface, no quota; api = videos.list, 1 unit a poll
      viewerSource: this.getViewerSource() === 'api' ? 'api' : 'free',
      viewerPollCost: COST.videosList,
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
  _fetch(url, opts) { return fetchJson(url, opts, this.timeoutMs); }
  _form(url, params) { return postForm(url, params, this.timeoutMs); }

  // Anything that ends or replaces the sign-in goes through here first, so a
  // refresh still on the wire can't write the old tokens — or the old client —
  // back over what comes next.
  _reset() {
    this.session.invalidate();
    this.pending = null;
    this.session.problem = '';
    this.signinError = '';
    this.chatIds.clear();
  }

  // ---------- setup actions (POST /api/setup/youtube/<action>) ----------
  async setup({ action, body, port }) {
    if (action === 'client') return this._setClient(body || {});
    if (action === 'signin') return this._startSignin(port);
    if (action === 'signout') return this._signOut();
    if (action === 'viewers') {
      const source = body && body.source;
      if (source !== 'free' && source !== 'api') return { status: 400, body: { error: 'source must be free or api', code: 'bad_source' } };
      this.setViewerSource(source);
      return { status: 200, body: { ok: true } };
    }
    return null;
  }

  _setClient(body) {
    const y = this.store.get('youtube') || {};
    const clientId = String(body.clientId || '').trim();
    const given = String(body.clientSecret || '').trim();
    if (!clientId) {
      this._reset();
      this.store.set('youtube', null);
      this._authChanged();
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
    this._reset();
    this.store.set('youtube', { clientId, ...(clientSecret ? { clientSecret } : {}) });   // tokens belong to the old client
    this._authChanged();
    return { status: 200, body: { ok: true } };
  }

  // A listener that throws must not undo a sign-in or a sign-out.
  _authChanged() { try { this.onAuthChange(); } catch (e) { /* theirs to fix */ } }

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
    // Compare as bytes, and compare the byte lengths first: timingSafeEqual
    // throws on a length mismatch, and a non-ASCII state has more bytes than
    // characters.
    const given = Buffer.from(state, 'utf8');
    const expected = p ? Buffer.from(p.state, 'utf8') : null;
    const known = !!expected && given.length === expected.length && crypto.timingSafeEqual(given, expected);
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
    // The client was changed or removed while the browser was at Google.
    const nowClient = this.store.get('youtube') || {};
    if (nowClient.clientId !== y.clientId) return bad('The Google client changed during sign-in. Start again.');
    this.session.invalidate();
    this.store.set('youtube', {
      clientId: y.clientId,
      ...(y.clientSecret ? { clientSecret: y.clientSecret } : {}),
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: this.now() + (Number(j.expires_in) || 0) * 1000,
      channelId: ch.id || '',
      channelTitle: (ch.snippet && ch.snippet.title) || '',
    });
    this.session.problem = '';
    this.signinError = '';
    this._authChanged();
    res.writeHead(302, { Location: '/setup', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  async _signOut() {
    const y = this.store.get('youtube') || {};
    this._reset();
    this.store.set('youtube', clientOnly(y));     // keep the client, drop the tokens
    this._authChanged();
    if (y.refreshToken) {
      try { await this._form(this.ep.revoke, { token: y.refreshToken }); } catch (e) { /* offline is fine */ }
    }
    return { status: 200, body: { ok: true } };
  }

  // An authorised API call (one refresh and one retry on a 401). Every
  // attempt is counted against the quota estimate.
  _api(method, pathAndQuery, body, cost) {
    return this.session.authorized(y => {
      this._spend(cost);
      return this._fetch(this.ep.api + pathAndQuery, {
        method,
        headers: { authorization: 'Bearer ' + y.accessToken, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    });
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
      this.session.expire();
      return fail('not_signed_in', EXPIRED);
    }
    // the chat we cached is gone: look it up fresh next time
    if (reason === 'liveChatEnded' || reason === 'liveChatNotFound') this.chatIds.delete(videoId);
    return fail(reason || 'rejected', message);
  }

  // ---------- viewer count through the official API (opt-in) ----------
  // videos.list?part=liveStreamingDetails — 1 unit a call. concurrentViewers
  // is only present while the broadcast has viewers and the owner hasn't
  // hidden the count.
  //   https://developers.google.com/youtube/v3/docs/videos
  // -> { live, count } | null (can't tell: not signed in, quota gone, error —
  //    the caller falls back to the free path)
  async viewers(videoId) {
    if (!videoId || !this.status().signedIn || this.now() < this.quotaBlockedUntil) return null;
    try {
      const r = await this._api('GET', `/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}`, null, COST.videosList);
      if (r.status !== 200) { this._refusal(r, videoId); return null; }   // records quota exhaustion / a dead sign-in
      const v = r.json && Array.isArray(r.json.items) && r.json.items[0];
      const d = v && v.liveStreamingDetails;
      if (!d) return null;
      if (d.actualEndTime || !d.actualStartTime) return { live: false, count: null };
      const n = Number(d.concurrentViewers);
      return Number.isFinite(n) ? { live: true, count: n } : null;        // live, but the count is hidden
    } catch (e) { return null; }
  }

  // ---------- stream info (title, category, tags) ----------
  infoStatus() {
    const st = this.status();
    let detail = st.detail;
    if (!st.configured) detail = 'YouTube is off until a Google client is set up — open /setup.';
    else if (!st.signedIn) detail = detail || 'Not signed in to YouTube.';
    return {
      configured: st.configured, signedIn: st.signedIn, as: st.as, needsPermission: false,
      ready: st.signedIn, detail, limits: INFO_LIMITS,
      quota: {
        load: COST.broadcastsList + COST.videosList,
        saveTitle: COST.broadcastsList + COST.videosList + COST.broadcastsUpdate,
        saveTags: COST.broadcastsList + COST.videosList + COST.videosUpdate,
        dailyDefault: COST.dailyDefault,
        exhausted: this.now() < this.quotaBlockedUntil,
      },
    };
  }

  checkInfo({ title, tags }) {
    if (!title) return 'YouTube needs a title.';
    if (Array.from(title).length > INFO_LIMITS.title) return `YouTube titles are ${INFO_LIMITS.title} characters at most.`;
    if (/[<>]/.test(title)) return 'YouTube titles can\'t contain < or >.';
    if (tags.some(t => /[<>,]/.test(t))) return 'YouTube tags can\'t contain < > or a comma.';
    if (tagsLength(tags) > INFO_LIMITS.tagsTotal) return `YouTube tags add up to ${INFO_LIMITS.tagsTotal} characters at most.`;
    return '';
  }

  async _info(work) {
    if (!this.status().signedIn) return fail('not_signed_in', this.session.problem || 'Not signed in to YouTube.');
    if (this.now() < this.quotaBlockedUntil) return this._quotaBlocked();
    try { return await work(); } catch (e) {
      if (e && e.refusal) return e.refusal;
      if (e instanceof SignedOut) return fail('not_signed_in', this.session.problem || 'Not signed in to YouTube.');
      return fail('unreachable', 'Couldn\'t reach YouTube.');
    }
  }

  // A GET that either answers 200 or throws Google's refusal for _info to return.
  async _read(pathAndQuery, cost) {
    const r = await this._api('GET', pathAndQuery, null, cost);
    if (r.status !== 200) throw { refusal: this._refusal(r) };
    return (r.json && Array.isArray(r.json.items)) ? r.json.items : [];
  }

  // The signed-in channel's broadcasts that a save could apply to: whatever
  // is live now, or — when nothing is — whatever is scheduled, soonest first.
  // The reference wants exactly one filter per call, so that is two calls at
  // most. broadcastType=all includes the stream-key ("persistent") broadcast.
  async _broadcasts() {
    const list = status => this._read(
      `/liveBroadcasts?part=id,snippet&broadcastStatus=${status}&broadcastType=all&maxResults=50`, COST.broadcastsList);
    let state = 'live';
    let items = await list('active');
    if (!items.length) {
      state = 'upcoming';
      items = (await list('upcoming')).sort((a, b) =>
        String((a.snippet || {}).scheduledStartTime || '').localeCompare(String((b.snippet || {}).scheduledStartTime || '')));
    }
    return items.filter(b => b && b.id && b.snippet).map(b => ({ id: String(b.id), state, snippet: b.snippet }));
  }

  // The broadcast a save goes to, and the video that carries its tags. The
  // reference says a broadcast "represents exactly one YouTube video" without
  // saying the two share an ID, so that is checked here, not assumed: if
  // videos.list has nothing under the broadcast's ID, tags are left alone.
  async _current(want) {
    const all = await this._broadcasts();
    if (!all.length) throw { refusal: fail('no_broadcast', 'No live or upcoming broadcast on this channel. Create one in YouTube Studio first.') };
    const chosen = (want && all.find(b => b.id === want)) || all[0];
    const videos = await this._read(`/videos?part=snippet&id=${encodeURIComponent(chosen.id)}`, COST.videosList);
    const video = videos.find(v => v && v.id === chosen.id && v.snippet) || null;
    return { all, chosen, video };
  }

  // -> { ok, info: { title, category, tags, where, key, choices, tagsKnown } }
  getInfo(want) {
    return this._info(async () => {
      const { all, chosen, video } = await this._current(want);
      const sn = chosen.snippet;
      const categoryId = (video && video.snippet.categoryId) || sn.categoryId || '';
      const label = b => `${b.snippet.title || 'Untitled'} (${b.state})`;
      return {
        ok: true,
        info: {
          title: String(sn.title || ''),
          category: categoryId ? { id: String(categoryId), name: '' } : null,
          tags: video && Array.isArray(video.snippet.tags) ? video.snippet.tags.map(String) : [],
          tagsKnown: !!video,
          where: `YouTube (${chosen.state})`,
          key: chosen.id,
          choices: all.map(b => ({ id: b.id, label: label(b) })),
        },
      };
    });
  }

  // expect: the broadcast the page was showing. categoryId undefined leaves
  // the category alone (YouTube has no "no category").
  setInfo({ title, categoryId, tags, expect }) {
    return this._info(async () => {
      const { chosen, video } = await this._current(expect);
      if (!expect || chosen.id !== expect) {
        return fail('target_changed', `The YouTube broadcast is now "${chosen.snippet.title || 'Untitled'}" — check it and save again.`);
      }
      const sn = chosen.snippet;
      const oldTags = video && Array.isArray(video.snippet.tags) ? video.snippet.tags.map(String) : [];
      if (video && !sameList(oldTags, tags)) {
        const vs = video.snippet;
        const category = categoryId || vs.categoryId;
        if (!category) return fail('no_category', 'YouTube needs a category to save tags — pick one.');
        const r = await this._api('PUT', '/videos?part=snippet', {
          id: chosen.id,
          snippet: {
            title, categoryId: String(category), tags,
            description: vs.description || '',
            ...(vs.defaultLanguage ? { defaultLanguage: vs.defaultLanguage } : {}),
            ...(vs.defaultAudioLanguage ? { defaultAudioLanguage: vs.defaultAudioLanguage } : {}),
          },
        }, COST.videosUpdate);
        return r.status === 200 ? { ok: true, cost: COST.videosUpdate } : this._refusal(r);
      }
      const category = categoryId || sn.categoryId;
      const r = await this._api('PUT', '/liveBroadcasts?part=snippet', {
        id: chosen.id,
        snippet: {
          title,
          description: sn.description || '',
          scheduledStartTime: sn.scheduledStartTime,
          ...(sn.scheduledEndTime ? { scheduledEndTime: sn.scheduledEndTime } : {}),
          ...(category ? { categoryId: String(category) } : {}),
        },
      }, COST.broadcastsUpdate);
      if (r.status !== 200) return this._refusal(r);
      return {
        ok: true, cost: COST.broadcastsUpdate,
        ...(!video && tags.length ? { note: 'Title saved. Tags were not: YouTube has no video for this broadcast yet.' } : {}),
      };
    });
  }

  // The category menu. Asked once per run; categories rarely change.
  categories() {
    if (this.categoryList) return Promise.resolve({ ok: true, categories: this.categoryList });
    return this._info(async () => {
      const items = await this._read(`/videoCategories?part=snippet&regionCode=${CATEGORY_REGION}`, COST.categoriesList);
      this.categoryList = items
        .filter(c => c && c.id && c.snippet && c.snippet.assignable !== false)
        .map(c => ({ id: String(c.id), name: String(c.snippet.title || c.id) }));
      return { ok: true, categories: this.categoryList };
    });
  }

  // ---------- send ----------
  async send(text, target) {
    if (this.now() < this.quotaBlockedUntil) return this._quotaBlocked();
    if (Array.from(text).length > MAX_MESSAGE) return fail('too_long', `YouTube live chat messages are ${MAX_MESSAGE} characters at most.`);
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
      if (e instanceof SignedOut) return fail('not_signed_in', this.session.problem || 'Not signed in to YouTube.');
      return fail('unreachable', 'Couldn\'t reach YouTube.');
    }
  }
}

module.exports = { YouTubeSender, SCOPE, COST, INFO_LIMITS, MAX_MESSAGE, msUntilPacificMidnight, tagsLength };
