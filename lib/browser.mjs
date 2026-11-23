// An isolated, stateless-as-to-the-user Chromium channel. No LaunchServices,
// native helper, shared profile, or listening debugging port is involved.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const BROWSER_ACTION_NAMES = Object.freeze([
  'browser_open', 'browser_status', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload',
  'browser_state', 'browser_screenshot', 'browser_observe', 'browser_click', 'browser_drag',
  'browser_type', 'browser_key', 'browser_scroll',
]);
const WIDTH = 1280;
const HEIGHT = 800;
const COMMAND_MS = 10_000;
const MAX_MESSAGE = 16 * 1024 * 1024;
const CHROME_APPS = ['Google Chrome for Testing', 'Google Chrome', 'Chromium'];
const cancelled = () => new Error('BROWSER_CLOSED: the isolated browser task has ended');
const bad = (message) => new Error('INVALID_ARGUMENT: ' + message);

async function chromeExecutable() {
  const configured = process.env.DSH_MAC_CUA_CHROME;
  if (configured && !path.isAbsolute(configured)) {
    throw new Error('BROWSER_UNAVAILABLE: DSH_MAC_CUA_CHROME must be an absolute executable path');
  }
  const candidates = configured ? [configured] : ['/Applications', path.join(os.homedir(), 'Applications')]
    .flatMap((dir) => CHROME_APPS.map((name) => path.join(dir, name + '.app', 'Contents', 'MacOS', name)));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next candidate */ }
  }
  throw new Error('BROWSER_UNAVAILABLE: install Chrome or Chromium, or set DSH_MAC_CUA_CHROME to its absolute executable path');
}

function navigationUrl(input, allowLoopback) {
  if (typeof input !== 'string' || input.length > 8192) throw bad('url must be an http(s) URL');
  let url;
  try { url = new URL(input); } catch { throw bad('url must be an absolute http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw bad('url must use http(s) without embedded credentials');
  }
  const host = url.hostname.replace(/\.+$/, '').toLowerCase();
  if (allowLoopback && host === '127.0.0.1') return url.href;
  const version = isIP(host.replace(/^\[|\]$/g, ''));
  const [a, b] = version === 4 ? host.split('.').map(Number) : [];
  const notPublic = version === 6 || (version === 4 && (
    a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  ));
  if (notPublic || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw bad('url must be an external http(s) destination, not a local hostname or private address');
  }
  return url.href;
}

// Apply the same address policy to every HTTP(S) request, not only explicit
// browser_open/browser_navigate calls. This also covers redirects, clicked
// links, frames and page-initiated subresources that use literal private IPs.
// Hostname-to-IP enforcement still belongs at the network/sandbox layer.
function networkRequestAllowed(input, allowLoopback) {
  let url;
  try { url = new URL(input); } catch { return false; }
  if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    try { navigationUrl(url.href, allowLoopback); return true; } catch { return false; }
  }
  return url.protocol === 'about:' || url.protocol === 'data:' || url.protocol === 'blob:';
}

// Chromium expects NUL-terminated JSON on child descriptors 3 (read) and 4
// (write). Electron / Node use private inherited pipes rather than a TCP port.
class Pipe extends EventEmitter {
  #input;
  #output;
  #buffer = Buffer.alloc(0);
  #id = 0;
  #pending = new Map();
  #failure;

  constructor(child) {
    super();
    this.#input = child.stdio[3];
    this.#output = child.stdio[4];
    const gone = () => this.end(new Error('BROWSER_DISCONNECTED: isolated Chromium closed its control pipe'));
    this.#input.on('error', gone);
    this.#output.on('error', gone);
    this.#output.once('end', gone);
    this.#output.on('data', (chunk) => this.#receive(chunk));
    child.once('error', gone);
    child.once('exit', gone);
  }

