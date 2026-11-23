'use strict';
// The stream info panel's HTTP surface: one form for title, category and
// tags, saved to Twitch and YouTube. It changes what the streamer's channels
// say, so every route goes through the same gate as sending (lib/gate.js, by
// way of the send API's guard): this machine, this server's own page, the
// session token. Nothing here returns a token or a client secret.
//
// A platform's sender takes part when it has:
//   infoStatus()             -> { configured, signedIn, as, needsPermission, ready, detail, limits }
//   checkInfo({title, tags}) -> '' or why the platform would refuse it
//   getInfo(want)            -> Promise<{ ok: true, info } | failure>
//   setInfo({title, categoryId, tags, expect}) -> Promise<{ ok: true, note? } | failure>
// and one of:
//   searchCategories(query)  -> Promise<{ ok: true, categories } | failure>   (Twitch: thousands, searched)
//   categories()             -> Promise<{ ok: true, categories } | failure>   (YouTube: a short fixed list)
// A failure is { ok: false, code, reason, retryAfter? }, as in lib/sendapi.js.
//
// Presets are named copies of the form kept in config.json. They hold what the
// form holds — a title, category names and IDs, tags — and never a secret.
const PLATFORMS = ['twitch', 'youtube'];
const LABEL = { twitch: 'Twitch', youtube: 'YouTube' };
const MAX_PRESETS = 30;
const MAX_TAGS = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function fail(code, reason, extra) { return { ok: false, code, reason, ...(extra || {}) }; }
function clip(v, n) { return Array.from(typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '').slice(0, n).join(''); }

// Tags as typed: trimmed, empties dropped, repeats dropped whatever their case.
function cleanTags(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list.slice(0, MAX_TAGS * 4) : []) {
    const tag = clip(raw, 100);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// { id, name } with a plausible ID, or null.
function cleanCategory(c) {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !ID_RE.test(c.id)) return null;
  return { id: c.id, name: clip(c.name, 100) };
}

function cleanPreset(p) {
  if (!p || typeof p !== 'object') return null;
  const name = clip(p.name, 40);
  if (!name) return null;
  const category = {};
  for (const platform of PLATFORMS) {
    const c = cleanCategory(p.category && p.category[platform]);
    if (c) category[platform] = c;
  }
  return { name, title: clip(p.title, 200), tags: cleanTags(p.tags), category };
}

