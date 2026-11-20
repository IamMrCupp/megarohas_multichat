'use strict';
// Shared test plumbing. Everything listens on 127.0.0.1 with an OS-assigned
// port; nothing in the test suite talks to the real internet.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { createSendApi } = require('../lib/sendapi');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => { server.closeAllConnections && server.closeAllConnections(); server.close(() => resolve()); });
}

// Raw request: lets a test set Host and Origin to anything, which fetch won't.
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(payload !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// A send API on its own little server, the way server.js mounts it.
// Reply targets in the shape lib/targets.js hands to the send API.
const TARGETS = {
  twitch: { pinned: true, sourceId: 'aaaa1111', channel: 'examplechannel', label: '#examplechannel', key: 'aaaa1111:examplechannel', choices: [{ id: 'aaaa1111', label: '#examplechannel' }] },
  youtube: { pinned: true, sourceId: 'bbbb2222', videoId: 'FAKEvideo01', channel: 'Example Channel', label: 'Example Channel · video FAKEvideo01', key: 'bbbb2222:FAKEvideo01', choices: [{ id: 'bbbb2222', label: 'Example Channel' }] },
};

async function startApp({ senders = {}, targets, remoteAddress, setTarget, ...more } = {}) {
  let port = 0;
  const current = () => (typeof targets === 'function' ? targets() : (targets || TARGETS));
  const api = createSendApi({
    getPort: () => port,
    getTargets: current,
    setTarget,
    senders,
    remoteAddress,
    ...more,
  });
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (await api.handle(req, res, u)) return;
    res.writeHead(404); res.end('not found');
  });
  port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  return {
    port, origin, token: api.token, api,
    close: () => close(server),
    // a well-formed request from the dock page
    // For /api/send it fills in `expect` the way the dock does: the target
    // keys currently on show. Pass expect yourself to test a stale page.
    post: (path, body, headers = {}) => {
      if (path === '/api/send' && body && typeof body === 'object' && body.expect === undefined) {
        const t = current();
        const expect = {};
        for (const p of ['twitch', 'youtube']) if (t[p] && t[p].pinned) expect[p] = t[p].key;
        body = { ...body, expect };
      }
      return request(port, { method: 'POST', path, body, headers: { origin, 'x-dock-token': api.token, ...headers } });
    },
    get: (path, headers = {}) => request(port, { path, headers: { 'x-dock-token': api.token, ...headers } }),
  };
}

// The fake sender the dock is tested against: records what it was asked to
// send and answers however the test tells it to.
function fakeSender({ signedIn = true, as = 'example_user', reply, maxLength } = {}) {
  const sent = [];
  return {
    sent,
    ...(maxLength ? { maxLength } : {}),
    signedIn,
    status() { return { configured: true, signedIn: this.signedIn, as: this.signedIn ? as : null, detail: '' }; },
    async send(text, target) {
      sent.push({ text, target });
      if (typeof reply === 'function') return reply(text, target);
      return reply || { ok: true, id: 'fake-' + sent.length };
    },
  };
}

// A fake upstream (Twitch or Google): routes is { 'METHOD /path': (req, body, url) => [status, json, headers?] }.
async function fakeUpstream(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', c => { data += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const key = `${req.method} ${u.pathname}`;
      let body = data;
      const ct = req.headers['content-type'] || '';
      if (ct.includes('json')) { try { body = JSON.parse(data); } catch (e) {} }
      else if (ct.includes('x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(data));
      const call = { key, method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body };
      calls.push(call);
      const h = routes[key];
      if (!h) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"status":404,"message":"no such fake route"}'); }
      const [status, json, headers] = h(call);
      res.writeHead(status, { 'content-type': 'application/json', ...(headers || {}) });
      res.end(json === undefined ? '' : JSON.stringify(json));
    });
  });
  const port = await listen(server);
  return { port, base: `http://127.0.0.1:${port}`, calls, routes, close: () => close(server), count: key => calls.filter(c => c.key === key).length };
}

// The real server.js in a throwaway directory. No sources are configured, so
// it opens no outbound connection.
function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(t, extraConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multichat-test-'));
  const want = await freePort();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: want, sources: [], ...extraConfig }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, MULTICHAT_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    const onData = c => {
      out += c;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/dock/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server exited ' + code + ': ' + out)); });
  });
  t.after(() => new Promise(resolve => {
    child.removeAllListeners('exit');
    child.on('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); });
    child.kill();
  }));
  return { port, dir, origin: `http://127.0.0.1:${port}`, output: () => out };
}

module.exports = { TARGETS, startServer, listen, close, request, startApp, fakeSender, fakeUpstream };
