'use strict';
// megarohas_multichat — local multi-platform stream chat aggregator for OBS.
// Zero dependencies: plain Node http + SSE, anonymous Twitch IRC, YouTube InnerTube polling.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const VERSION = require('./package.json').version;
const { TwitchSource, channelFromUrl } = require('./lib/twitch');
const { YouTubeSource } = require('./lib/youtube');
const { createSendApi } = require('./lib/sendapi');
const { SecretStore, acquireSendLock } = require('./lib/tokens');
const { TwitchSender } = require('./lib/twitch-send');
const { YouTubeSender } = require('./lib/youtube-send');
const { createViewerCounts, fetchYouTubeViewers } = require('./lib/viewers');
const { createReplyTargets } = require('./lib/targets');

// Когда приложение собрано в единый исполняемый файл (Node SEA, см.
// build/build.js), статика отдаётся из встроенных ассетов, а изменяемые
// файлы (config.json, fonts, error.log) живут рядом с бинарником.
let sea = null;
try {
  const s = require('node:sea');
  if (s.isSea()) sea = s;
} catch (e) {}

const ROOT = __dirname;
// MULTICHAT_DIR moves the mutable files (config.json, fonts, error.log) somewhere
// else — the tests use it to run a throwaway copy without touching real config.
const APP_DIR = process.env.MULTICHAT_DIR || (sea ? path.dirname(process.execPath) : ROOT);
const PUBLIC = path.join(ROOT, 'public');
const FONTS_DIR = path.join(APP_DIR, 'fonts');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const HISTORY_CAP = 100;
const FONT_RE = /\.(ttf|otf|woff2?)$/i;

try { fs.mkdirSync(FONTS_DIR, { recursive: true }); } catch (e) {}

// ---------- крешеустойчивость ----------
// Локальная тулза должна пережить любой неожиданный сбой источника/сети:
// пишем в error.log и продолжаем работать, а не молча умираем.
const LOG_PATH = path.join(APP_DIR, 'error.log');
function logErr(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${(err && err.stack) || err}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch (e) {}
  console.error(line.trim());
}
process.on('uncaughtException', e => logErr('uncaughtException', e));
process.on('unhandledRejection', e => logErr('unhandledRejection', e));

// ---------- config ----------
// The fork binds loopback by default: the same process can now post to the
// streamer's accounts. Put "host": "0.0.0.0" in config.json to show the
// overlay to other devices on the LAN (OBS on another PC, a phone) — the
// overlay and the feed open up, sending and the panel's controls stay local.
let config = { host: '127.0.0.1', port: 3131, sources: [] };
try {
  // Блокнот и PowerShell любят сохранять UTF-8 с BOM — срезаем
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  config = { ...config, ...raw };
  if (!Array.isArray(config.sources)) config.sources = [];
} catch (e) { /* first run */ }

function saveConfig() {
  const out = {
    host: config.host,
    port: config.port,
    sources: [...sources.values()].map(s => ({ id: s.id, url: s.url })),
  };
  // the Twitch application's client ID is public, so it lives here; tokens don't
  if (config.twitchClientId) out.twitchClientId = config.twitchClientId;
  // opt-ins to an official API where a free path is the default
  if (config.youtubeViewers === 'api') out.youtubeViewers = 'api';
  const replyTo = replyTargets.toConfig();
  if (Object.keys(replyTo).length) out.replyTo = replyTo;
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2)); } catch (e) {
    console.error('Не удалось сохранить config.json:', e.message);
  }
}

// ---------- SSE hub ----------
const clients = new Set();
let history = [];

function sseFrame(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

function broadcast(obj) {
  const frame = sseFrame(obj);
  for (const res of clients) {
    try { res.write(frame); } catch (e) { clients.delete(res); }
  }
}

setInterval(() => {
  for (const res of clients) { try { res.write(':hb\n\n'); } catch (e) { clients.delete(res); } }
}, 25000).unref();

function pushHistory(msg) {
  history.push(msg);
  if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);
}

