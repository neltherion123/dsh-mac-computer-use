// Codex-style native action adapters; app selection and approval are handled by NativeTask.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const TRAVERSAL = { maxElements: 2000, maxDepth: 25 };
const CLICK_FIELDS = ['mouseButton', 'modifiers', 'clickCount', 'holdMs'];

function requireString(args, key, hint) {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('INVALID_ARGUMENT: ' + key + ' is required' + (hint ? ' (' + hint + ')' : ''));
  }
  return value;
}

function requireNumber(args, key, hint) {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('INVALID_ARGUMENT: ' + key + ' must be a number' + (hint ? ' (' + hint + ')' : ''));
  }
  return value;
}

// The state tree prints node ids as [12] for readability, while the native
// protocol wants the bare decimal. Accept both so a copied id just works.
function normalizeElementId(value) {
  const raw = String(value).trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!/^\d+$/.test(raw)) {
    throw new Error('INVALID_ARGUMENT: elementId must be the decimal node id from the state tree, such as 12 or [12]; got ' + JSON.stringify(value));
  }
  return raw;
}

function snapshotRef(args) {
  return {
    appHandle: requireString(args, 'appHandle', 'open_app returns it'),
    ...(typeof args.windowId === 'number' ? { windowId: args.windowId } : {}),
    snapshotId: requireString(args, 'snapshotId', 'read it from state'),
    elementId: normalizeElementId(requireString(args, 'elementId', 'a node id from the current state tree'))
  };
}

function clickOptions(args) {
  const picked = {};
  for (const field of CLICK_FIELDS) {
    if (args[field] !== undefined) picked[field] = args[field];
  }
  if (picked.holdMs !== undefined && (!Number.isInteger(picked.holdMs) || picked.holdMs < 0)) {
    throw new Error('INVALID_ARGUMENT: holdMs must be a non-negative integer');
  }
  return picked;
}

function pointTarget(args) {
  const target = {
    appHandle: requireString(args, 'appHandle'),
    windowId: requireNumber(args, 'windowId', 'from windows, state or screenshot'),
    ...(typeof args.snapshotId === 'string' && args.snapshotId ? { snapshotId: args.snapshotId } : {}),
    x: requireNumber(args, 'x'),
    y: requireNumber(args, 'y')
  };
  if (args.relative === true) {
    if (!Number.isInteger(args.x) || !Number.isInteger(args.y) || args.x < 0 || args.y < 0 || args.x > 999 || args.y > 999) {
      throw new Error('INVALID_ARGUMENT: relative coordinates are integers from 0 to 999');
    }
    target.relative = true;
  }
  return target;
}

function keyboardTarget(args) {
  return { appHandle: requireString(args, 'appHandle') };
}