  #receive(chunk) {
    if (this.#failure) return;
    const bytes = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(0, offset);
      if ((end === -1 ? bytes.length : end) - offset > MAX_MESSAGE) {
        this.end(new Error('BROWSER_PROTOCOL: isolated Chromium returned an oversized message'));
        return;
      }
      if (end === -1) break;
      let msg;
      try { msg = JSON.parse(bytes.toString('utf8', offset, end)); }
      catch {
        this.end(new Error('BROWSER_PROTOCOL: isolated Chromium returned malformed JSON'));
        return;
      }
      offset = end + 1;
      if (msg.id !== undefined) {
        const waiter = this.#pending.get(msg.id);
        if (!waiter || waiter.sessionId !== msg.sessionId) continue;
        this.#pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.error) waiter.reject(new Error('BROWSER_CDP: ' + waiter.method + ': ' + msg.error.message));
        else waiter.resolve(msg.result ?? {});
      } else if (msg.method) this.emit('event', msg);
    }
    this.#buffer = bytes.subarray(offset);
  }

  request(method, params = {}, sessionId, timeoutMs = COMMAND_MS) {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const cancel = (error) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => cancel(new Error('BROWSER_TIMEOUT: ' + method + ' did not return')), timeoutMs);
      this.#pending.set(id, { sessionId, method, resolve, reject, timer });
      this.#input.write(JSON.stringify({ id, method, params, sessionId }) + '\0', (error) => {
        if (error) cancel(new Error('BROWSER_DISCONNECTED: isolated Chromium stopped accepting commands'));
      });
    });
  }

  end(error) {
    if (this.#failure) return;
    this.#failure = error;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
    this.emit('end', error);
  }
}

function waitUntil(promise, ms) {
  let timer;
  return Promise.race([promise.then(() => true), new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  })]).finally(() => clearTimeout(timer));
}

function killGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

const ownedGroups = new Set();
function exitCleanup() {
  for (const pid of ownedGroups) {
    try { killGroup(pid, 'SIGKILL'); } catch { /* best effort at host exit */ }
  }
}
function ownGroup(pid) {
  if (!pid) return;
  if (!ownedGroups.size) process.once('exit', exitCleanup);
  ownedGroups.add(pid);
}
function forgetGroup(pid) {
  ownedGroups.delete(pid);
  if (!ownedGroups.size) process.removeListener('exit', exitCleanup);
}

function boundedText(value, limit = 180) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : '';
}

const MODIFIERS = new Map([['alt', 1], ['option', 1], ['ctrl', 2], ['control', 2],
  ['meta', 4], ['command', 4], ['shift', 8]]);
function modifierMask(modifiers) {
  if (modifiers === undefined) return 0;
  if (!Array.isArray(modifiers) || modifiers.length > 4) throw bad('modifiers must be a list of up to four keys');
  return modifiers.reduce((mask, modifier) => {
    const bit = MODIFIERS.get(typeof modifier === 'string' ? modifier.toLowerCase() : '');
    if (!bit) throw bad('unsupported keyboard modifier');
    return mask | bit;
  }, 0);
}
const NAMED_KEYS = new Map(Object.entries({
  Enter: ['Enter', 13, '\r'], Return: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27],
  Esc: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46], Home: ['Home', 36],
  End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ArrowLeft: ['ArrowLeft', 37],
  ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  ' ': ['Space', 32, ' '], Space: ['Space', 32, ' '],
}));
const SYMBOL_KEYS = new Map(Object.entries({
  '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
  '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188],
  '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192],
}));
const SHIFTED_KEYS = new Map(Array.from('!@#$%^&*()_+{}|:"<>?~', (char, index) =>
  [char, '1234567890-=[]\\;\',./`'[index]]));

function keyParams(key, modifiers) {
  if (typeof key !== 'string') throw bad('key must be a DOM key name or printable ASCII character');
  const named = NAMED_KEYS.get(key);
  let params;
  let text;
  if (named) {
    const [code, windowsVirtualKeyCode, printable] = named;
    text = printable;
    params = { key: code === 'Space' ? ' ' : code, code, windowsVirtualKeyCode };
  } else if (/^[!-~]$/.test(key)) {
    const base = SHIFTED_KEYS.get(key) ?? key.toLowerCase();
    const upper = base.toUpperCase();
    const [code, windowsVirtualKeyCode] = /^[0-9]$/.test(base) ? ['Digit' + base, base.charCodeAt(0)] :
      /^[a-z]$/.test(base) ? ['Key' + upper, upper.charCodeAt(0)] : SYMBOL_KEYS.get(base);
    text = /^[a-z]$/.test(base) && (modifiers & 8) ? upper : key;
    params = { key: text, code, windowsVirtualKeyCode };
  } else throw bad('unsupported key; use browser_type for literal Unicode text');
  return { params: { ...params, modifiers }, text: modifiers & 7 ? undefined : text };
}