// ---------- sources ----------
const sources = new Map(); // id -> entry

function detectPlatform(url) {
  let u;
  try { u = new URL(/^https?:/i.test(url) ? url : 'https://' + url); } catch (e) { return null; }
  const h = u.hostname.toLowerCase();
  if (/(^|\.)twitch\.tv$/.test(h)) return 'twitch';
  if (/(^|\.)youtube\.com$/.test(h) || h === 'youtu.be') return 'youtube';
  return null;
}

function statusList() {
  return [...sources.values()].map(s => ({
    id: s.id, url: s.url, platform: s.platform, channel: s.channel, state: s.state, detail: s.detail,
  }));
}

function broadcastStatus() {
  broadcast({ type: 'status', sources: statusList() });
}

function makeHandlers(entry) {
  return {
    onMessage(m) {
      const msg = {
        type: 'msg',
        ...m,
        source: entry.id,
        platform: entry.platform,
        channel: entry.channel,
        ts: Date.now(),
      };
      pushHistory(msg);
      broadcast(msg);
    },
    onRemove(id) {
      history = history.filter(m => m.id !== id);
      broadcast({ type: 'remove', id });
    },
    onRemoveAuthor(key) {
      history = history.filter(m => !(m.source === entry.id && m.author && m.author.key === key));
      broadcast({ type: 'removeAuthor', source: entry.id, key });
    },
    onClear() {
      history = history.filter(m => m.source !== entry.id);
      broadcast({ type: 'clear', source: entry.id });
    },
    onStatus(state, detail) {
      entry.state = state;
      entry.detail = detail || '';
      broadcastStatus();
    },
    onMeta(meta) {
      if (meta.channel) entry.channel = meta.channel;
      broadcastStatus();
    },
  };
}

function startAdapter(entry) {
  const h = makeHandlers(entry);
  if (entry.platform === 'twitch') {
    const channel = channelFromUrl(entry.url);
    if (!channel) {
      entry.state = 'error';
      entry.detail = 'не смог достать имя канала из ссылки';
      return;
    }
    entry.channel = channel;
    entry.adapter = new TwitchSource(channel, h);
  } else {
    entry.adapter = new YouTubeSource(entry.url, h);
  }
  entry.adapter.start();
}

function addSource(url, save = true) {
  const platform = detectPlatform(url);
  if (!platform) return { error: 'Не похоже на ссылку Twitch или YouTube' };
  const entry = {
    id: crypto.randomBytes(4).toString('hex'),
    url, platform,
    channel: platform,
    state: 'connecting',
    detail: '',
    adapter: null,
  };
  sources.set(entry.id, entry);
  startAdapter(entry);
  replyTargets.added(entry);
  if (save) saveConfig();
  broadcastStatus();
  return { source: { id: entry.id, url, platform } };
}

function removeSource(id) {
  const entry = sources.get(id);
  if (!entry) return false;
  if (entry.adapter) entry.adapter.stop();
  sources.delete(id);
  replyTargets.removed(entry);
  history = history.filter(m => m.source !== id);
  broadcast({ type: 'clear', source: id });
  saveConfig();
  broadcastStatus();
  return true;
}

function reconnectSource(id) {
  const entry = sources.get(id);
  if (!entry) return false;
  if (entry.adapter) entry.adapter.stop();
  entry.state = 'connecting';
  entry.detail = '';
  startAdapter(entry);
  broadcastStatus();
  return true;
}

// ---------- sending (the dock) ----------
// Reading stays anonymous and open. Everything that writes to an account goes
// through lib/sendapi.js, which refuses anything that isn't this machine.
// Where a reply goes is pinned per platform and shown in the dock — see
// lib/targets.js. It never follows the source list around by itself.
const replyTargets = createReplyTargets({
  listSources: () => [...sources.values()],
  onChange: () => { saveConfig(); broadcastStatus(); },
});

