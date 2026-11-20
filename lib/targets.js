'use strict';
// Which chat a reply goes to. One pinned source per platform, chosen
// explicitly and shown in the dock — never "whichever source happens to be
// first right now".
//
// Rules:
//   - a source is pinned automatically only when it is the sole source of its
//     platform at the moment it is added (the ordinary one-channel setup)
//   - after that the pin moves only when someone picks another source
//   - removing the pinned source leaves the platform with NO target; it does
//     not hop to another source
// Every target carries a key (source id + the channel or video it resolves
// to). The dock sends back the key it was showing; a send whose key no longer
// matches is refused, so a reply can't land somewhere the page didn't show.
const PLATFORMS = ['twitch', 'youtube'];

function createReplyTargets({ listSources, onChange = () => {} }) {
  const pins = { twitch: null, youtube: null };   // source id

  const of = p => listSources().filter(s => s.platform === p);

  function name(s) {
    if (s.platform === 'twitch') return '#' + ((s.adapter && s.adapter.channel) || s.channel || '?');
    return s.channel && s.channel !== 'youtube' ? s.channel : s.url;
  }

  function describe(s) {
    if (s.platform === 'twitch') {
      const channel = (s.adapter && s.adapter.channel) || null;
      return { channel, label: name(s), key: `${s.id}:${channel || ''}` };
    }
    const videoId = (s.adapter && s.adapter.videoId) || null;
    return {
      videoId, channel: s.channel,
      label: `${name(s)} · ${videoId ? 'video ' + videoId : 'not live yet'}`,
      key: `${s.id}:${videoId || ''}`,
    };
  }

  return {
    // call after a source has been added to the list
    added(entry) {
      if (!PLATFORMS.includes(entry.platform)) return;
      if (!pins[entry.platform] && of(entry.platform).length === 1) pins[entry.platform] = entry.id;
    },
    // call after a source has been removed from the list
    removed(entry) {
      if (pins[entry.platform] === entry.id) pins[entry.platform] = null;
    },
    // an explicit choice from the dock
    set(platform, sourceId) {
      if (!PLATFORMS.includes(platform)) return false;
      const s = of(platform).find(x => x.id === sourceId);
      if (!s) return false;
      pins[platform] = s.id;
      onChange();
      return true;
    },
    // startup: re-apply the choice saved in config.json (by URL — ids are per run)
    restore(saved) {
      for (const p of PLATFORMS) {
        const url = saved && typeof saved[p] === 'string' ? saved[p] : null;
        if (!url) continue;
        const s = of(p).find(x => x.url === url);
        if (s) pins[p] = s.id;
      }
    },
    // what to write to config.json
    toConfig() {
      const out = {};
      for (const p of PLATFORMS) {
        const s = pins[p] && of(p).find(x => x.id === pins[p]);
        if (s) out[p] = s.url;
      }
      return out;
    },
    // the shape lib/sendapi.js consumes
    get() {
      const out = {};
      for (const p of PLATFORMS) {
        const list = of(p);
        const choices = list.map(s => ({ id: s.id, label: name(s) }));
        const s = pins[p] && list.find(x => x.id === pins[p]);
        out[p] = s ? { pinned: true, sourceId: s.id, choices, ...describe(s) } : { pinned: false, choices };
      }
      return out;
    },
  };
}

module.exports = { createReplyTargets, PLATFORMS };
