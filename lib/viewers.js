'use strict';
// Live viewer counts for the overlay's bar. Counts, not names.
//
// Where the numbers come from:
//   Twitch   the official Get Streams endpoint, with the sign-in the reply
//            dock already has (any user token, no extra scope). Not signed
//            in means "can't tell", never a made-up zero.
//              https://dev.twitch.tv/docs/api/reference/#get-streams
//   YouTube  the watch page's own interface (InnerTube updated_metadata) —
//            the same free, unofficial path the chat reader uses. It is NOT
//            the Data API: quota stays for replies only. If YouTube changes
//            its internals, parseYouTubeViewers() is the place to look.
//
// A platform's state is one of:
//   none     no source of that platform in the panel (no chip)
//   live     count is the number watching
//   offline  the stream isn't live
//   unknown  can't tell right now; note says why
const YT_ORIGIN = 'https://www.youtube.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PLATFORMS = ['twitch', 'youtube'];
const STALE_AFTER = 3;   // failed polls in a row before a known number is dropped

// updated_metadata -> { live, count }. The shape, as of 2026-11:
//   actions[].updateViewershipAction.viewCount.videoViewCountRenderer
//     { isLive: true, originalViewCount: "4467", viewCount: { simpleText: "4,467 watching now" } }
function parseYouTubeViewers(json) {
  for (const a of (json && json.actions) || []) {
    const r = a && a.updateViewershipAction && a.updateViewershipAction.viewCount
      && a.updateViewershipAction.viewCount.videoViewCountRenderer;
    if (!r) continue;
    if (!r.isLive) return { live: false, count: null };
    let n = Number(r.originalViewCount);
    if (!Number.isFinite(n)) {
      const text = (r.viewCount && (r.viewCount.simpleText || (r.viewCount.runs || []).map(x => x.text).join(''))) || '';
      const m = text.replace(/[,.\s ]/g, '').match(/\d+/);
      n = m ? Number(m[0]) : NaN;
    }
    return Number.isFinite(n) ? { live: true, count: Math.max(0, Math.round(n)) } : null;
  }
  return null;   // no viewership block at all: can't tell
}

async function fetchYouTubeViewers({ videoId, apiKey, clientVersion, origin = YT_ORIGIN, timeoutMs = 10000 }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const qs = (apiKey ? `key=${encodeURIComponent(apiKey)}&` : '') + 'prettyPrint=false';
    const r = await fetch(`${origin}/youtubei/v1/updated_metadata?${qs}`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'SOCS=CAI', 'content-type': 'application/json', origin: YT_ORIGIN },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: clientVersion || '2.20260708.00.00', hl: 'en', gl: 'US' } },
        videoId,
      }),
    });
    if (!r.ok) return null;
    return parseYouTubeViewers(await r.json());
  } finally { clearTimeout(timer); }
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// listSources()        -> the server's source entries
// twitch(logins)       -> Promise<{ state: 'ok', live: { login: count } } | { state: 'signed_out' | 'error', note? }>
// youtube(adapter)     -> Promise<{ live, count } | null>
// active()             -> false to skip polling (nobody is looking)
// onChange(counts)     -> called when the public picture changes
function createViewerCounts({ listSources, twitch, youtube, onChange = () => {}, active = () => true, intervalMs = 30000 }) {
  let counts = { twitch: { state: 'none', count: null, note: '' }, youtube: { state: 'none', count: null, note: '' } };
  const fails = { twitch: 0, youtube: 0 };
  let timer = null;
  let running = null;

  // Can't tell this time: keep a recent number for a few polls rather than
  // flicker, then admit it.
  function unsure(p, note) {
    fails[p]++;
    const prev = counts[p];
    if (prev.state === 'live' && fails[p] < STALE_AFTER) return prev;
    return { state: 'unknown', count: null, note };
  }

  async function pollTwitch(list) {
    const logins = [...new Set(list.map(s => s.adapter && s.adapter.channel).filter(Boolean))];
    if (!logins.length) return { state: 'unknown', count: null, note: '' };
    let r;
    try { r = await twitch(logins); } catch (e) { r = { state: 'error' }; }
    if (!r || r.state === 'error') return unsure('twitch', (r && r.note) || 'Couldn\'t reach Twitch.');
    if (r.state !== 'ok') { fails.twitch = 0; return { state: 'unknown', count: null, note: r.note || 'Sign in to Twitch on /setup to show viewers.' }; }
    fails.twitch = 0;
    const live = logins.filter(l => Number.isFinite(r.live[l]));
    if (!live.length) return { state: 'offline', count: null, note: '' };
    return { state: 'live', count: live.reduce((n, l) => n + r.live[l], 0), note: '' };
  }

  async function pollYouTube(list) {
    const watching = list.filter(s => s.adapter && s.adapter.videoId);
    if (!watching.length) { fails.youtube = 0; return { state: 'offline', count: null, note: '' }; }   // the reader hasn't found a broadcast
    const results = await Promise.all(watching.map(s => youtube(s.adapter).catch(() => null)));
    if (results.every(r => !r)) return unsure('youtube', 'Couldn\'t read the count from YouTube.');
    fails.youtube = 0;
    const live = results.filter(r => r && r.live);
    if (!live.length) return { state: 'offline', count: null, note: '' };
    return { state: 'live', count: live.reduce((n, r) => n + r.count, 0), note: '' };
  }

  async function refresh() {
    if (running) return running;
    running = (async () => {
      const sources = listSources();
      const next = {};
      await Promise.all(PLATFORMS.map(async p => {
        const list = sources.filter(s => s.platform === p);
        if (!list.length) { fails[p] = 0; next[p] = { state: 'none', count: null, note: '' }; return; }
        next[p] = p === 'twitch' ? await pollTwitch(list) : await pollYouTube(list);
      }));
      if (!same(next, counts)) { counts = next; onChange(counts); }
      return counts;
    })().finally(() => { running = null; });
    return running;
  }

  // Something just changed what a poll would say — a sign-in, a sign-out.
  // A poll already on the wire may have asked before the change, so wait it
  // out and ask again.
  async function refreshNow() {
    if (running) await running.catch(() => {});
    return refresh();
  }

  return {
    get: () => counts,
    refresh,
    refreshNow,
    start() {
      if (timer) return;
      timer = setInterval(() => { if (active()) refresh().catch(() => {}); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createViewerCounts, fetchYouTubeViewers, parseYouTubeViewers, PLATFORMS };