// Tokens and client secrets: secrets.json beside config.json, owner-only.
// A second copy started from the same folder reads chat but doesn't send: two
// processes sharing single-use refresh tokens would sign each other out.
const secrets = new SecretStore(path.join(APP_DIR, 'secrets.json'), { log: logErr });
const sendLock = acquireSendLock(APP_DIR);
process.on('exit', () => sendLock.release());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
const twitchSender = new TwitchSender({
  store: secrets,
  getClientId: () => (typeof config.twitchClientId === 'string' ? config.twitchClientId : ''),
  setClientId: id => { config.twitchClientId = id; saveConfig(); },
});

const youtubeSender = new YouTubeSender({
  store: secrets,
  getViewerSource: () => (config.youtubeViewers === 'api' ? 'api' : 'free'),
  setViewerSource: source => { config.youtubeViewers = source; saveConfig(); },
});

const sendApi = createSendApi({
  getPort: () => actualPort,
  getTargets: () => replyTargets.get(),
  setTarget: (platform, id) => replyTargets.set(platform, id),
  senders: { twitch: twitchSender, youtube: youtubeSender },
  disabled: () => (sendLock.held ? '' : sendLock.reason),
  notices: () => [secrets.problem],
  log: logErr,
});

// ---------- viewer counts (the overlay's bar) ----------
// Twitch through the official API with the dock's sign-in; YouTube through
// the watch page's own interface, so no API quota is spent. Only polled while
// a page is connected, and never with the tokens in a copy that doesn't own
// sending.
const viewerCounts = createViewerCounts({
  listSources: () => [...sources.values()],
  twitch: logins => (sendLock.held
    ? twitchSender.viewers(logins)
    : Promise.resolve({ state: 'signed_out', note: 'Viewer counts for Twitch come from the copy of the server that owns sending.' })),
  // Free by default. With "youtubeViewers": "api" in config.json (or the switch
  // on /setup) the official API is asked first; if it can't answer — not
  // signed in, quota gone, count hidden — the free path still does.
  youtube: async adapter => {
    if (config.youtubeViewers === 'api' && sendLock.held) {
      const official = await youtubeSender.viewers(adapter.videoId);
      if (official) return official;
    }
    return fetchYouTubeViewers({ videoId: adapter.videoId, apiKey: adapter.apiKey, clientVersion: adapter.clientVersion });
  },
  intervalMs: config.youtubeViewers === 'api' ? 60000 : 30000,
  active: () => clients.size > 0,
  onChange: viewers => broadcast({ type: 'viewers', viewers }),
});

