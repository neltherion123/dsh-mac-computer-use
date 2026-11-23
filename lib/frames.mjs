// Turns each completed action into one frame for the floating preview window.
//
// Nothing here is on the model's critical path: frames are built after the tool
// result is already returned, failures are silent, and the newest frame wins when
// the window is still busy. It reuses the screenshot RPC the helper already has,
// so the preview never needs a capture permission of its own.
const SNAPSHOT_HISTORY = 8;
const MIN_GAP_MS = 90;
const SHOT_TIMEOUT_MS = 15000;
const REUSE_SHOT_MS = 4000;

const snapshots = new Map(); // snapshotId -> { appHandle, windowId, windows, elements }
const windowsByApp = new Map(); // appHandle -> windows result
const appNames = new Map(); // appHandle -> { name, bundleId }

let busy = false;
let queued = null;
let lastShot = null;


function truncate(value, limit) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

/** Cache what later frames need: element bounds, window lists, app names. */
export function remember(action, args, result) {
  if (!result || typeof result !== 'object') return;
  if (action === 'open_app' && result.appHandle) {
    appNames.set(result.appHandle, { name: result.name, bundleId: result.bundleId, pid: result.pid });
  }
  if (action === 'windows' && args.appHandle) {
    windowsByApp.set(args.appHandle, Array.isArray(result) ? result : []);
  }
  if ((action === 'state' || action === 'observe') && typeof result.snapshotId === 'string') {
    const elements = new Map();
    for (const entry of Array.isArray(result.elements) ? result.elements : []) {
      if (!entry || typeof entry.elementId !== 'string') continue;
      elements.set(entry.elementId, {
        role: entry.role || null,
        label: entry.title || entry.value || entry.description || null,
        bounds: Array.isArray(entry.bounds) && entry.bounds.length === 4 ? entry.bounds : null
      });
    }
    const windows = Array.isArray(result.windows) ? result.windows : windowsByApp.get(result.appHandle) || [];
    snapshots.set(result.snapshotId, {
      appHandle: result.appHandle,
      windowId: typeof result.windowId === 'number' ? result.windowId : null,
      focusedWindowId: typeof result.focusedWindowId === 'number' ? result.focusedWindowId : null,
      windows,
      elements
    });
    if (snapshots.size > SNAPSHOT_HISTORY) snapshots.delete(snapshots.keys().next().value);
    if (result.appHandle) windowsByApp.set(result.appHandle, windows);
  }
}

function pickWindow(windows, preferredId) {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  // Apps expose plenty of helper windows (tab strips, hidden panels, 500x500
  // placeholders) whose AX id is not a captureable page at all. A window the
  // agent typed into is never a 1512x33 strip, so require a plausible size --
  // but always honour an explicit id rather than silently previewing something
  // else, and fall back to every window when nothing looks real.
  const real = (item) => item && item.bounds && item.bounds.width >= 200 && item.bounds.height >= 100;
  const pool = windows.some(real) ? windows.filter(real) : windows;
  if (typeof preferredId === 'number') {
    const exact = pool.find((item) => item && item.windowId === preferredId);
    if (exact) return exact;
  }
  const area = (item) => (item.bounds ? item.bounds.width * item.bounds.height : 0);
  const ranked = pool
    .filter((item) => item && item.bounds && area(item) > 0)
    .map((item) => ({
      item,
      score: (item.isOnScreen === true ? 1000000 : 0) + (item.title ? 100000 : 0) + area(item)
    }))
    .sort((a, b) => b.score - a.score);
  return ranked.length ? ranked[0].item : windows[0];
}

function resolveTarget(args) {
  const appHandle = typeof args.appHandle === 'string' ? args.appHandle : null;
  if (!appHandle) return null;
  const snap = typeof args.snapshotId === 'string' ? snapshots.get(args.snapshotId) : null;
  const windows = windowsByApp.get(appHandle) || (snap && snap.windows) || [];
  // Only an explicit windowId pins the preview. A snapshot often points at a
  // helper window (a tab strip or a 500x500 placeholder), which would show the
  // user a blank card, so anything else goes through the ranking below.
  const preferred = typeof args.windowId === 'number' ? args.windowId : null;
  const window = pickWindow(windows, preferred);
  if (!window) return null;
  return { appHandle, window, snap };
}

