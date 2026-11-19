'use strict';
// Gate for everything that can write to the streamer's accounts: sending chat
// messages, signing in, signing out. The overlay and the feed stay as open as
// they were; this module is only consulted for the routes in lib/sendapi.js.
//
// A request passes when all of these hold:
//   1. it came from this machine (loopback peer address, no proxy headers)
//   2. its Host header names this server on a loopback name — which is what
//      stops DNS rebinding: a hostile page that re-points its own name at
//      127.0.0.1 still sends its own name in Host
//   3. its Origin (and Sec-Fetch-Site, when the browser sends it) is this
//      server — which stops another site's page from posting here
//   4. it carries the session token, a per-process random value the dock page
//      reads from /api/dock/session and no other origin can read
const crypto = require('crypto');

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

function isLoopbackAddress(addr) {
  if (typeof addr !== 'string' || !addr) return false;
  if (addr === '::1') return true;
  const v4 = addr.toLowerCase().startsWith('::ffff:') ? addr.slice(7) : addr;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  return !!m && m[1] === '127' && m.slice(1).every(o => Number(o) <= 255);
}

function hostAllowed(host, port) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  return LOOPBACK_NAMES.some(n => h === `${n}:${port}`);
}

function originAllowed(origin, port) {
  if (typeof origin !== 'string') return false;
  const o = origin.trim().toLowerCase();
  return LOOPBACK_NAMES.some(n => o === `http://${n}:${port}`);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deny(code, error) { return { status: 403, code, error }; }

// opts.origin: 'require' — Origin must be present and ours (state-changing requests)
//              'if-present' — Origin may be absent (same-origin GET), must be ours if sent
//              'skip' — not checked (the OAuth redirect arrives as a cross-site navigation)
// opts.token:  the expected session token, or null when the route cannot carry one
// Returns null when the request may proceed, or { status, code, error }.
function check(req, opts) {
  const { port, origin = 'require', token = null, remoteAddress } = opts;
  const h = req.headers || {};
  const peer = remoteAddress !== undefined ? remoteAddress : (req.socket && req.socket.remoteAddress);

  if (!isLoopbackAddress(peer)) return deny('not_loopback', 'Sending only works from this machine.');
  if (h['x-forwarded-for'] !== undefined || h['forwarded'] !== undefined || h['x-real-ip'] !== undefined) {
    return deny('proxied', 'Sending is refused through a proxy.');
  }
  if (!hostAllowed(h.host, port)) return deny('bad_host', 'Unexpected Host header.');

  if (origin !== 'skip') {
    const o = h.origin;
    if (o === undefined) {
      if (origin === 'require') return deny('bad_origin', 'Missing Origin header.');
    } else if (!originAllowed(o, port)) {
      return deny('bad_origin', 'Cross-origin request refused.');
    }
    const site = h['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && !(site === 'none' && origin === 'if-present')) {
      return deny('bad_origin', 'Cross-site request refused.');
    }
  }

  if (token !== null) {
    const given = h['x-dock-token'];
    if (given === undefined || given === '') return deny('no_token', 'Missing dock token.');
    if (!tokenMatches(String(given), token)) return deny('bad_token', 'Wrong dock token.');
  }
  return null;
}

module.exports = { check, isLoopbackAddress, hostAllowed, originAllowed, newToken, tokenMatches, LOOPBACK_NAMES };
