import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ACTIONS } from './actions.mjs';

export const NATIVE_ACTIONS = Object.freeze([
  'capabilities', 'list_apps', 'find_apps', 'open_app', 'windows', 'state', 'observe',
  'actions', 'invoke', 'perform', 'set_value', 'select_text', 'click', 'hover',
  'type_text', 'press_key', 'paste', 'scroll', 'drag', 'screenshot'
]);

export async function approveNative({ ctx, exec, signal, name, bundleId }) {
  const questions = ctx.get?.('userQuestions');
  if (!questions || !exec?.agent) throw new Error('APP_APPROVAL_UNAVAILABLE: no human approval is available; no application was accessed.');
  const label = '仅允许本次任务';
  let answer;
  try {
    answer = await questions.ask({ agent: exec.agent, signal, questions: [{
      id: 'dsh-mac-native-access',
      header: '原生应用授权',
      question: '允许本次任务查看并通过无障碍操作 ' + name + '（' + bundleId + '）？',
      detail: '仅本次任务有效：插件将读取 ' + name + ' 的界面结构与窗口截图，并向它发送点击、拖动与键盘输入。任务结束或本轮结束后授权立即失效，不会影响其他应用。',
      options: [{ label }, { label: '不允许' }],
      intent: { kind: 'approval', approve: label, reject: '不允许', subject: { name } }
    }] });
  } catch (error) {
    signal.throwIfAborted();
    const reason = typeof error?.message === 'string' && error.message ? ' [' + error.message + ']' : '';
    throw new Error('APP_APPROVAL_UNAVAILABLE: no app approval was received; no application was accessed.' + reason, { cause: error });
  }
  signal.throwIfAborted();
  const result = answer?.answers?.find((item) => item.id === 'dsh-mac-native-access');
  if (result?.selected?.length !== 1 || result.selected[0] !== label || result.custom?.trim()) {
    throw new Error('APP_ACCESS_DENIED: no application was accessed. Do not use another tool to retry.');
  }
}

export class NativeTask {
  constructor({ connection, signal, ctx }) {
    this.connection = connection;
    this.signal = signal;
    this.ctx = ctx;
    this.targets = new Map();
    this.stop = () => connection.close();
    signal.addEventListener('abort', this.stop, { once: true });
  }

  async run(action, args, exec, signal) {
    signal.throwIfAborted();
    const connection = { request: (method, params, options) => this.connection.request(method, params, { ...options, signal }) };
    const caps = await ACTIONS.capabilities(connection);
    if (caps?.sessionLocked !== false) throw new Error('SESSION_LOCKED: unlock macOS before using native Accessibility.');
    if (!caps?.permissions?.accessibility) throw new Error('AX_PERMISSION_REQUIRED: enable the helper in the official Computer Use permission panel.');
    if ((action === 'screenshot' || action === 'observe') && !caps.permissions.screenRecording) throw new Error('SCREEN_RECORDING_REQUIRED: enable screen recording in the official Computer Use permission panel.');
    if (action === 'open_app') {
      const selector = args.selector?.trim();
      if (!selector) throw new Error('INVALID_ARGUMENT: selector is required (app name, bundle id, path or running PID).');
      let selected = await connection.request('getApp', { selector });
      const name = selected.name || selector;
      const bundleId = selected.bundleId || selected.authorization?.id || selector;
      try {
        await approveNative({ ctx: this.ctx, exec, signal, name, bundleId });
      } catch (error) {
        this.refused = true;
        throw error;
      }
      if (!selected.running) selected = await connection.request('launchApp', { appHandle: selected.appHandle });
      if (!selected.running || typeof selected.appHandle !== 'string') throw new Error('STALE_APP: the approved application did not become available.');
      const target = { pid: selected.pid, bundleId: selected.bundleId, appHandle: selected.appHandle, name: selected.name };
      this.targets.set(target.appHandle, target);
      return { ...target, instance: selected.pid ? 'native' : 'unknown', running: true };
    }
    if (!this.targets.has(args.appHandle)) throw new Error('APP_ACCESS_REQUIRED: select and approve that native app in this turn.');
    if (action === 'observe') {
      const state = await ACTIONS.state(connection, args);
      const windowId = typeof args.windowId === 'number' ? args.windowId : state.focusedWindowId ?? state.windowId;
      if (typeof windowId !== 'number') return state;
      const shot = await ACTIONS.screenshot(connection, { ...args, windowId }, {
        signal,
        getShotDir: () => {
          this.signal.throwIfAborted();
          return this.shotDir ??= mkdtempSync(path.join(tmpdir(), 'dsh-mac-cua-native-'));
        }
      });
      return { ...state, ...shot, windowId };
    }
    if (action === 'screenshot') return ACTIONS.screenshot(connection, args, {
      signal,
      getShotDir: () => {
        this.signal.throwIfAborted();
        return this.shotDir ??= mkdtempSync(path.join(tmpdir(), 'dsh-mac-cua-native-'));
      }
    });
    return ACTIONS[action](connection, action === 'perform' ? { ...args, action: args.actionName } : args);
  }

  close() {
    this.signal.removeEventListener('abort', this.stop);
    this.stop();
    if (this.shotDir) {
      rmSync(this.shotDir, { recursive: true, force: true });
      this.shotDir = undefined;
    }
  }
}