// The state tree prints ids as [12]; the native side and the cached element map
// use the bare 12, so strip the decoration before looking anything up.
function bareId(value) {
  return String(value == null ? '' : value).trim().replace(/^\[/, '').replace(/\]$/, '');
}

function elementTag(snap, elementId) {
  const id = bareId(elementId);
  const entry = snap ? snap.elements.get(id) : null;
  if (!entry) return '[' + id + ']';
  const role = String(entry.role || 'element').replace(/^AX/, '');
  return '[' + id + '] ' + role + (entry.label ? ' "' + truncate(entry.label, 26) + '"' : '');
}

const MODIFIER_SYMBOLS = { command: '⌘', shift: '⇧', option: '⌥', control: '⌃', fn: 'fn' };

function describeKey(args) {
  const modifiers = Array.isArray(args.modifiers)
    ? args.modifiers.map((item) => MODIFIER_SYMBOLS[item] || item).join('')
    : '';
  return modifiers + String(args.key || '');
}

function percent(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return '0%';
  return Math.round((value / total) * 100) + '%';
}

function describe(action, args, target, result) {
  const snap = target.snap;
  switch (action) {
    case 'state': {
      const count = result && Array.isArray(result.elements) ? result.elements.length : null;
      return 'read accessibility tree' + (count ? ' · ' + count + ' nodes' : '');
    }
    case 'observe': return 'read accessibility tree and screenshot';
    case 'windows': return 'list windows';
    case 'actions': return 'list actions for ' + elementTag(snap, args.elementId);
    case 'screenshot': return 'screenshot';
    case 'open_app': return 'attach to ' + (result && result.name ? result.name : 'app');
    case 'invoke': return 'invoke ' + elementTag(snap, args.elementId);
    case 'perform': return 'perform ' + String(args.actionName || args.action || 'action') + ' on ' + elementTag(snap, args.elementId);
    case 'set_value': return 'set value of ' + elementTag(snap, args.elementId);
    case 'select_text': return 'select text in ' + elementTag(snap, args.elementId);
    case 'click': {
      if (args.elementId) return 'click ' + elementTag(snap, args.elementId);
      const shot = lastShot;
      const width = shot ? shot.pixelWidth : null;
      const height = shot ? shot.pixelHeight : null;
      if (args.relative === true) return 'click ' + args.x + '‰, ' + args.y + '‰ of window';
      return 'click ' + (width ? percent(args.x, width) : args.x) + ', ' + (height ? percent(args.y, height) : args.y) + ' of window';
    }
    case 'hover': {
      if (args.elementId) return 'hover ' + elementTag(snap, args.elementId);
      return 'hover ' + args.x + ', ' + args.y;
    }
    case 'type_text': return 'type text';
    case 'press_key': return 'press ' + describeKey(args);
    case 'paste': return 'paste ' + String(args.text || '').length + ' chars';
    case 'scroll': {
      const y = Number(args.deltaLinesY) || 0;
      const x = Number(args.deltaLinesX) || 0;
      const parts = [];
      if (y) parts.push(y > 0 ? '↑ ' + y : '↓ ' + -y);
      if (x) parts.push(x > 0 ? '← ' + x : '→ ' + -x);
      return 'scroll ' + (parts.join(' ') || '0');
    }
    case 'drag': return 'drag ' + args.fromX + ', ' + args.fromY + ' → ' + args.toX + ', ' + args.toY;
    default: return action
  }
}

