// A desktop lease belongs to exactly one DSH session turn. The task signal
// outlives individual calls. Once cancelled, no new work in that turn is admitted.
export class DesktopTasks {
  #steps = new WeakMap();
  #stopped = new WeakMap();
  #current;
  #disposed = false;

  constructor({ getBoundary, create }) {
    this.getBoundary = getBoundary;
    this.create = create;
  }

  observeStep({ agent, turn, signal }) {
    if (agent && Number.isInteger(turn) && signal) this.#steps.set(agent, { turn, signal });
  }

  #owner(exec) {
    const agent = exec?.agent;
    const session = agent?.session;
    const boundary = session && this.getBoundary(session);
    const turn = boundary?.lastTurn;
    const step = agent && this.#steps.get(agent);
    if (!session || !Number.isInteger(turn) || !Number.isInteger(boundary.openTurnStartSeq) || step?.turn !== turn) {
      throw new Error('TURN_REQUIRED: Computer Use requires an active DSH turn with a cancellation signal.');
    }
    return { session, turn, signal: step.signal };
  }

  get(exec, mode) {
    exec?.signal?.throwIfAborted();
    const owner = this.#owner(exec);
    owner.signal.throwIfAborted();
    if (this.#disposed) throw new Error('PLUGIN_DISPOSED: Computer Use was unloaded.');
    if (owner.turn <= (this.#stopped.get(owner.session) ?? -1)) throw new Error('TASK_STOPPED: Computer Use was stopped for this turn.');
    const current = this.#current;
    if (current) {
      if (current.session !== owner.session || current.turn !== owner.turn) {
        throw new Error('TASK_BUSY: another conversation owns the desktop preview.');
      }
      if (current.mode !== mode) throw new Error('MODE_MISMATCH: use either isolated browser or native AX in this turn.');
      return current;
    }
    const controller = new AbortController();
    const task = { ...owner, mode, controller, resource: null, cleanup: null, release: null };
    task.release = () => owner.signal.removeEventListener('abort', onAbort);
    const onAbort = () => { void this.finish(owner.session, owner.turn, { stopped: true, reason: owner.signal.reason }); };
    this.#current = task;
    owner.signal.addEventListener('abort', onAbort, { once: true });
    try {
      owner.signal.throwIfAborted();
      task.resource = this.create(mode, controller.signal);
      return task;
    } catch (error) {
      void this.finish(owner.session, owner.turn, { stopped: true, reason: error });
      throw error;
    }
  }

  // A read-only status or manual cancel must not create a desktop lease.
  current(exec) {
    const { session, turn } = this.#owner(exec);
    const task = this.#current;
    return task?.session === session && task.turn === turn ? task : undefined;
  }

  cancel(exec) {
    const { session, turn } = this.#owner(exec);
    return this.finish(session, turn, { stopped: true });
  }

  async finish(session, turn, { stopped = false, reason } = {}) {
    // Both normal and cancelled terminal turns are closed. Ignore delayed
    // events from older turns rather than weakening the latest tombstone.
    if (Number.isInteger(turn) && turn > (this.#stopped.get(session) ?? -1)) this.#stopped.set(session, turn);
    const task = this.#current;
    if (!task || task.session !== session || task.turn !== turn) return;
    if (task.cleanup) return task.cleanup;
    task.release();
    // Abort before yielding: reject queued operations even if shutdown needs time.
    task.controller.abort(reason ?? new Error('TASK_STOPPED: Computer Use turn ended.'));
    task.cleanup = Promise.resolve().then(() => task.resource?.close()).catch(() => {}).finally(() => {
      if (this.#current === task) this.#current = undefined;
    });
    return task.cleanup;
  }

  disposeSession(session) {
    const task = this.#current;
    if (task?.session === session) return this.finish(session, task.turn, { stopped: true });
  }

  dispose() {
    this.#disposed = true;
    const task = this.#current;
    if (task) return this.finish(task.session, task.turn, { stopped: true });
  }
}
