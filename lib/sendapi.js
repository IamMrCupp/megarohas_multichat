'use strict';
// The dock's HTTP surface: the session the page reads its token from, the
// send endpoint, and the setup endpoints the platform senders plug into.
// Every route here goes through lib/gate.js. Nothing in a response ever
// carries an access token, a refresh token or a client secret.
//
// A sender is an object with:
//   maxLength           -> optional; the platform's own message length limit
//   status()            -> { configured, signedIn, as, detail }
//   send(text, target)  -> Promise<{ ok: true, id? } | { ok: false, code, reason, retryAfter? }>
//   setup(req)          -> optional; Promise<{ status, body } | null> for
//                          /api/setup/<platform>/<action>
//   setupState({port})  -> optional; extra, page-safe fields for the setup page
//   callback            -> optional; { matches(req, url), handle(req, res, url) } for a
//                          browser redirect coming back from the platform's sign-in
const gate = require('./gate');

const PLATFORMS = ['twitch', 'youtube'];
const LABEL = { twitch: 'Twitch', youtube: 'YouTube' };
const MAX_TEXT = 500;

function fail(code, reason, extra) { return { ok: false, code, reason, ...(extra || {}) }; }

function createSendApi(opts) {
  const {
    getPort,                 // () => the port the server actually listens on
    getTargets,              // () => lib/targets.js get(): per platform { pinned, key, label, choices, ... }
    setTarget = () => false, // (platform, sourceId) => bool — an explicit pick from the dock
    senders = {},            // { twitch?: sender, youtube?: sender }
    log = () => {},          // (kind, err) — must never be handed a secret
    disabled = () => '',     // () => why sending is off in this process, or ''
    notices = () => [],      // () => things the owner should see on /setup (never secrets)
    remoteAddress,           // test seam: req => address; defaults to the socket's
    token = gate.newToken(), // per-process session token
  } = opts;

  function json(res, code, obj) {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(obj));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', c => {
        data += c;
        if (data.length > 16384) { reject(new Error('body too large')); req.destroy(); }
      });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data || '{}'); } catch (e) { return reject(new Error('bad json')); }
        // null, a number, an array: valid JSON, not a request
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new Error('body must be a JSON object'));
        resolve(parsed);
      });
      req.on('error', reject);
    });
  }

  function gated(req, res, originMode, needToken) {
    const denied = gate.check(req, {
      port: getPort(),
      origin: originMode,
      token: needToken ? token : null,
      ...(remoteAddress ? { remoteAddress: remoteAddress(req) } : {}),
    });
    if (denied) { json(res, denied.status, { error: denied.error, code: denied.code }); return false; }
    return true;
  }

  function limitOf(p) {
    const s = senders[p];
    return Math.min(MAX_TEXT, (s && Number(s.maxLength)) || MAX_TEXT);
  }

  function platformStatus() {
    const targets = getTargets();
    const out = {};
    for (const p of PLATFORMS) {
      const off = disabled();
      const s = off ? null : senders[p];
      const st = s ? s.status() : { configured: false, signedIn: false, as: null, detail: off || `Sending to ${LABEL[p]} isn't in this build.` };
      const t = targets[p] || { pinned: false, choices: [] };
      out[p] = {
        available: !!s,
        configured: !!st.configured,
        signedIn: !!st.signedIn,
        as: st.as || null,
        detail: st.detail || '',
        // where a reply will go, exactly as the dock must show it
        connected: !!t.pinned,
        target: t.pinned ? t.label : null,
        targetKey: t.pinned ? t.key : null,
        choices: t.choices || [],
        maxLength: limitOf(p),
      };
    }
    return out;
  }

  async function sendOne(p, text, targets, expect) {
    const off = disabled();
    if (off) return fail('sending_disabled', off);
    const s = senders[p];
    if (!s) return fail('unavailable', `Sending to ${LABEL[p]} isn't in this build.`);
    if (!s.status().signedIn) return fail('not_signed_in', `Not signed in to ${LABEL[p]} — open /setup.`);
    const t = targets[p];
    if (!t || !t.pinned) {
      return fail('no_target', t && t.choices && t.choices.length
        ? `No ${LABEL[p]} reply target is chosen — pick one in the dock.`
        : `No ${LABEL[p]} chat is connected in the panel.`);
    }
    // The page says where the reply is going; send only if that's still true.
    if (typeof expect !== 'string' || expect !== t.key) {
      return fail('target_changed', `The ${LABEL[p]} reply target is now ${t.label} — check it and send again.`);
    }
    try {
      const r = await s.send(text, t);
      if (r && r.ok) return { ok: true, ...(r.id ? { id: r.id } : {}) };
      return fail((r && r.code) || 'failed', (r && r.reason) || 'The platform refused the message.',
        r && r.retryAfter ? { retryAfter: r.retryAfter } : null);
    } catch (e) {
      log('send:' + p, e);
      return fail('error', `Couldn't reach ${LABEL[p]}.`);
    }
  }

  // Returns true when the request was one of ours (and has been answered).
  async function handle(req, res, url) {
    const p = url.pathname;

    if (req.method === 'GET' && p === '/api/dock/session') {
      if (!gated(req, res, 'if-present', false)) return true;
      json(res, 200, { token, maxLength: MAX_TEXT, platforms: platformStatus() });
      return true;
    }

    if (req.method === 'POST' && p === '/api/send') {
      if (!gated(req, res, 'require', true)) return true;
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { error: e.message, code: 'bad_request' }); return true; }
      const target = body.target;
      const wanted = target === 'both' ? PLATFORMS : (PLATFORMS.includes(target) ? [target] : null);
      if (!wanted) { json(res, 400, { error: 'target must be twitch, youtube or both', code: 'bad_target' }); return true; }
      const text = typeof body.text === 'string' ? body.text.replace(/[\r\n\t]+/g, ' ').trim() : '';
      if (!text) { json(res, 400, { error: 'Nothing to send.', code: 'empty' }); return true; }
      // Checked against every wanted platform before anything is sent, so a
      // "both" can't land on one chat only because it was too long for the other.
      const length = Array.from(text).length;
      const over = wanted.filter(w => length > limitOf(w)).sort((a, b) => limitOf(a) - limitOf(b))[0];
      if (over) {
        json(res, 400, {
          error: `Too long for ${LABEL[over]} — ${limitOf(over)} characters at most, this is ${length}. Nothing was sent.`,
          code: 'too_long', platform: over, limit: limitOf(over), length,
        });
        return true;
      }
      const expect = body.expect && typeof body.expect === 'object' ? body.expect : {};
      const targets = getTargets();
      const results = {};
      await Promise.all(wanted.map(async w => { results[w] = await sendOne(w, text, targets, expect[w]); }));
      json(res, 200, { results });
      return true;
    }

    if (req.method === 'POST' && p === '/api/dock/target') {
      if (!gated(req, res, 'require', true)) return true;
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { error: e.message, code: 'bad_request' }); return true; }
      if (!PLATFORMS.includes(body.platform) || typeof body.source !== 'string' || !setTarget(body.platform, body.source)) {
        json(res, 400, { error: 'No such source for that platform.', code: 'bad_target' });
        return true;
      }
      json(res, 200, { platforms: platformStatus() });
      return true;
    }

    if (req.method === 'GET' && p === '/api/setup/state') {
      if (!gated(req, res, 'if-present', true)) return true;
      const platforms = platformStatus();
      const off = disabled();
      for (const name of PLATFORMS) {
        const s = senders[name];
        if (!off && s && s.setupState) Object.assign(platforms[name], s.setupState({ port: getPort() }));
      }
      json(res, 200, { platforms, notices: [off, ...notices()].filter(Boolean) });
      return true;
    }

    const m = /^\/api\/setup\/(twitch|youtube)\/([a-z-]+)$/.exec(p);
    if (m && req.method === 'POST') {
      if (!gated(req, res, 'require', true)) return true;
      const off = disabled();
      if (off) { json(res, 409, { error: off, code: 'sending_disabled' }); return true; }
      const s = senders[m[1]];
      if (!s || !s.setup) { json(res, 404, { error: `Sending to ${LABEL[m[1]]} isn't in this build.`, code: 'unavailable' }); return true; }
      let body;
      try { body = await readJson(req); } catch (e) { json(res, 400, { error: e.message, code: 'bad_request' }); return true; }
      try {
        const r = await s.setup({ action: m[2], body, port: getPort() });
        if (!r) { json(res, 404, { error: 'not found', code: 'not_found' }); return true; }
        json(res, r.status, r.body);
      } catch (e) {
        log('setup:' + m[1], e);
        json(res, 502, { error: `Couldn't reach ${LABEL[m[1]]}.`, code: 'error' });
      }
      return true;
    }

    // Senders that need a browser redirect (OAuth) claim their callback here.
    for (const name of PLATFORMS) {
      const s = disabled() ? null : senders[name];
      if (s && s.callback && s.callback.matches(req, url)) {
        const denied = gate.check(req, {
          port: getPort(), origin: 'skip', token: null,
          ...(remoteAddress ? { remoteAddress: remoteAddress(req) } : {}),
        });
        if (denied) { json(res, denied.status, { error: denied.error, code: denied.code }); return true; }
        try { await s.callback.handle(req, res, url); } catch (e) {
          log('callback:' + name, e);
          if (!res.headersSent) json(res, 502, { error: `Couldn't reach ${LABEL[name]}.`, code: 'error' });
        }
        return true;
      }
    }
    return false;
  }

  // For the panel's own state-changing routes in server.js: same gate, same token.
  function guard(req, res) { return gated(req, res, 'require', true); }

  return { handle, guard, token, platformStatus };
}

module.exports = { createSendApi, PLATFORMS, MAX_TEXT };