// ---------- test messages (style the overlay without being live) ----------
// English, and each one says it's a test — so one that lands on stream explains itself.
let testN = 0;
function testMessages() {
  const t = () => Date.now();
  const id = () => 'test:' + (++testN) + ':' + Math.random().toString(36).slice(2);
  const base = { type: 'msg', source: 'test', ts: t() };
  return [
    { ...base, id: id(), platform: 'twitch', channel: 'test', kind: 'chat',
      author: { name: 'ExampleViewer', color: '#ff69b4', roles: ['sub'], key: 'exampleviewer' },
      parts: [{ t: 'text', v: 'Test message from Twitch ' }, { t: 'emote', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', alt: 'Kappa' }] },
    { ...base, id: id(), platform: 'youtube', channel: 'test', kind: 'chat',
      author: { name: 'Example Member', color: null, roles: ['member'], key: 'UCtest' },
      parts: [{ t: 'text', v: 'Test message from YouTube 😀' }] },
    { ...base, id: id(), platform: 'twitch', channel: 'test', kind: 'chat',
      author: { name: 'ExampleMod', color: '#57aeff', roles: ['mod'], key: 'examplemod' },
      parts: [{ t: 'text', v: 'Test message from a moderator' }] },
    { ...base, id: id(), platform: 'youtube', channel: 'test', kind: 'super',
      author: { name: 'Example Supporter', color: null, roles: [], key: 'UCrich' },
      amount: '$5.00', colors: { header: '#ffb300', body: '#ffca28' },
      parts: [{ t: 'text', v: 'Test Super Chat — no money moved' }] },
    { ...base, id: id(), platform: 'twitch', channel: 'test', kind: 'system',
      author: { name: 'ExampleSub', roles: [], key: 'examplesub' },
      parts: [], system: 'Test: ExampleSub subscribed with Prime. 3 months in a row.' },
  ];
}

// ---------- http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveFile(res, file) {
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  if (sea) {
    try {
      const data = Buffer.from(sea.getRawAsset('public/' + file));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch (e) {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 65536) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (await sendApi.handle(req, res, u)) return;
    if (req.method === 'GET') {
      if (p === '/') return serveFile(res, 'panel.html');
      if (p === '/dock') return serveFile(res, 'dock.html');
      if (p === '/setup') return serveFile(res, 'setup.html');
      if (p === '/dock-logic.js') return serveFile(res, 'dock-logic.js');
      if (p === '/viewer-bar.js') return serveFile(res, 'viewer-bar.js');
      if (p === '/overlay-options.js') return serveFile(res, 'overlay-options.js');
      if (p === '/overlay') return serveFile(res, 'overlay.html');
      if (p === '/overlay.css') return serveFile(res, 'overlay.css');
      if (p === '/favicon.svg') return serveFile(res, 'favicon.svg');
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (p === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-store',
          'Connection': 'keep-alive',
        });
        res.write(':ok\n\n');
        res.write(sseFrame({ type: 'hello', history, sources: statusList(), viewers: viewerCounts.get() }));
        clients.add(res);
        if (clients.size === 1) viewerCounts.refresh().catch(() => {});   // first page in: don't wait for the next tick
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/state') return json(res, 200, { version: VERSION, host: config.host, port: actualPort, lan: lanOrigins(), sources: statusList(), viewers: viewerCounts.get() });
      if (p === '/api/fonts') {
        let files = [];
        try { files = fs.readdirSync(FONTS_DIR).filter(f => FONT_RE.test(f)).sort(); } catch (e) {}
        return json(res, 200, files);
      }
      if (p.startsWith('/fonts/')) {
        const name = decodeURIComponent(p.slice(7));
        if (!FONT_RE.test(name) || name.includes('..') || name.includes('/') || name.includes('\\')) {
          res.writeHead(404); return res.end('not found');
        }
        return fs.readFile(path.join(FONTS_DIR, name), (err, data) => {
          if (err) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
          res.end(data);
        });
      }
    }
    // The panel's controls change what the dock replies to (and clear the
    // streamer's view), so they sit behind the same gate as sending:
    // this machine, this server's own page, the session token.
    const panelWrite = (req.method === 'POST' && (p === '/api/sources' || p === '/api/test' || p === '/api/clear' || /^\/api\/sources\/[a-f0-9]+\/reconnect$/.test(p)))
      || (req.method === 'DELETE' && /^\/api\/sources\/[a-f0-9]+$/.test(p));
    if (panelWrite && !sendApi.guard(req, res)) return;
    if (req.method === 'POST' && p === '/api/sources') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const url = String(body.url || '').trim();
      if (!url) return json(res, 400, { error: 'Пустая ссылка' });
      const r = addSource(url);
      return json(res, r.error ? 400 : 200, r);
    }
    let m;
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/sources\/([a-f0-9]+)$/))) {
      return json(res, removeSource(m[1]) ? 200 : 404, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/sources\/([a-f0-9]+)\/reconnect$/))) {
      return json(res, reconnectSource(m[1]) ? 200 : 404, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/test') {
      for (const m of testMessages()) { pushHistory(m); broadcast(m); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/clear') {
      history = [];
      broadcast({ type: 'clear' });
      return json(res, 200, { ok: true });
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    logErr('http', e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else try { res.end(); } catch (e2) {}
  }
});

// ---------- запуск ----------
// Если желаемый порт занят (другая копия, чужое приложение) — берём
// следующий свободный и показываем фактические адреса.
let actualPort = config.port;

// Адреса, по которым сервер доступен с других устройств локальной сети.
function lanOrigins() {
  if (config.host && !['0.0.0.0', '::', ''].includes(config.host)) {
    return config.host === '127.0.0.1' || config.host === 'localhost'
      ? [] : [`http://${config.host}:${actualPort}`];
  }
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if ((it.family === 'IPv4' || it.family === 4) && !it.internal) {
        out.push(`http://${it.address}:${actualPort}`);
      }
    }
  }
  return out;
}