export const ACTIONS = Object.freeze({
  capabilities: async (connection) => connection.request('getCapabilities', {}),

  list_apps: async (connection) => connection.request('listApps', {}),

  find_apps: async (connection, args) => {
    const query = requireString(args, 'query', 'app name, bundle id or path fragment');
    return connection.request('findApps', { query, maxAppMatches: 50 });
  },
  windows: async (connection, args) => {
    const windows = await connection.request('listWindows', { appHandle: requireString(args, 'appHandle') });
    return windows;
  },

  state: async (connection, args) => {
    const params = { appHandle: requireString(args, 'appHandle'), ...TRAVERSAL };
    if (typeof args.windowId === 'number') params.windowId = args.windowId;
    if (args.includeMenus === true) params.includeMenus = true;
    if (args.details === true) params.details = true;
    if (typeof args.maxElements === 'number') params.maxElements = args.maxElements;
    if (typeof args.maxDepth === 'number') params.maxDepth = args.maxDepth;
    return connection.request('getState', params);
  },

  actions: async (connection, args) => connection.request('listActions', snapshotRef(args)),

  invoke: async (connection, args) => connection.request('invoke', snapshotRef(args)),

  perform: async (connection, args) => {
    const params = { ...snapshotRef(args), action: requireString(args, 'action', 'see the actions action') };
    if (args.argument !== undefined) params.argument = args.argument;
    return connection.request('performAction', params);
  },

  set_value: async (connection, args) => {
    if (args.value === undefined) throw new Error('INVALID_ARGUMENT: value is required');
    return connection.request('setValue', { ...snapshotRef(args), value: args.value });
  },

  select_text: async (connection, args) => {
    const params = { ...snapshotRef(args), text: requireString(args, 'text', 'literal text inside the element') };
    if (typeof args.prefix === 'string') params.prefix = args.prefix;
    if (typeof args.suffix === 'string') params.suffix = args.suffix;
    if (typeof args.selectionType === 'string') params.selectionType = args.selectionType;
    return connection.request('selectText', params);
  },
  click: async (connection, args) => {
    const options = clickOptions(args);
    const byElement = typeof args.elementId === 'string' && args.elementId !== '';
    return connection.request('click', byElement ? { ...snapshotRef(args), ...options } : { ...pointTarget(args), ...options });
  },
  hover: async (connection, args) => {
    const byElement = typeof args.elementId === 'string' && args.elementId !== '';
    return connection.request('mouseMove', byElement ? snapshotRef(args) : pointTarget(args));
  },
  type_text: async (connection, args) => {
    if (typeof args.text !== 'string') throw new Error('INVALID_ARGUMENT: text is required');
    return connection.request('typeText', { ...keyboardTarget(args), text: args.text });
  },
  press_key: async (connection, args) => {
    const params = { ...keyboardTarget(args), key: requireString(args, 'key', 'for example Tab, Return or f') };
    if (Array.isArray(args.modifiers)) params.modifiers = args.modifiers;
    return connection.request('pressKey', params);
  },
  paste: async (connection, args) => {
    if (typeof args.text !== 'string') throw new Error('INVALID_ARGUMENT: text is required');
    const params = {
      ...keyboardTarget(args), text: args.text,
      maxClipboardBytes: typeof args.maxClipboardBytes === 'number' ? args.maxClipboardBytes : 32 * 1024 * 1024,
      pasteReadTimeoutMs: typeof args.pasteReadTimeoutMs === 'number' ? args.pasteReadTimeoutMs : 1500,
      ...TRAVERSAL
    };
    if (args.format === 'html') params.format = 'html';
    return connection.request('paste', params);
  },
  scroll: async (connection, args) => connection.request('scroll', {
    ...pointTarget(args),
    deltaLinesX: requireNumber(args, 'deltaLinesX', 'integer -10..10'),
    deltaLinesY: requireNumber(args, 'deltaLinesY', 'integer -10..10')
  }),
  drag: async (connection, args) => {
    const params = {
      appHandle: requireString(args, 'appHandle'),
      windowId: requireNumber(args, 'windowId'),
      fromX: requireNumber(args, 'fromX'), fromY: requireNumber(args, 'fromY'),
      toX: requireNumber(args, 'toX'), toY: requireNumber(args, 'toY'),
      durationMs: typeof args.durationMs === 'number' ? args.durationMs : 500,
      steps: typeof args.steps === 'number' ? args.steps : 60
    };
    if (typeof args.snapshotId === 'string' && args.snapshotId) params.snapshotId = args.snapshotId;
    if (args.relative === true) params.relative = true;
    if (typeof args.mouseButton === 'string') params.mouseButton = args.mouseButton;
    if (Array.isArray(args.modifiers)) params.modifiers = args.modifiers;
    return connection.request('drag', params);
  },
  screenshot: async (connection, args, { getShotDir, signal }) => {
    const params = { appHandle: requireString(args, 'appHandle'), windowId: requireNumber(args, 'windowId', 'from windows or state') };
    const shot = await connection.request('screenshot', params, { timeoutMs: 15000 });
    signal.throwIfAborted();
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[shot.mimeType];
    if (!extension || typeof shot.data !== 'string') throw new Error('INVALID_SCREENSHOT: helper returned no supported image.');
    const file = path.join(getShotDir(), 'shot-' + randomUUID() + '.' + extension);
    writeFileSync(file, Buffer.from(shot.data, 'base64'), { mode: 0o600, flag: 'wx' });
    return {
      path: file,
      mimeType: shot.mimeType,
      pixelWidth: shot.pixelWidth,
      pixelHeight: shot.pixelHeight,
      bounds: shot.bounds,
      coordinateSpace: shot.coordinateSpace
    };
  }
});
