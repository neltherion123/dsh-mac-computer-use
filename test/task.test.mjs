import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { DesktopTasks } from '../lib/task.mjs';
import { NativeTask } from '../lib/native-task.mjs';

function host() {
  const boundary = new WeakMap();
  const resources = [];
  const tasks = new DesktopTasks({
    getBoundary: (session) => boundary.get(session),
    create: (mode, signal) => {
      const resource = { mode, signal, closes: 0, close() { this.closes++; } };
      resources.push(resource);
      return resource;
    }
  });
  function start(agent, turn) {
    const controller = new AbortController();
    boundary.set(agent.session, { lastTurn: turn, openTurnStartSeq: turn });
    tasks.observeStep({ agent, turn, signal: controller.signal });
    return { controller, exec: { agent } };
  }
  return { tasks, resources, start };
}

test('turn preview lives across calls, phases and other sessions until normal completion', async () => {
  const { tasks, resources, start } = host();
  const agent = { session: {} };
  assert.throws(() => tasks.get({ agent }, 'browser'), /TURN_REQUIRED/);
  const { exec, controller } = start(agent, 4);
  assert.equal(tasks.current(exec), undefined);
  const firstCall = new AbortController();
  const task = tasks.get({ ...exec, signal: firstCall.signal }, 'browser');
  firstCall.abort();
  assert.equal(task.resource.signal.aborted, false);
  tasks.observeStep({ agent, turn: 4, signal: controller.signal });
  assert.equal(tasks.get(exec, 'browser'), task);
  const other = start({ session: {} }, 4);
  assert.throws(() => tasks.get(other.exec, 'browser'), /TASK_BUSY/);
  await tasks.finish(other.exec.agent.session, 4);
  assert.equal(task.resource.signal.aborted, false);
  assert.throws(() => tasks.get(exec, 'native'), /MODE_MISMATCH/);
  await tasks.finish(agent.session, 4);
  assert.equal(task.resource.closes, 1);
  assert.equal(task.resource.signal.aborted, true);
  assert.throws(() => tasks.get(exec, 'browser'), /TASK_STOPPED/);
  assert.equal(resources.length, 1);
});

test('host Stop aborts synchronously and queued work stays closed; stale terminal events cannot reopen a turn', async () => {
  const { tasks, start } = host();
  const agent = { session: {} };
  const initial = start(agent, 12);
  const task = tasks.get(initial.exec, 'browser');
  const reason = new Error('user requested stop');
  initial.controller.abort(reason);
  assert.equal(task.resource.signal.reason, reason);
  assert.throws(() => tasks.get(initial.exec, 'browser'), /user requested stop/);
  await tasks.finish(agent.session, 12);
  assert.equal(task.resource.closes, 1);
  const followUp = start(agent, 13);
  await tasks.cancel(followUp.exec);
  await tasks.finish(agent.session, 12);
  assert.throws(() => tasks.get(followUp.exec, 'browser'), /TASK_STOPPED/);
  const next = start(agent, 14);
  const active = tasks.get(next.exec, 'browser');
  await tasks.disposeSession(agent.session);
  assert.equal(active.resource.closes, 1);
  await tasks.dispose();
  assert.throws(() => tasks.get(next.exec, 'browser'), /PLUGIN_DISPOSED/);
});

function native({ selected, running = true, locked = false, signal = new AbortController().signal } = {}) {
  const requests = [];
  const connection = {
    close() {},
    async request(method, params) {
      requests.push([method, params]);
      if (method === 'getCapabilities') return {sessionLocked: locked, permissions: {accessibility:true, screenRecording:true}};
      if (method === 'getApp') return {bundleId:'com.apple.calculator', name:'Calculator', pid:running ? 42 : undefined, running, appHandle:'opaque'};
      if (method === 'launchApp') return {bundleId:'com.apple.calculator', name:'Calculator', pid:42, running:true, appHandle:'launched'};
      if (['invoke', 'performAction', 'click', 'mouseMove', 'typeText', 'pressKey', 'paste', 'scroll', 'drag'].includes(method)) return {dispatched:true};
      if (method === 'getState') return {appHandle:params.appHandle, windowId:params.windowId ?? 4, focusedWindowId:4, snapshotId:'snap', truncated:false, tree:'button "Seven"'};
      if (method === 'screenshot') return {mimeType:'image/png', data:'aW1hZ2U=', pixelWidth:1, pixelHeight:1};
      throw new Error('Unexpected native request: ' + method);
    }
  };
  const task = new NativeTask({ connection, signal, ctx: {
    get: () => ({ ask: async ({ questions: [question] }) => ({ answers: [{ id: question.id, selected }] }) })
  } });
  return { task, requests, signal, exec: { agent: {} } };
}

test('native approval asks one well-formed approval question with its scope detail', async () => {
  let asked;
  const signal = new AbortController().signal;
  const task = new NativeTask({ signal, connection: {
    close() {},
    async request(method) {
      if (method === 'getCapabilities') return {sessionLocked:false, permissions:{accessibility:true, screenRecording:true}};
      if (method === 'getApp') return {bundleId:'com.apple.calculator', name:'Calculator', pid:42, running:true, appHandle:'opaque'};
      throw new Error('Unexpected native request: ' + method);
    }
  }, ctx: { get: () => ({ ask: async (request) => {
    asked = request;
    return { answers: [{ id: request.questions[0].id, selected: ['仅允许本次任务'] }] };
  } }) } });
  await task.run('open_app', { selector: 'com.apple.calculator' }, { agent: {} }, signal);
  assert.equal(asked.questions.length, 1);
  const [question] = asked.questions;
  assert.equal(typeof question.detail, 'string');
  assert.ok(question.detail.length > 0, 'approval questions must carry the scope detail DSH requires');
  assert.equal(question.intent.kind, 'approval');
  const labels = [question.intent.approve, question.intent.reject, ...question.intent.always === undefined ? [] : [question.intent.always]];
  assert.deepEqual(labels, question.options.map((option) => option.label));
  assert.equal(new Set(labels).size, labels.length);
});