function axTree(nodes, max) {
  const ids = new Map(nodes.map((node) => [node.nodeId, node]));
  const visited = new Set();
  const entries = new Map();
  const lines = [];
  const children = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const queue = nodes.filter((node) => !children.has(node.nodeId)).reverse().map((node) => [node, 0]);
  while (queue.length && lines.length < max) {
    const [node, indent] = queue.pop();
    if (!node || visited.has(node.nodeId)) continue;
    visited.add(node.nodeId);
    const shownIndent = node.ignored ? indent : indent + 1;
    for (const id of [...(node.childIds ?? [])].reverse()) queue.push([ids.get(id), shownIndent]);
    if (node.ignored) continue;
    const role = boundedText(node.role?.value, 80) || 'unknown';
    const name = boundedText(node.name?.value);
    const backendNodeId = node.backendDOMNodeId;
    const flags = (node.properties ?? []).filter(({ name, value }) =>
      ['disabled', 'focused', 'checked', 'expanded', 'selected'].includes(name) && value?.value !== undefined
    ).map(({ name, value }) => name + '=' + JSON.stringify(value.value));
    const disabled = (node.properties ?? []).some(({ name, value }) => name === 'disabled' && value?.value === true);
    const n = String(lines.length + 1);
    const clickable = Number.isSafeInteger(backendNodeId) && !disabled && role !== 'RootWebArea';
    if (clickable) entries.set(n, backendNodeId);
    lines.push('  '.repeat(Math.min(indent, 16)) + (clickable ? '[' + n + '] ' : '') + role +
      (name ? ' ' + JSON.stringify(name) : '') + (flags.length ? ' (' + flags.join(', ') + ')' : ''));
  }
  return { tree: lines.join('\n'), entries, truncated: queue.length > 0 };
}

function pointInQuad(quad, width, height) {
  if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) return null;
  let polygon = Array.from({ length: 4 }, (_, i) => [quad[i * 2], quad[i * 2 + 1]]);
  // Clip each edge to the screenshot viewport, including visible slivers of
  // partly offscreen controls rather than clicking their unbounded center.
  for (const [axis, bound, sense] of [[0, 0, 1], [1, 0, 1], [0, width - 1, -1], [1, height - 1, -1]]) {
    const next = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const from = sense * (a[axis] - bound) >= 0;
      const to = sense * (b[axis] - bound) >= 0;
      if (from) next.push(a);
      if (from !== to) {
        const ratio = (bound - a[axis]) / (b[axis] - a[axis]);
        next.push([a[0] + ratio * (b[0] - a[0]), a[1] + ratio * (b[1] - a[1])]);
      }
    }
    polygon = next;
  }
  if (!polygon.length) return null;
  return Object.fromEntries(['x', 'y'].map((key, axis) => [key,
    Math.round(polygon.reduce((total, point) => total + point[axis], 0) / polygon.length)]));
}

function pixelPoint(args, snapshot) {
  const { x, y } = args;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= snapshot.pixelWidth || y >= snapshot.pixelHeight) {
    throw bad('x and y must be integer pixels inside the latest browser screenshot');
  }
  return { x, y };
}

export class BackgroundBrowser {
  #signal;
  #abort;
  #onFrame;
  #intervalMs;
  #allowLoopback;
  #closed = false;
  #ready = false;
  #starting;
  #closing;
  #tail = Promise.resolve();
  #root;
  #child;
  #exited;
  #cdp;
  #sessionId;
  #targetId;
  #frameId;
  #title = '';
  #url = '';
  #document = 0;
  #snapshot;
  #loaded = new Set();
  #interval;
  #previewing = false;
  #shots = [];