function printBanner() {
  console.log('megarohas_multichat запущен:');
  console.log(`  Панель управления: http://127.0.0.1:${actualPort}/`);
  console.log(`  Оверлей для OBS:   http://127.0.0.1:${actualPort}/overlay`);
  console.log(`  Reply dock:        http://127.0.0.1:${actualPort}/dock`);
  if (!sendLock.held) console.log('  ' + sendLock.reason);
  for (const o of lanOrigins()) {
    console.log(`  По локальной сети: ${o}/  (панель)  ·  ${o}/overlay`);
  }
}

function startSources() {
  for (const s of config.sources) {
    if (s && s.url) {
      const r = addSource(s.url, false);
      if (r.error) console.error(`Источник ${s.url}: ${r.error}`);
    }
  }
  replyTargets.restore(config.replyTo);
}

function listen(port, remaining) {
  // Each attempt owns its own pair of listeners. Upstream passed the callback
  // to server.listen(), which left the failed attempt's callback registered:
  // after a port fallback it fired too, with the old port — banner printed
  // twice, sources started twice, and for a moment the wrong port in
  // actualPort, which the send gate checks Host and Origin against.
  const onListening = () => {
    server.removeListener('error', onErr);
    actualPort = port;
    printBanner();
    startSources();
    viewerCounts.start();
  };
  const onErr = e => {
    server.removeListener('listening', onListening);
    if (e.code === 'EADDRINUSE' && remaining > 0) {
      console.log(`Порт ${port} занят — пробую ${port + 1}…`);
      listen(port + 1, remaining - 1);
    } else {
      logErr('listen', e);
      process.exit(1);
    }
  };
  server.once('error', onErr);
  server.once('listening', onListening);
  server.listen(port, config.host);
}

// ---------- оконный режим (--window) ----------
// Та же веб-админка, но отдельным окном приложения: используем режим
// --app у установленного Chromium-браузера (Edge есть на любой Windows,
// Chrome/Chromium — почти везде). Если ничего не нашли — обычный браузер.
function openAppWindow(url) {
  const args = [
    `--app=${url}`,
    `--user-data-dir=${path.join(APP_DIR, '.window-profile')}`,
    '--window-size=940,960',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const launch = exe => {
    const p = spawn(exe, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  };
  try {
    if (process.platform === 'win32') {
      const cands = [
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(process.env.ProgramFiles || '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      ];
      const exe = cands.find(c => { try { return fs.existsSync(c); } catch (e) { return false; } });
      if (exe) { launch(exe); console.log('  Окно админки: ' + path.basename(exe)); return; }
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      const cands = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ];
      const exe = cands.find(c => { try { return fs.existsSync(c); } catch (e) { return false; } });
      if (exe) { launch(exe); console.log('  Окно админки: ' + path.basename(exe)); return; }
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      for (const name of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']) {
        if (spawnSync('which', [name], { stdio: 'ignore' }).status === 0) {
          launch(name);
          console.log('  Окно админки: ' + name);
          return;
        }
      }
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    console.log('  Окно админки: Chromium не найден, открыл обычный браузер');
  } catch (e) {
    logErr('window', e);
  }
}

listen(config.port, 20);
if (process.argv.includes('--window')) {
  // окно открываем после того, как порт точно определился
  server.once('listening', () => setTimeout(() => openAppWindow(`http://127.0.0.1:${actualPort}/`), 300));
}
