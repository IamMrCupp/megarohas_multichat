'use strict';
// The stream info panel's decisions, kept out of the page so they can be
// tested in Node (test/info-logic.test.js) as well as loaded by
// public/info.html. The server checks everything again; this is so the page
// can say what's wrong before anything is sent.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InfoLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NAMES = ['twitch', 'youtube'];
  const LABEL = { twitch: 'Twitch', youtube: 'YouTube' };

  function count(s) { return Array.from(s || '').length; }

  // "repair, soldering,  Repair" -> ['repair', 'soldering']
  function parseTags(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || '').split(/[,\n]/)) {
      const tag = raw.replace(/\s+/g, ' ').trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
    return out;
  }

  // YouTube counts the commas between tags and two quotation marks around a
  // tag that has a space in it.
  function youtubeTagsLength(tags) {
    return tags.reduce((n, t) => n + count(t) + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
  }

  function ready(platforms, p) { return !!(platforms && platforms[p] && platforms[p].ready); }

  // The platforms a save goes to: ticked and ready.
  function wanted(platforms, ticked) { return NAMES.filter(p => ticked[p] && ready(platforms, p)); }

  // The tightest title limit among the platforms being saved to.
  function titleLimit(platforms, names) {
    let limit = 0; let by = null;
    for (const p of names) {
      const n = Number(platforms[p] && platforms[p].limits && platforms[p].limits.title) || 0;
      if (n && (!limit || n < limit)) { limit = n; by = p; }
    }
    return { limit, by };
  }

  // '' when the form can be saved to every platform in `names`, or the first
  // reason it can't.
  function problem(platforms, names, form) {
    if (!names.length) return 'Nothing to save to — tick a platform that\'s signed in.';
    const title = String(form.title || '').trim();
    const tags = form.tags || [];
    if (!title) return 'A title is needed.';
    for (const p of names) {
      const lim = (platforms[p] && platforms[p].limits) || {};
      if (lim.title && count(title) > lim.title) return `Too long for ${LABEL[p]} — ${lim.title} characters at most, this is ${count(title)}.`;
      if (p === 'youtube' && /[<>]/.test(title)) return 'YouTube titles can\'t contain < or >.';
      if (lim.tags && tags.length > lim.tags) return `${LABEL[p]} takes ${lim.tags} tags at most, this is ${tags.length}.`;
      for (const tag of tags) {
        if (p === 'twitch' && /\s/.test(tag)) return `Twitch tags can't contain spaces: "${tag}".`;
        if (lim.tagLength && count(tag) > lim.tagLength) return `${LABEL[p]} tags are ${lim.tagLength} characters at most: "${tag}".`;
        if (p === 'youtube' && /[<>]/.test(tag)) return 'YouTube tags can\'t contain < or >.';
      }
      if (lim.tagsTotal && youtubeTagsLength(tags) > lim.tagsTotal) return `${LABEL[p]} tags add up to ${lim.tagsTotal} characters at most.`;
    }
    return '';
  }

  // One line per platform for what it has now.
  function nowLine(p, current) {
    if (!current) return `${LABEL[p]}: not loaded`;
    if (!current.ok) return `${LABEL[p]}: ${current.reason}`;
    const i = current.info;
    const bits = [i.title || '(no title)'];
    if (i.category && (i.category.name || i.category.id)) bits.push(i.category.name || 'category ' + i.category.id);
    if (i.tags && i.tags.length) bits.push(i.tags.join(', '));
    return `${i.where || LABEL[p]}: ${bits.join(' · ')}`;
  }

  function resultLine(p, r) {
    if (r.ok) return { ok: true, text: `${LABEL[p]}: saved` + (r.note ? ` — ${r.note}` : '') };
    let text = `${LABEL[p]}: not saved — ${r.reason}`;
    if (r.retryAfter) text += ` (try again in ${Math.ceil(r.retryAfter)}s)`;
    return { ok: false, text };
  }

  // What a save sends, from the form and what the page is showing.
  function payload(names, form, current) {
    const category = {};
    const expect = {};
    for (const p of names) {
      const c = form.category && form.category[p];
      // Twitch can have no category; YouTube can't, so "none" there means "leave it".
      if (c && c.id) category[p] = { id: c.id, name: c.name || '' };
      else if (p === 'twitch' && form.category && form.category.twitch === null) category[p] = null;
      const cur = current && current[p];
      if (cur && cur.ok && cur.info.key) expect[p] = cur.info.key;
    }
    return { platforms: names, title: String(form.title || '').trim(), tags: form.tags || [], category, expect };
  }

  return { NAMES, LABEL, count, parseTags, youtubeTagsLength, ready, wanted, titleLimit, problem, nowLine, resultLine, payload };
});