  constructor({ signal, onFrame, fps = 4, allowLoopback = false } = {}) {
    this.#signal = signal;
    this.#onFrame = typeof onFrame === 'function' ? onFrame : undefined;
    this.#intervalMs = Math.round(1000 / (Number.isFinite(fps) ? Math.max(1, Math.min(10, fps)) : 4));
    this.#allowLoopback = allowLoopback === true;
    this.#abort = () => { void this.close().catch(() => {}); };
    if (signal?.aborted) this.#abort();
    else signal?.addEventListener('abort', this.#abort, { once: true });
  }

  run(action, args = {}, { signal } = {}) {
    if (!BROWSER_ACTION_NAMES.includes(action)) return Promise.reject(bad('unknown browser action'));
    // Input already submitted to Chromium cannot be recalled. Treat a call abort
    // as terminal for this task so no subsequent queued input can be dispatched.
    if (signal?.aborted) {
      this.#abort();
      return Promise.reject(cancelled());
    }
    if (action === 'browser_status') return Promise.resolve(this.#status());
    const job = this.#tail.then(() => this.#run(action, args));
    this.#tail = job.catch(() => {});
    if (!signal) return job;
    const abort = () => this.#abort();
    signal.addEventListener('abort', abort, { once: true });
    return job.finally(() => signal.removeEventListener('abort', abort));
  }

  #status() {
    return { state: this.#closed ? 'closed' : this.#ready ? 'ready' : this.#starting ? 'starting' : 'idle', url: this.#url, title: this.#title };
  }

  #guard() {
    if (this.#closed || this.#signal?.aborted) throw cancelled();
  }

  async #page(method, params, timeoutMs) {
    this.#guard();
    const result = await this.#cdp.request(method, params, this.#sessionId, timeoutMs);
    this.#guard();
    return result;
  }

  #event(event) {
    if (this.#closed) return;
    const { method, params, sessionId } = event;
    if ((method === 'Target.detachedFromTarget' && params.sessionId === this.#sessionId) ||
        (method === 'Target.targetDestroyed' && params.targetId === this.#targetId) ||
        (method === 'Inspector.targetCrashed' && sessionId === this.#sessionId)) {
      void this.close().catch(() => {});
      return;
    }
    if (sessionId !== this.#sessionId) return;
    if (method === 'Fetch.requestPaused') {
      void this.#handleRequest(params);
      return;
    }
    if (method === 'Page.frameNavigated' && !params.frame?.parentId && params.frame?.id) {
      this.#frameId = params.frame.id;
      this.#url = params.frame.url;
      this.#title = '';
      this.#invalidate();
    } else if (method === 'Page.navigatedWithinDocument' && params.frameId === this.#frameId) {
      this.#url = params.url;
      this.#invalidate();
    } else if (method === 'Page.lifecycleEvent' && params.frameId === this.#frameId &&
        (params.name === 'DOMContentLoaded' || params.name === 'load') && params.loaderId) {
      this.#loaded.add(params.loaderId);
      if (this.#loaded.size > 16) this.#loaded.delete(this.#loaded.values().next().value);
    }
  }

  async #handleRequest(params) {
    const requestId = params?.requestId;
    if (!requestId || this.#closed) return;
    try {
      if (networkRequestAllowed(params.request?.url, this.#allowLoopback)) {
        await this.#page('Fetch.continueRequest', { requestId });
      } else {
        await this.#page('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
    } catch { /* closing the task also ends paused requests */ }
  }

  #invalidate() {
    this.#document++;
    this.#snapshot = undefined;
  }

  async #launch() {
    const executable = await chromeExecutable();
    this.#guard();
    this.#root = await mkdtemp(path.join(os.tmpdir(), 'dsh-mac-cua-chrome-'));
    this.#guard();
    const args = [
      '--headless', '--remote-debugging-pipe', '--user-data-dir=' + path.join(this.#root, 'profile'),
      '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update', '--disable-notifications',
      '--disable-breakpad', '--disable-crash-reporter', '--use-mock-keychain',
      '--window-size=' + WIDTH + ',' + HEIGHT, '--force-device-scale-factor=1', 'about:blank',
    ];
    const child = spawn(executable, args, { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    this.#child = child;
    ownGroup(child.pid);
    this.#exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
    this.#cdp = new Pipe(child);
    this.#cdp.on('event', (event) => this.#event(event));
    this.#cdp.once('end', () => { if (this.#ready && !this.#closed) void this.close().catch(() => {}); });
    await this.#cdp.request('Browser.getVersion');
    this.#guard();
    const { targetInfos } = await this.#cdp.request('Target.getTargets');
    this.#guard();
    this.#targetId = targetInfos?.find((info) => info.type === 'page' && info.url === 'about:blank')?.targetId;
    if (!this.#targetId) throw new Error('BROWSER_UNAVAILABLE: isolated Chromium did not start its blank tab');
    ({ sessionId: this.#sessionId } = await this.#cdp.request('Target.attachToTarget', { targetId: this.#targetId, flatten: true }));
    this.#guard();
    await this.#cdp.request('Browser.setDownloadBehavior', { behavior: 'deny' });
    await this.#page('Page.enable');
    await this.#page('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await this.#page('Page.setLifecycleEventsEnabled', { enabled: true });
    const { frameTree } = await this.#page('Page.getFrameTree');
    this.#frameId = frameTree.frame.id;
    this.#url = frameTree.frame.url;
    await this.#page('DOM.enable');
    await this.#page('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false, screenWidth: WIDTH, screenHeight: HEIGHT,
    });
    this.#ready = true;
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#signal?.removeEventListener('abort', this.#abort);
    clearInterval(this.#interval);
    this.#snapshot = undefined;
    const cdp = this.#cdp;
    // Give Chrome its own clean shutdown command, then abandon pending protocol
    // commands immediately so cancellation is observable before process reaping.
    if (cdp) {
      void cdp.request('Browser.close').catch(() => {});
      cdp.end(cancelled());
    }
    this.#closing = (async () => {
      await this.#starting?.catch(() => {});
      const pid = this.#child?.pid;
      try {
        if (pid) {
          if (!await waitUntil(this.#exited, 350)) {
            killGroup(pid, 'SIGTERM');
            if (!await waitUntil(this.#exited, 350)) {
              killGroup(pid, 'SIGKILL');
              if (!await waitUntil(this.#exited, 1500)) {
                throw new Error('BROWSER_CLEANUP: isolated Chromium exit could not be confirmed');
              }
            }
          }
          // Include renderer or GPU descendants even if the leader exited first.
          killGroup(pid, 'SIGKILL');
          forgetGroup(pid);
        }
        if (this.#root) await rm(this.#root, { recursive: true, force: true, maxRetries: 3 });
      } finally {
        this.#child?.stdio[3].destroy();
        this.#child?.stdio[4].destroy();
      }
    })();
    return this.#closing;
  }

  async #metadata() {
    this.#guard();
    const { targetInfo } = await this.#cdp.request('Target.getTargetInfo', { targetId: this.#targetId });
    this.#guard();
    if (typeof targetInfo?.title === 'string') this.#title = boundedText(targetInfo.title);
    return { title: this.#title, url: this.#url };
  }

  async #waitForDocument(loaderId) {
    if (this.#loaded.has(loaderId)) return true;
    return new Promise((resolve, reject) => {
      const ended = (error) => { cleanup(); reject(error); };
      const onEvent = () => {
        if (this.#loaded.has(loaderId)) { cleanup(); resolve(true); }
      };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, 6000);
      const cleanup = () => {
        clearTimeout(timer);
        this.#cdp.off('event', onEvent);
        this.#cdp.off('end', ended);
      };
      this.#cdp.on('event', onEvent);
      this.#cdp.on('end', ended);
    });
  }

  async #navigate(url) {
    this.#invalidate();
    const result = await this.#page('Page.navigate', { url });
    if (result.errorText || result.isDownload) {
      throw new Error('BROWSER_NAVIGATION: ' + (result.isDownload ? 'downloads are disabled' : result.errorText));
    }
    const documentReady = result.loaderId ? await this.#waitForDocument(result.loaderId) : true;
    return { ...await this.#metadata(), documentReady };
  }

  async #capture(timeoutMs) {
    const document = this.#document;
    const { data } = await this.#page('Page.captureScreenshot', { format: 'png', fromSurface: true }, timeoutMs);
    const png = Buffer.from(data, 'base64');
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('BROWSER_PROTOCOL: isolated Chromium did not return a PNG');
    }
    const { url, title } = await this.#metadata();
    if (document !== this.#document) throw new Error('BROWSER_STALE: page navigated during capture; take a fresh observation');
    return { png, title, url, pixelWidth: png.readUInt32BE(16), pixelHeight: png.readUInt32BE(20) };
  }

  async #preview() {
    if (this.#previewing || !this.#onFrame || this.#closed) return;
    this.#previewing = true;
    try {
      // A capture straddling document navigation may never return. Drop it
      // promptly rather than starving the stream; explicit screenshots keep
      // the regular command timeout and are never blindly retried.
      const frame = await this.#capture(1500);
      if (!this.#closed) await this.#onFrame(frame);
    } catch { /* a dropped preview must not affect automation */ }
    finally { this.#previewing = false; }
  }

  #newSnapshot(fields) {
    const snapshotId = randomUUID();
    this.#snapshot = { ...fields, snapshotId, document: this.#document };
    return snapshotId;
  }

  #checkSnapshot(args, kind, expected) {
    this.#guard();
    const snapshot = this.#snapshot;
    if (!snapshot || (snapshot.kind !== kind && snapshot.kind !== 'both') || snapshot.document !== this.#document ||
        args.snapshotId !== snapshot.snapshotId || (expected && expected !== snapshot)) {
      throw new Error('BROWSER_STALE: ' + (kind === 'screen' ? 'take a fresh browser_screenshot' : 'read fresh browser_state') + ' before acting');
    }
    return snapshot;
  }

  async #observedClickPoint(args, snapshot) {
    const key = typeof args.elementId === 'string' ? args.elementId.replace(/^\[(\d+)\]$/, '$1') : String(args.elementId);
    const backendNodeId = snapshot.entries.get(key);
    if (!backendNodeId) throw bad('elementId must be a clickable ID from the current browser_state');
    await this.#page('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const { quads } = await this.#page('DOM.getContentQuads', { backendNodeId });
    let point = (quads ?? []).map((quad) => pointInQuad(quad, WIDTH, HEIGHT)).find(Boolean);
    if (!point) throw new Error('BROWSER_NOT_VISIBLE: element is not in the current viewport');
    this.#checkSnapshot(args, 'ax', snapshot);
    let hit;
    let miss;
    // Recent Chrome builds can intermittently report no node for the exact
    // rounded center of a valid quad. Retry only adjacent pixels; a real hit is
    // still subjected to the same target/descendant check below.
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const candidate = { x: point.x + dx, y: point.y + dy };
      if (candidate.x < 0 || candidate.y < 0 || candidate.x >= WIDTH || candidate.y >= HEIGHT) continue;
      try {
        hit = await this.#page('DOM.getNodeForLocation', candidate);
        point = candidate;
        break;
      } catch (error) {
        if (!String(error?.message).startsWith('BROWSER_CDP: DOM.getNodeForLocation:')) throw error;
        miss = error;
      }
    }
    if (!hit) throw new Error('BROWSER_ELEMENT_OBSCURED: no clickable element was found at the observed point; observe again', { cause: miss });
    if (hit.backendNodeId !== backendNodeId) {
      // A label or span inside a button is a valid hit; an unrelated overlay is
      // not. Use a fresh isolated world, never execute code supplied by the model
      // or a webpage, and let moved, unrelated, or inaccessible hits fail closed.
      const objectGroup = 'dsh-hit-' + randomUUID();
      let within = false;
      try {
        const { executionContextId } = await this.#page('Page.createIsolatedWorld', {
          frameId: this.#frameId, worldName: 'dsh-mac-cua-hit-test',
        });
        const { object: target } = await this.#page('DOM.resolveNode', { backendNodeId, executionContextId, objectGroup });
        const { object: found } = await this.#page('DOM.resolveNode', { backendNodeId: hit.backendNodeId, executionContextId, objectGroup });
        const result = await this.#page('Runtime.callFunctionOn', {
          objectId: target.objectId, arguments: [{ objectId: found.objectId }], returnByValue: true,
          functionDeclaration: 'function (hit) { return Node.prototype.contains.call(this, hit); }',
        });
        within = result.result?.value === true;
      } catch { /* unknown / different frame is not a verified hit */ }
      finally { await this.#page('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {}); }
      this.#checkSnapshot(args, 'ax', snapshot);
      if (!within) throw new Error('BROWSER_ELEMENT_OBSCURED: another element is at the click point; observe again');
    }
    return point;
  }

  async #run(action, args) {
    this.#guard();
    let url;
    if (action === 'browser_navigate' || (action === 'browser_open' && args.url !== undefined)) {
      url = navigationUrl(args.url, this.#allowLoopback);
    }
    if (action === 'browser_open') {
      if (!this.#ready) {
        this.#starting ??= this.#launch();
        try { await this.#starting; } catch (error) { await this.close().catch(() => {}); throw error; }
      }
      const navigation = url ? await this.#navigate(url) : {};
      if (this.#onFrame && !this.#interval) {
        // Capturing about:blank while the initial navigation replaces its surface
        // can leave the capture pending after the real page is already ready.
        this.#interval = setInterval(() => void this.#preview(), this.#intervalMs);
        this.#interval.unref();
        void this.#preview();
      }
      return { ...this.#status(), ...navigation, instance: 'isolated-headless' };
    }
    if (!this.#ready) throw new Error('BROWSER_NOT_STARTED: call browser_open for this task');
    if (action === 'browser_navigate') return this.#navigate(url);
    if (action === 'browser_back' || action === 'browser_forward') {
      const { currentIndex, entries = [] } = await this.#page('Page.getNavigationHistory');
      const offset = action === 'browser_back' ? -1 : 1;
      const entry = entries[currentIndex + offset];
      if (!entry) throw new Error('BROWSER_HISTORY: there is no page in that direction');
      this.#invalidate();
      await this.#page('Page.navigateToHistoryEntry', { entryId: entry.id });
      return { dispatched: true, direction: offset < 0 ? 'back' : 'forward' };
    }
    if (action === 'browser_reload') {
      this.#invalidate();
      await this.#page('Page.reload', { ignoreCache: false });
      return { dispatched: true };
    }
    if (action === 'browser_state') {
      const max = args.maxElements ?? 400;
      if (!Number.isInteger(max) || max < 1 || max > 1500) throw bad('maxElements must be an integer from 1 to 1500');
      const document = this.#document;
      const { nodes } = await this.#page('Accessibility.getFullAXTree', { depth: 14 });
      const { entries, ...result } = axTree(nodes ?? [], max);
      const metadata = await this.#metadata();
      if (document !== this.#document) throw new Error('BROWSER_STALE: page navigated during observation; read fresh browser_state');
      return { ...metadata, ...result, snapshotId: this.#newSnapshot({ kind: 'ax', entries }) };
    }
    if (action === 'browser_screenshot') {
      const document = this.#document;
      const { png, ...metadata } = await this.#capture();
      const file = path.join(this.#root, 'shot-' + randomUUID() + '.png');
      await writeFile(file, png, { mode: 0o600, flag: 'wx' });
      this.#shots.push(file);
      if (this.#shots.length > 8) await rm(this.#shots.shift(), { force: true });
      this.#guard();
      if (document !== this.#document) throw new Error('BROWSER_STALE: page navigated during screenshot; take a fresh observation');
      const snapshotId = this.#newSnapshot({ kind: 'screen', pixelWidth: metadata.pixelWidth, pixelHeight: metadata.pixelHeight });
      return { ...metadata, path: file, snapshotId };
    }
    if (action === 'browser_observe') {
      const max = args.maxElements ?? 400;
      if (!Number.isInteger(max) || max < 1 || max > 1500) throw bad('maxElements must be an integer from 1 to 1500');
      const document = this.#document;
      const { nodes } = await this.#page('Accessibility.getFullAXTree', { depth: 14 });
      const { entries, ...state } = axTree(nodes ?? [], max);
      const { png, ...metadata } = await this.#capture();
      const file = path.join(this.#root, 'shot-' + randomUUID() + '.png');
      await writeFile(file, png, { mode: 0o600, flag: 'wx' });
      this.#shots.push(file);
      if (this.#shots.length > 8) await rm(this.#shots.shift(), { force: true });
      this.#guard();
      if (document !== this.#document) throw new Error('BROWSER_STALE: page navigated during observation; observe again');
      const snapshotId = this.#newSnapshot({
        kind: 'both', entries, pixelWidth: metadata.pixelWidth, pixelHeight: metadata.pixelHeight,
      });
      return { ...metadata, ...state, path: file, snapshotId };
    }
    if (action === 'browser_type') {
      if (typeof args.text !== 'string' || !args.text || args.text.length > 16000) throw bad('text must contain 1 to 16000 characters');
      this.#snapshot = undefined;
      await this.#page('Input.insertText', { text: args.text });
      return { dispatched: true };
    }
    if (action === 'browser_key') {
      const { params, text } = keyParams(args.key, modifierMask(args.modifiers));
      this.#snapshot = undefined;
      await this.#page('Input.dispatchKeyEvent', { ...params, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text });
      await this.#page('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
      return { dispatched: true };
    }
    if (action === 'browser_click') {
      const kind = args.elementId !== undefined ? 'ax' : 'screen';
      if (kind === 'ax' && (args.x !== undefined || args.y !== undefined)) throw bad('choose elementId or x/y, not both');
      const count = args.clickCount ?? 1;
      if (![1, 2].includes(count)) throw bad('clickCount must be 1 or 2');
      const snapshot = this.#checkSnapshot(args, kind);
      const cursor = kind === 'ax' ? await this.#observedClickPoint(args, snapshot) : pixelPoint(args, snapshot);
      this.#checkSnapshot(args, kind, snapshot);
      this.#snapshot = undefined;
      const modifiers = modifierMask(args.modifiers);
      const button = args.mouseButton ?? 'left';
      if (!['left', 'right', 'middle'].includes(button)) throw bad('mouseButton must be left, right or middle');
      for (let i = 1; i <= count; i++) {
        const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
        await this.#page('Input.dispatchMouseEvent', { ...cursor, modifiers, type: 'mousePressed', button, buttons, clickCount: i });
        await this.#page('Input.dispatchMouseEvent', { ...cursor, modifiers, type: 'mouseReleased', button, buttons: 0, clickCount: i });
        if (snapshot.document !== this.#document) break;
      }
      return { dispatched: true, cursor, pixelWidth: snapshot.pixelWidth ?? WIDTH, pixelHeight: snapshot.pixelHeight ?? HEIGHT };
    }
    if (action === 'browser_drag') {
      const snapshot = this.#checkSnapshot(args, 'screen');
      const from = pixelPoint({ x: args.fromX, y: args.fromY }, snapshot);
      const to = pixelPoint({ x: args.toX, y: args.toY }, snapshot);
      const steps = args.steps ?? 20;
      if (!Number.isInteger(steps) || steps < 1 || steps > 240) throw bad('steps must be an integer from 1 to 240');
      const modifiers = modifierMask(args.modifiers);
      const button = args.mouseButton ?? 'left';
      if (!['left', 'right', 'middle'].includes(button)) throw bad('mouseButton must be left, right or middle');
      const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
      this.#snapshot = undefined;
      await this.#page('Input.dispatchMouseEvent', { ...from, modifiers, type: 'mouseMoved', button: 'none', buttons: 0 });
      await this.#page('Input.dispatchMouseEvent', { ...from, modifiers, type: 'mousePressed', button, buttons, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const ratio = i / steps;
        await this.#page('Input.dispatchMouseEvent', {
          x: Math.round(from.x + (to.x - from.x) * ratio), y: Math.round(from.y + (to.y - from.y) * ratio),
          modifiers, type: 'mouseMoved', button, buttons
        });
      }
      await this.#page('Input.dispatchMouseEvent', { ...to, modifiers, type: 'mouseReleased', button, buttons: 0, clickCount: 1 });
      return { dispatched: true, cursor: to, pixelWidth: snapshot.pixelWidth, pixelHeight: snapshot.pixelHeight };
    }
    const snapshot = this.#checkSnapshot(args, 'screen');
    const cursor = pixelPoint(args, snapshot);
    const { deltaX = 0, deltaY = 0 } = args;
    if (![deltaX, deltaY].every((n) => Number.isFinite(n) && Math.abs(n) <= 5000) || (!deltaX && !deltaY)) {
      throw bad('deltaX/deltaY must be finite CSS pixels in [-5000, 5000], at least one nonzero');
    }
    const modifiers = modifierMask(args.modifiers);
    this.#snapshot = undefined;
    await this.#page('Input.dispatchMouseEvent', { ...cursor, modifiers, type: 'mouseWheel', deltaX, deltaY });
    return { dispatched: true, cursor, pixelWidth: snapshot.pixelWidth, pixelHeight: snapshot.pixelHeight };
  }
}