function cleanPresets(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const p = cleanPreset(raw);
    if (p && !out.some(o => o.name.toLowerCase() === p.name.toLowerCase())) out.push(p);
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

function createInfoApi(opts) {
  const {
    api,                     // the send API: guard, json, readJson
    senders = {},            // the same senders sending uses
    disabled = () => '',     // () => why this process may not use the sign-ins, or ''
    getPresets = () => [],
    setPresets = () => {},
    log = () => {},          // (kind, err) — must never be handed a secret
  } = opts;
  const { guard, json, readJson } = api;

  function infoSender(p) {
    const s = disabled() ? null : senders[p];
    return s && s.infoStatus && s.getInfo && s.setInfo ? s : null;
  }

  function status() {
    const off = disabled();
    const out = {};
    for (const p of PLATFORMS) {
      const s = infoSender(p);
      const st = s ? s.infoStatus() : { configured: false, signedIn: false, ready: false, detail: off || `Stream info for ${LABEL[p]} isn't in this build.` };
      out[p] = {
        available: !!s,
        configured: !!st.configured,
        signedIn: !!st.signedIn,
        as: st.as || null,
        needsPermission: !!st.needsPermission,
        ready: !!st.ready,
        detail: st.detail || '',
        limits: st.limits || {},
        ...(st.quota ? { quota: st.quota } : {}),
        categories: s ? (s.searchCategories ? 'search' : (s.categories ? 'list' : 'none')) : 'none',
      };
    }
    return out;
  }

  // Run one platform call; whatever goes wrong is that platform's answer.
  async function ask(p, work) {
    const s = infoSender(p);
    if (!s) return fail(disabled() ? 'sending_disabled' : 'unavailable', disabled() || `Stream info for ${LABEL[p]} isn't in this build.`);
    try {
      const r = await work(s);
      if (r && r.ok) return r;
      return fail((r && r.code) || 'failed', (r && r.reason) || `${LABEL[p]} refused.`, r && r.retryAfter ? { retryAfter: r.retryAfter } : null);
    } catch (e) {
      log('info:' + p, e);
      return fail('error', `Couldn't reach ${LABEL[p]}.`);
    }
  }

  async function body(req, res) {
    try { return await readJson(req); } catch (e) { json(res, 400, { error: e.message, code: 'bad_request' }); return null; }
  }

  // Returns true when the request was one of ours (and has been answered).
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/api/info/')) return false;

    if (req.method === 'GET' && p === '/api/info/state') {
      if (!guard(req, res, 'if-present')) return true;
      json(res, 200, { platforms: status(), presets: cleanPresets(getPresets()), notices: [disabled()].filter(Boolean) });
      return true;
    }

    // What the platform has now. Costs YouTube quota, so the page asks when
    // it opens and when told to — not on a timer.
    if (req.method === 'GET' && p === '/api/info/current') {
      if (!guard(req, res, 'if-present')) return true;
      const platform = url.searchParams.get('platform');
      if (!PLATFORMS.includes(platform)) { json(res, 400, { error: 'platform must be twitch or youtube', code: 'bad_platform' }); return true; }
      const want = url.searchParams.get('want') || '';
      json(res, 200, await ask(platform, s => s.getInfo(ID_RE.test(want) ? want : undefined)));
      return true;
    }

    if (req.method === 'GET' && p === '/api/info/categories') {
      if (!guard(req, res, 'if-present')) return true;
      const platform = url.searchParams.get('platform');
      if (!PLATFORMS.includes(platform)) { json(res, 400, { error: 'platform must be twitch or youtube', code: 'bad_platform' }); return true; }
      const q = clip(url.searchParams.get('q') || '', 100);
      json(res, 200, await ask(platform, s => {
        if (s.searchCategories) return q ? s.searchCategories(q) : { ok: true, categories: [] };
        if (s.categories) return s.categories();
        return fail('unavailable', `${LABEL[platform]} has no categories to pick from.`);
      }));
      return true;
    }

    if (req.method === 'POST' && p === '/api/info/save') {
      if (!guard(req, res)) return true;
      const b = await body(req, res);
      if (!b) return true;
      const wanted = Array.isArray(b.platforms) ? PLATFORMS.filter(x => b.platforms.includes(x)) : [];
      if (!wanted.length) { json(res, 400, { error: 'Pick Twitch, YouTube or both.', code: 'bad_platforms' }); return true; }
      const title = clip(b.title, 500);
      const tags = cleanTags(b.tags);
      // Checked against every wanted platform before anything is saved, so a
      // title that fits one and not the other doesn't leave the two different.
      for (const w of wanted) {
        const s = infoSender(w);
        const why = s && s.checkInfo ? s.checkInfo({ title, tags }) : '';
        if (why) { json(res, 400, { error: `${why} Nothing was saved.`, code: 'invalid', platform: w }); return true; }
      }
      const category = b.category && typeof b.category === 'object' ? b.category : {};
      const expect = b.expect && typeof b.expect === 'object' ? b.expect : {};
      const results = {};
      await Promise.all(wanted.map(async w => {
        // absent: leave the category alone. null: clear it. { id }: set it.
        let categoryId;
        if (category[w] === null) categoryId = '';
        else if (category[w] !== undefined) {
          const c = cleanCategory(category[w]);
          if (!c) { results[w] = fail('bad_category', `That isn't a ${LABEL[w]} category.`); return; }
          categoryId = c.id;
        }
        const r = await ask(w, s => s.setInfo({
          title, tags, categoryId, expect: typeof expect[w] === 'string' ? expect[w] : undefined,
        }));
        results[w] = r.ok ? { ok: true, ...(r.note ? { note: r.note } : {}), ...(r.cost ? { cost: r.cost } : {}) } : r;
      }));
      json(res, 200, { results });
      return true;
    }

    if (req.method === 'POST' && p === '/api/info/presets') {
      if (!guard(req, res)) return true;
      const b = await body(req, res);
      if (!b) return true;
      const preset = cleanPreset(b);
      if (!preset) { json(res, 400, { error: 'A preset needs a name.', code: 'bad_preset' }); return true; }
      const list = cleanPresets(getPresets());
      const at = list.findIndex(x => x.name.toLowerCase() === preset.name.toLowerCase());
      if (at < 0 && list.length >= MAX_PRESETS) { json(res, 400, { error: `${MAX_PRESETS} presets at most — delete one first.`, code: 'too_many' }); return true; }
      if (at < 0) list.push(preset); else list[at] = preset;
      setPresets(list);
      json(res, 200, { presets: list });
      return true;
    }

    if (req.method === 'POST' && p === '/api/info/presets/delete') {
      if (!guard(req, res)) return true;
      const b = await body(req, res);
      if (!b) return true;
      const name = clip(b.name, 40).toLowerCase();
      const list = cleanPresets(getPresets()).filter(x => x.name.toLowerCase() !== name);
      setPresets(list);
      json(res, 200, { presets: list });
      return true;
    }

    // Anything else under /api/info/ is nobody's: refuse it here, gated, so
    // an unknown path can't fall through to an ungated handler later.
    if (!guard(req, res, req.method === 'GET' ? 'if-present' : 'require')) return true;
    json(res, 404, { error: 'not found', code: 'not_found' });
    return true;
  }

  return { handle, status };
}

module.exports = { createInfoApi, cleanTags, cleanPreset, cleanPresets, PLATFORMS, MAX_PRESETS };
