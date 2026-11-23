// The preview is a non-activating accessory app. One task owns one process and
// its anonymous stdin pipe, so tasks/hosts cannot cross-talk and a host crash
// closes the pipe. A handle never writes to the child of a later task.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BINARY = path.resolve(here, '..', 'bin', 'dsh-mac-cua-hud');
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const WRITE_TIMEOUT_MS = 1500;
const TERMINATE_TIMEOUT_MS = 300;
const FRAME_FIELDS = ['heading', 'caption', 'image', 'cursor', 'idleMs'];
const NATIVE_FIELDS = ['windowId', 'pid', 'title', 'bounds'];

function framePatch(frame, source) {
  const patch = {};
  if (frame && typeof frame === 'object') {
    const fields = source === 'external' ? FRAME_FIELDS : [...FRAME_FIELDS, ...NATIVE_FIELDS];
    for (const key of fields) {
      if (Object.hasOwn(frame, key) && frame[key] !== undefined) patch[key] = frame[key];
    }
  }
  return patch;
}

function waitFor(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => { timer = setTimeout(resolve, ms, false); })
  ]).finally(() => clearTimeout(timer));
}

export class Hud {
  #active = null;
  #disposed = false;
  #legacyAllowed = true;
  #stopping = Promise.resolve();
  #spawn;

  constructor(options = {}) {
    this.binary = options.binary || process.env.DSH_MAC_CUA_HUD_BIN || DEFAULT_BINARY;
    this.enabled = options.enabled ?? (process.platform === 'darwin' && process.env.DSH_MAC_CUA_HUD !== '0');
    const idle = Number(process.env.DSH_MAC_CUA_HUD_IDLE_MS || 0);
    this.idleMs = Number.isFinite(idle) ? Math.max(0, idle) : 0;
    this.#spawn = options.spawn || spawn;
  }

  /** Start a scoped preview, superseding any previous handle immediately.
   * ready/update resolve true only if the frame was written to the private pipe,
   * not when it has been painted. Coalesced or invalid updates resolve false.
   * A preview pinned to source: 'external' cannot request native capture.
   */
  begin(frame = {}) {
    this.#legacyAllowed = false;
    return this.#begin(frame, false);
  }

  #begin(frame, legacy) {
    if (!this.enabled || this.#disposed) {
      const inactive = () => Promise.resolve(false);
      return Object.freeze({ ready: inactive(), update: inactive, end: inactive });
    }
    if (this.#active) void this.#end(this.#active);
    const source = frame?.source === 'external' ? 'external' : 'native';
    const state = { source, ended: false, pumping: false, child: null, pending: null, cancelWrite: null, legacy };
    this.#active = state;
    const ready = this.#enqueue(state, {
      ...(!legacy && { heading: 'Background Computer Use', caption: 'Starting…', lifecycle: 'begin' }),
      idleMs: this.idleMs,
      ...framePatch(frame, source),
      source
    });
    return Object.freeze({
      ready,
      update: (patch) => this.#enqueue(state, framePatch(patch, source)),
      end: () => this.#end(state)
    });
  }

  /** Compatibility path for older callers. Cannot restart a scoped or hidden HUD. */
  send(frame) {
    if (!this.#legacyAllowed || !this.enabled || this.#disposed) return Promise.resolve(false);
    return this.#active?.legacy
      ? this.#enqueue(this.#active, framePatch(frame, this.#active.source))
      : this.#begin(frame, true).ready;
  }

  #isCurrent(state) {
    return !this.#disposed && !state.ended && this.#active === state;
  }

  #enqueue(state, patch) {
    if (!this.#isCurrent(state)) return Promise.resolve(false);
    return new Promise((resolve) => {
      // Keep only the latest pending image. Merge its metadata in case the next
      // frame contains only image data and no new caption/cursor.
      const previous = state.pending;
      if (previous) previous.resolve(false);
      state.pending = { frame: { ...previous?.frame, ...patch }, resolve };
      if (!state.pumping) void this.#pump(state);
    });
  }

  #startChild(state) {
    try {
      const child = this.#spawn(this.binary, [], { stdio: ['pipe', 'ignore', 'ignore'] });
      state.child = child;
      state.exited = new Promise((resolve) => {
        child.once('close', () => {
          resolve();
          state.cancelWrite?.();
          // Never restart an existing task on a late in-flight frame (including
          // on the helper's hard timeout). A new task may create another child.
          if (this.#isCurrent(state)) void this.#end(state);
        });
      });
      child.on('error', () => { if (this.#isCurrent(state)) void this.#end(state); });
      child.stdin.on('error', () => { if (this.#isCurrent(state)) void this.#end(state); });
      child.unref?.();
      child.stdin.unref?.();
      return child;
    } catch {
      return null;
    }
  }

  #write(state, payload) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        state.cancelWrite = null;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), WRITE_TIMEOUT_MS);
      state.cancelWrite = () => finish(false);
      try {
        state.child.stdin.write(payload, (error) => finish(!error));
      } catch {
        finish(false);
      }
    });
  }

  async #pump(state) {
    state.pumping = true;
    try {
      while (this.#isCurrent(state) && state.pending) {
        const item = state.pending;
        state.pending = null;
        let payload;
        try { payload = Hud.encodeFrame(item.frame); }
        catch { item.resolve(false); continue; }
        if (!state.child && !this.#startChild(state)) {
          item.resolve(false);
          void this.#end(state);
          return;
        }
        const written = await this.#write(state, payload);
        item.resolve(written && this.#isCurrent(state));
        if (!written && this.#isCurrent(state)) void this.#end(state);
      }
    } finally {
      state.pumping = false;
    }
  }

  static encodeFrame(frame) {
    const json = JSON.stringify(frame);
    const length = Buffer.byteLength(json, 'utf8');
    if (length > MAX_PAYLOAD_BYTES) throw new RangeError('HUD frame exceeds the payload limit');
    const data = Buffer.allocUnsafe(4 + length);
    data.writeUInt32BE(length, 0);
    data.write(json, 4, length, 'utf8');
    return data;
  }

  async #stopChild(state) {
    const { child, exited } = state;
    if (!child) return true;
    // End out of band: a stale PNG already queued in the pipe must not delay
    // removal or reach a later preview. Destroying stdin also handles shutdown
    // if the parent exits. Kill only the child we spawned, never a shared PID.
    try { child.kill('SIGTERM'); } catch { /* child already gone */ }
    try { child.stdin.destroy(); } catch { /* stream already closed */ }
    if (await waitFor(exited, TERMINATE_TIMEOUT_MS)) return true;
    try { child.kill('SIGKILL'); } catch { /* child already gone */ }
    return waitFor(exited, TERMINATE_TIMEOUT_MS);
  }

  #end(state) {
    if (state.ended || this.#active !== state) return Promise.resolve(false);
    state.ended = true;
    if (state.legacy) this.#legacyAllowed = false;
    this.#active = null;
    state.pending?.resolve(false);
    state.pending = null;
    state.cancelWrite?.();
    const stopped = this.#stopChild(state);
    this.#stopping = Promise.all([this.#stopping, stopped]);
    // Retain one join for close(), without keeping every previous task result.
    this.#stopping = this.#stopping.then(() => undefined);
    return stopped;
  }

  hide() {
    this.#legacyAllowed = false;
    return this.#active ? this.#end(this.#active) : Promise.resolve(false);
  }

  async close() {
    this.#disposed = true;
    await this.hide();
    await this.#stopping;
  }
}
