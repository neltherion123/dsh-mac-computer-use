// Native bridge: talks to the signed "DSH Computer Use" helper over its unix socket.
//
// The helper is the only process holding the macOS Accessibility / Screen Recording
// TCC grants, so this module never touches AX itself: it connects to the helper's
// shared daemon (launching it on demand), performs the one-message handshake and
// then speaks newline-delimited JSON-RPC. Zero dependencies on purpose -- the plugin
// has to load inside the DSH host without resolving any @deepseek-ai package.
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROTOCOL = 1;

/** Config the helper enforces for this connection; mirrors the shipped defaults. */
export const NATIVE_CONFIG = Object.freeze({
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  axTimeoutMs: 3000,
  textEventIntervalMs: 0.25,
  maxClickHoldMs: 5000,
  screenshotTimeoutMs: 5000,
  timeoutMs: 30000,
  graceMs: 3000
});

const CONNECT_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 15000;
const HANDSHAKE_BYTES = 8192;

const HELPER_APP = 'DSH Computer Use.app';
const HELPER_BIN = 'dsh-cua-native';
const HELPER_REQUIREMENT = 'identifier "com.deepseek.harness.computer-use" and anchor apple generic and certificate leaf[subject.OU] = "NAN929V4UM"';

/** Candidate helper executables, newest runtime directory first. */
function findHelpers() {
  const root = path.join(os.homedir(), 'Library', 'Application Support', 'DeepSeek Harness', 'Computer Use');
  let entries;
  try { entries = readdirSync(root); } catch { return []; }
  return entries.flatMap((entry) => {
    const appPath = path.join(root, entry, HELPER_APP);
    const helperPath = path.join(appPath, 'Contents', 'MacOS', HELPER_BIN);
    try { return [{ helperPath, mtimeMs: statSync(helperPath).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.mtimeMs - a.mtimeMs).map(({ helperPath }) => helperPath);
}

function verifiedHelper(candidate) {
  if (!path.isAbsolute(candidate)) return null;
  try {
    const executable = realpathSync(candidate);
    const app = path.resolve(path.dirname(executable), '..', '..');
    if (path.basename(app) !== HELPER_APP || executable !== path.join(app, 'Contents', 'MacOS', HELPER_BIN)) return null;
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R=' + HELPER_REQUIREMENT, app], { timeout: 6000, stdio: 'ignore' });
    return executable;
  } catch {
    return null;
  }
}

export function resolveHelperPath(explicit) {
  const configured = explicit || process.env.DSH_MAC_CUA_HELPER;
  const paths = configured ? [configured] : findHelpers();
  for (const candidate of paths) {
    const approved = verifiedHelper(candidate);
    if (approved) return approved;
  }
  throw new Error('HELPER_MISSING: no verified DSH Computer Use.app was found. Set up the official macOS helper in DSH settings.');
}

export function runtimeKeyFor(helperPath) {
  return createHash('sha256').update(readFileSync(helperPath)).digest('hex');
}

// macOS limits sun_path to 104 bytes and os.tmpdir() ('/var/folders/...') alone
// eats most of it, so the runtime directory is pinned to /tmp -- the same place
// the shipped helper uses.
function socketPathFor(runtimeKey) {
  return '/tmp/dsh-cua-' + process.getuid() + '/' + runtimeKey + '.sock';
}

function frame(value) {
  return JSON.stringify(value) + '\n';
}

/**
 * One live connection to the shared helper daemon.
 * Requests are queued: the helper serves one call at a time and drops the socket
 * when a second one arrives while it is busy, so every request waits for the
 * previous exchange to settle. Diagnostics are dropped; a dead socket fails the
 * in-flight call (and anything queued behind it) and is re-established by the
 * next request.
 */
export class NativeConnection {
  constructor({ helperPath, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) {
    this.helperPath = helperPath || null;
    this.connectTimeoutMs = connectTimeoutMs;
    this.runtimeKey = null;
    this.socket = null;
    this.ready = null;
    this.pending = new Map();
    this.buffer = '';
    this.nextId = 0;
    this.connecting = null;
    this.closed = false;
    this.dialSocket = null;
    this.child = null;
    // Single-flight gate: resolves when the previous exchange finished.
    this.tail = Promise.resolve();
  }

  get info() {
    return this.ready;
  }

  async connect() {
    if (this.closed) throw new Error('NATIVE_CLOSED: the desktop task ended');
    if (this.socket && this.ready) return this.ready;
    if (!this.connecting) {
      this.connecting = this.#open().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async #open() {
    if (!this.runtimeKey) {
      this.helperPath = resolveHelperPath(this.helperPath);
      this.runtimeKey = runtimeKeyFor(this.helperPath);
    }
    const target = socketPathFor(this.runtimeKey);
    let ready;
    try {
      ready = await this.#dial(target);
    } catch (error) {
      if (this.closed || error?.message?.startsWith('HELPER_REFUSED')) throw error;
      await this.#launchDaemon(target);
      if (this.closed) throw new Error('NATIVE_CLOSED: the desktop task ended');
      ready = await this.#dial(target);
    }
    if (this.closed) throw new Error('NATIVE_CLOSED: the desktop task ended');
    this.ready = ready;
    return ready;
  }

  async #launchDaemon(target) {
    const runtimeDirectory = path.dirname(target);
    const args = [
      '--ensure-shared',
      '--runtime-key',
      this.runtimeKey,
      '--runtime-directory',
      runtimeDirectory,
      '--startup-timeout-ms',
      String(STARTUP_TIMEOUT_MS)
    ];
    const child = spawn(this.helperPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', () => {});
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, STARTUP_TIMEOUT_MS);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // A launcher that reports a structured refusal explains itself; anything else
    // is covered by the dial attempt that follows.
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && message.type === 'error') {
        throw new Error('HELPER_REFUSED: ' + message.code + ': ' + message.message);
      }
    }
    if (!existsSync(target)) {
      const tail = (err || out).trim().split('\n').slice(-3).join(' | ');
      throw new Error('HELPER_START_FAILED: the helper did not open ' + target + (tail ? ' (' + tail + ')' : ''));
    }
  }

  #dial(target) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(target);
      socket.setEncoding('utf8');
      this.dialSocket = socket;
      let settled = false;
      let handshake = '';
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        if (this.dialSocket === socket) this.dialSocket = null;
        fn(value);
      };
      const timer = setTimeout(() => {
        try {
          socket.destroy();
        } catch {}
        finish(reject, new Error('HELPER_TIMEOUT: the helper did not complete the handshake'));
      }, this.connectTimeoutMs);

      const onError = (error) => {
        try {
          socket.destroy();
        } catch {}
        finish(reject, new Error('HELPER_CONNECT: ' + (error.code || error.message)));
      };
      const onClose = () => finish(reject, new Error('HELPER_DISCONNECTED: handshake connection closed'));
      const onData = (chunk) => {
        handshake += chunk.toString('utf8');
        if (handshake.length > HANDSHAKE_BYTES) {
          try {
            socket.destroy();
          } catch {}
          return finish(reject, new Error('HELPER_PROTOCOL: handshake exceeded ' + HANDSHAKE_BYTES + ' bytes'));
        }
        const index = handshake.indexOf('\n');
        if (index < 0) return;
        const line = handshake.slice(0, index);
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          try {
            socket.destroy();
          } catch {}
          return finish(reject, new Error('HELPER_PROTOCOL: malformed handshake'));
        }
        if (!message || message.type === 'error') {
          try {
            socket.destroy();
          } catch {}
          return finish(reject, new Error('HELPER_REFUSED: ' + (message?.code || 'UNKNOWN') + ': ' + (message?.message || 'refused')));
        }
        if (message.type !== 'ready' || message.protocol !== PROTOCOL) {
          try {
            socket.destroy();
          } catch {}
          return finish(reject, new Error('HELPER_PROTOCOL: unexpected handshake reply'));
        }
        // The socket is ours from here on: switch to line-framed request/reply.
        if (this.closed) {
          socket.destroy();
          return finish(reject, new Error('NATIVE_CLOSED: the desktop task ended'));
        }
        this.socket = socket;
        this.ready = message;
        this.buffer = handshake.slice(index + 1);
        socket.removeListener('data', onData);
        socket.on('data', (chunk) => this.#onData(chunk));
        const disconnected = () => { if (this.socket === socket) this.#drop(); };
        socket.on('error', disconnected);
        socket.on('close', disconnected);
        finish(resolve, message);
        if (this.buffer) {
          const rest = this.buffer;
          this.buffer = '';
          this.#onData(Buffer.from(rest, 'utf8'));
        }
      };
      socket.on('error', onError);
      socket.on('close', onClose);
      socket.on('connect', () => {
        socket.write(frame({ type: 'hello', protocol: PROTOCOL, runtimeKey: this.runtimeKey, config: NATIVE_CONFIG }));
        socket.on('data', onData);
      });
    });
  }

  #drop() {
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.socket = null;
    this.ready = null;
    this.buffer = '';
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('HELPER_DISCONNECTED: the helper closed the connection'));
    }
  }

  #onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && message.type === 'diagnostic') continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const code = message.error.code || 'NATIVE_ERROR';
        entry.reject(new Error(code + ': ' + (message.error.message || 'native call failed')));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  /**
   * Send one call and wait for its reply. Calls are strictly serialised: the
   * helper closes the socket instead of answering two calls at once, so the
   * timeout starts only when the call actually reaches the wire.
   */
  async request(method, params = {}, options = {}) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await this.exchange(method, params, options);
    } finally {
      release();
    }
  }

  async exchange(method, params = {}, { timeoutMs = NATIVE_CONFIG.timeoutMs, signal } = {}) {
    signal?.throwIfAborted();
    await this.connect();
    signal?.throwIfAborted();
    const socket = this.socket;
    if (this.closed || !socket) throw new Error('HELPER_DISCONNECTED: no live helper connection');
    const id = 'r' + ++this.nextId;
    return new Promise((resolve, reject) => {
      const interrupt = (error) => {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // Closing this client channel cancels its in-flight request in the native
        // coordinator. Do not release the queue onto a socket still doing input.
        socket.destroy();
        if (this.socket === socket) this.#drop();
        reject(error);
      };
      const timer = setTimeout(() => interrupt(new Error('NATIVE_TIMEOUT: ' + method + ' did not answer within ' + timeoutMs + 'ms')), timeoutMs);
      const onAbort = () => interrupt(signal.reason ?? new Error('NATIVE_CANCELLED'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer
      });
      try {
        socket.write(frame({ id, method, params }));
      } catch (error) {
        interrupt(new Error('HELPER_DISCONNECTED: ' + error.message));
      }
    });
  }

  close() {
    this.closed = true;
    this.dialSocket?.destroy();
    this.socket?.destroy();
    if (this.child?.exitCode === null) this.child.kill();
    this.#drop();
  }
}