// Where the agent is "pointing", as a 0..1 fraction of the captured window.
function cursorFor(action, args, target, shot) {
  const bounds = shot && shot.bounds ? shot.bounds : null;
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const toFraction = (x, y) => ({
    x: Math.min(1, Math.max(0, (x - bounds.x) / bounds.width)),
    y: Math.min(1, Math.max(0, (y - bounds.y) / bounds.height))
  });

  if (args.elementId && target.snap) {
    const entry = target.snap.elements.get(bareId(args.elementId));
    if (entry && entry.bounds) {
      const [x, y, width, height] = entry.bounds;
      return toFraction(x + width / 2, y + height / 2);
    }
  }

  const pixelWidth = shot.pixelWidth || 0;
  const pixelHeight = shot.pixelHeight || 0;
  if (action === 'click' || action === 'hover' || action === 'scroll') {
    if (args.relative === true) {
      return { x: Number(args.x) / 999, y: Number(args.y) / 999 };
    }
    if (pixelWidth > 0 && pixelHeight > 0) {
      const rawX = Number(args.x);
      const rawY = Number(args.y);
      return toFraction(bounds.x + (rawX / pixelWidth) * bounds.width, bounds.y + (rawY / pixelHeight) * bounds.height);
    }
  }
  if (action === 'drag' && pixelWidth > 0 && pixelHeight > 0) {
    // Show the drop end: that is the part of the gesture worth watching.
    return toFraction(bounds.x + (Number(args.toX) / pixelWidth) * bounds.width,
                      bounds.y + (Number(args.toY) / pixelHeight) * bounds.height);
  }
  return null;
}

async function capture(connection, target, action, signal) {
  signal.throwIfAborted();
  const { appHandle, window } = target;
  const reusable = action === 'type_text' || action === 'press_key' || action === 'paste';
  if (reusable && lastShot && lastShot.appHandle === appHandle && lastShot.windowId === window.windowId
      && Date.now() - lastShot.at < REUSE_SHOT_MS) {
    return lastShot;
  }
  const shot = await connection.request('screenshot', { appHandle, windowId: window.windowId }, { timeoutMs: SHOT_TIMEOUT_MS, signal });
  lastShot = {
    appHandle,
    windowId: window.windowId,
    at: Date.now(),
    data: shot.data,
    pixelWidth: shot.pixelWidth,
    pixelHeight: shot.pixelHeight,
    bounds: shot.bounds
  };
  return lastShot;
}

async function send({ connection, action, args, result, target, preview, signal }) {
  const shot = await capture(connection, target, action, signal);
  signal.throwIfAborted();
  const appName = (appNames.get(target.appHandle) || {}).name || target.window.appName || target.appHandle;
  const title = target.window.title ? ' — ' + truncate(target.window.title, 34) : '';
  const frame = {
    heading: truncate(appName + title, 64),
    caption: describe(action, args, target, result),
    image: shot.data,
    // Lets the HUD keep the picture alive between tool calls: it captures this
    // window on its own timer. The AX window id usually equals the CGWindowID,
    // but not for every app, so the owner pid plus title and size let the HUD
    // find the right window either way.
    windowId: target.window.windowId,
    pid: (appNames.get(target.appHandle) || {}).pid,
    title: target.window.title || '',
    bounds: target.window.bounds || null
  };
  const cursor = cursorFor(action, args, target, shot);
  if (cursor) frame.cursor = { x: cursor.x, y: cursor.y };
  void preview.update(frame);
}

async function run(job) {
  busy = true;
  run.lastAt = Date.now();
  try {
    if (!job.signal.aborted) await send(job);
  } catch {
    // The preview is a courtesy: never surface its failures or slow the tool.
  } finally {
    busy = false;
  }
  const next = queued;
  queued = null;
  if (next && !next.signal.aborted) {
    const wait = MIN_GAP_MS - (Date.now() - Number(run.lastAt || 0));
    if (wait > 0) setTimeout(() => run(next), wait); else run(next);
  }
}

/** Fire-and-forget: build and show the frame for an action that just completed. */
export function publishFrame(connection, action, args, result, { preview, signal }) {
  if (!preview || signal.aborted) return;
  let target;
  try {
    target = resolveTarget(args || {});
  } catch {
    return;
  }
  if (!target) return;
  const job = { connection, action, args: args || {}, result, target, preview, signal };
  if (busy) { queued = job; return; }
  void run(job);
}