test('native approval reports why the question could not be answered', async () => {
  const signal = new AbortController().signal;
  const task = new NativeTask({ signal, connection: {
    close() {},
    async request(method) {
      if (method === 'getCapabilities') return {sessionLocked:false, permissions:{accessibility:true, screenRecording:true}};
      if (method === 'getApp') return {bundleId:'com.apple.calculator', name:'Calculator', pid:42, running:true, appHandle:'opaque'};
      throw new Error('Unexpected native request: ' + method);
    }
  }, ctx: { get: () => ({ ask: async () => { throw new Error('BAD_INTENT: question declares intent approval without the scope detail it requires'); } }) } });
  await assert.rejects(task.run('open_app', { selector: 'com.apple.calculator' }, { agent: {} }, signal), (error) => {
    assert.match(error.message, /^APP_APPROVAL_UNAVAILABLE:/);
    assert.match(error.message, /BAD_INTENT/);
    return true;
  });
});

test('native lock and declined approval never dispatch app selection or input', async () => {
  for (const [options, expected, methods] of [
    [{ locked: true }, /SESSION_LOCKED/, ['getCapabilities']],
    [{ selected: [] }, /APP_ACCESS_DENIED/, ['getCapabilities', 'getApp']],
    [{ selected: ['不允许'] }, /APP_ACCESS_DENIED/, ['getCapabilities', 'getApp']]
  ]) {
    const { task, requests, signal, exec } = native(options);
    await assert.rejects(task.run('open_app', { selector: 'com.apple.calculator' }, exec, signal), expected);
    assert.deepEqual(requests.map(([method]) => method), methods);
  }
});

test('native approval binds an ID to one target and exposes the Codex-style action surface', async () => {
  const { task, requests, signal, exec } = native({ selected: ['仅允许本次任务'] });
  const app = await task.run('open_app', { selector: 'com.apple.calculator' }, exec, signal);
  assert.deepEqual(requests.at(-1), ['getApp', { selector: 'com.apple.calculator' }]);
  await assert.rejects(task.run('invoke', { appHandle: 'other' }, exec, signal), /APP_ACCESS_REQUIRED/);
  assert.equal((await task.run('invoke', { appHandle: app.appHandle, snapshotId:'snap', elementId:'[7]' }, exec, signal)).dispatched, true);
  assert.equal((await task.run('perform', { appHandle: app.appHandle, snapshotId:'snap', elementId:'7', actionName:'AXRaise' }, exec, signal)).dispatched, true);
  assert.equal((await task.run('type_text', { appHandle: app.appHandle, text:'hello' }, exec, signal)).dispatched, true);
  assert.deepEqual(requests.at(-1), ['typeText', { appHandle:'opaque', text:'hello' }]);
  assert.equal((await task.run('click', { appHandle:app.appHandle, snapshotId:'snap', elementId:'[7]', clickCount:2 }, exec, signal)).dispatched, true);
  assert.deepEqual(requests.at(-1), ['click', { appHandle:'opaque', snapshotId:'snap', elementId:'7', clickCount:2 }]);
  assert.equal((await task.run('press_key', { appHandle:app.appHandle, key:'a', modifiers:['command'] }, exec, signal)).dispatched, true);
  assert.deepEqual(requests.at(-1), ['pressKey', { appHandle:'opaque', key:'a', modifiers:['command'] }]);
  assert.equal((await task.run('scroll', { appHandle:app.appHandle, windowId:4, snapshotId:'snap', x:50, y:60, deltaLinesX:0, deltaLinesY:-3 }, exec, signal)).dispatched, true);
  assert.deepEqual(requests.at(-1), ['scroll', { appHandle:'opaque', windowId:4, snapshotId:'snap', x:50, y:60, deltaLinesX:0, deltaLinesY:-3 }]);
});

test('native open launches a stopped app after approval', async () => {
  const { task, requests, signal, exec } = native({ selected: ['仅允许本次任务'], running:false });
  const app = await task.run('open_app', { selector:'Calculator' }, exec, signal);
  assert.equal(app.appHandle, 'launched');
  assert.deepEqual(requests.map(([method]) => method), ['getCapabilities', 'getApp', 'launchApp']);
});

test('native task can approve more than one application like Codex getApp', async () => {
  const { task, requests, signal, exec } = native({ selected: ['仅允许本次任务'] });
  await task.run('open_app', { selector:'Calculator' }, exec, signal);
  await task.run('open_app', { selector:'com.apple.calculator' }, exec, signal);
  assert.equal(requests.filter(([method]) => method === 'getApp').length, 2);
});

test('native screenshots require a window and are private and removed upon closing', async (t) => {
  const { task, requests, signal, exec } = native({ selected: ['仅允许本次任务'] });
  t.after(() => task.close());
  const app = await task.run('open_app', { selector: 'com.apple.calculator' }, exec, signal);
  await assert.rejects(task.run('screenshot', { appHandle: app.appHandle }, exec, signal), /windowId/);
  assert.ok(!requests.some(([method]) => method === 'screenshot'));
  const shot = await task.run('screenshot', { appHandle: app.appHandle, windowId: 4 }, exec, signal);
  assert.equal(statSync(shot.path).mode & 0o777, 0o600);
  task.close();
  assert.equal(existsSync(shot.path), false);
});
