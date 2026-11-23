import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BackgroundBrowser } from '../lib/browser.mjs';

const chromeAvailable = !!process.env.DSH_MAC_CUA_CHROME || (process.platform === 'darwin' &&
  await Promise.any(['/Applications', path.join(os.homedir(), 'Applications')].flatMap((dir) =>
    ['Google Chrome for Testing', 'Google Chrome', 'Chromium'].map((name) =>
      access(path.join(dir, name + '.app', 'Contents', 'MacOS', name)))))
    .then(() => true, () => false));

async function fixture(t) {
  const server = createServer((req, res) => {
    if (req.url === '/blocked') { server.emit('fixture:blocked'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/next') { res.end('<title>Second fixture</title><main>Second document</main>'); return; }
    res.end([
      '<title>Private fixture</title><style>body{min-height:2400px}',
      '#coverwrap{position:relative;width:max-content}#cover{position:absolute;inset:0}',
      '#next{position:fixed;top:20px;right:20px}</style>',
      '<button id="go"><span>Toggle flag</span></button><p role="status" id="status">Ready</p>',
      '<label>Input <input id="entry"></label><p id="echo">No input</p>',
      '<a id="next" href="/next">Open next</a><div id="coverwrap"><button>Covered button</button><div id="cover"></div></div>',
      '<script>const flag=document.querySelector("#status");',
      'document.querySelector("#go").onclick=()=>{flag.textContent="Clicked";};',
      'const coverAnother=()=>{flag.textContent="Wrong target";};',
      'document.querySelector("#cover").onclick=coverAnother;document.querySelector("#coverwrap button").onclick=coverAnother;',
      'document.querySelector("#entry").oninput=(e)=>{document.querySelector("#echo").textContent=e.target.value;};',
      'let c=0;setInterval(()=>{document.body.style.backgroundColor="rgb(255,"+(245-(c++ % 25))+",240)"},75);',
      '</script>',
    ].join(''));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

function ref(state, label) {
  const line = state.tree.split('\n').find((line) => line.includes(label) && /^\s*\[\d+\]/.test(line));
  assert.ok(line, 'missing AX reference: ' + label + '\n' + state.tree);
  return { snapshotId: state.snapshotId, elementId: line.match(/\[(\d+)\]/)[1] };
}

async function eventually(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(30);
  }
  assert.fail('condition did not become true');
}

test('invalid navigation is rejected before browser startup; terminal actions cannot reopen', async () => {
  const browser = new BackgroundBrowser();
  assert.equal((await browser.run('browser_status')).state, 'idle');
  for (const url of ['file:///tmp/page', 'about:blank', 'data:text/html,hello', 'https://user:secret@example.com/',
    'http://localhost./', 'http://sub.localhost/', 'http://127.1/', 'http://2130706433/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://10.1.2.3/', 'http://169.254.169.254/']) {
    await assert.rejects(browser.run('browser_open', { url }), /^Error: INVALID_ARGUMENT:/, url);
  }
  await assert.rejects(browser.run('browser_state'), /BROWSER_NOT_STARTED/);
  assert.equal((await browser.run('browser_status')).state, 'idle');
  await browser.close();
  await browser.close();
  assert.equal((await browser.run('browser_status')).state, 'closed');
  await assert.rejects(browser.run('browser_open'), /BROWSER_CLOSED/);
  assert.equal((await new BackgroundBrowser({ signal: AbortSignal.abort() }).run('browser_status')).state, 'closed');
  const callAborted = new BackgroundBrowser();
  await assert.rejects(callAborted.run('browser_open', {}, { signal: AbortSignal.abort() }), /BROWSER_CLOSED/);
  assert.equal((await callAborted.run('browser_status')).state, 'closed');
});

test('private Chrome renders a local fixture, dispatches verified input, streams and cleans up',
  { skip: !chromeAvailable, timeout: 25000 }, async (t) => {
    const { base } = await fixture(t);
    const frames = [];
    const browser = new BackgroundBrowser({ allowLoopback: true, fps: 5, onFrame: (frame) => { frames.push(frame); } });
    t.after(() => browser.close());
    const opened = await browser.run('browser_open', { url: base + '/' });
    assert.equal(opened.state, 'ready');
    assert.equal(opened.instance, 'isolated-headless');
    assert.equal(opened.title, 'Private fixture');
    assert.equal(opened.url, base + '/');
    assert.equal(opened.documentReady, true);
    // No tool calls while waiting: the stream must remain live on its own.
    await eventually(() => {
      const fixtureFrames = frames.filter((frame) => frame.url === base + '/');
      return fixtureFrames.some((frame) => !frame.png.equals(fixtureFrames[0].png));
    });
    const shot = await browser.run('browser_screenshot');
    assert.equal(shot.pixelWidth, 1280);
    assert.equal(shot.pixelHeight, 800);
    assert.equal((await stat(shot.path)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(shot.path))).mode & 0o777, 0o700);
    await assert.rejects(browser.run('browser_click', { snapshotId: shot.snapshotId, x: 1280, y: 0 }), /inside the latest browser screenshot/);
    const observed = await browser.run('browser_observe');
    assert.match(observed.tree, /button "Toggle flag"/);
    assert.equal(observed.pixelWidth, 1280);
    assert.equal((await stat(observed.path)).mode & 0o777, 0o600);
    assert.equal((await browser.run('browser_click', { snapshotId: observed.snapshotId, x: 10, y: 10 })).dispatched, true);
    const state = await browser.run('browser_state');
    assert.match(state.tree, /button "Toggle flag"/);
    await assert.rejects(browser.run('browser_click', { snapshotId: shot.snapshotId, x: 10, y: 10 }), /BROWSER_STALE/);
    await assert.rejects(browser.run('browser_click', ref(state, 'button "Covered button"')), /BROWSER_ELEMENT_OBSCURED/);
    const clicked = await browser.run('browser_click', ref(state, 'button "Toggle flag"'));
    assert.ok(clicked.dispatched && clicked.cursor.x >= 0 && clicked.cursor.y >= 0);
    await assert.rejects(browser.run('browser_click', ref(state, 'button "Toggle flag"')), /BROWSER_STALE/);
    const after = await browser.run('browser_state');
    assert.match(after.tree, /Clicked/);
    assert.doesNotMatch(after.tree, /Wrong target/);
    await browser.run('browser_click', ref(after, 'textbox "Input"'));
    await browser.run('browser_type', { text: '你好 Chrome' });
    await browser.run('browser_key', { key: 'Backspace' });
    await browser.run('browser_key', { key: 'e' });
    await browser.run('browser_key', { key: '?' });
    assert.match((await browser.run('browser_state')).tree, /你好 Chrome\?/);
    const scrollShot = await browser.run('browser_screenshot');
    assert.equal((await browser.run('browser_scroll', { snapshotId: scrollShot.snapshotId, x: 800, y: 400, deltaY: 850 })).dispatched, true);
    // Keep the link fixed so residual wheel momentum cannot move the click target.
    const stateBeforeLink = await browser.run('browser_state');
    await browser.run('browser_click', ref(stateBeforeLink, 'link "Open next"'));
    await eventually(async () => (await browser.run('browser_status')).url === base + '/next');
    assert.match((await browser.run('browser_state')).tree, /Second document/);
    await eventually(() => frames.some((frame) => frame.url === base + '/next'));
    assert.equal((await browser.run('browser_back')).dispatched, true);
    await eventually(async () => (await browser.run('browser_status')).url === base + '/');
    assert.match((await browser.run('browser_state')).tree, /Toggle flag/);
    assert.equal((await browser.run('browser_forward')).dispatched, true);
    await eventually(async () => (await browser.run('browser_status')).url === base + '/next');
    assert.equal((await browser.run('browser_reload')).dispatched, true);
    await browser.close();
    const framesAtEnd = frames.length;
    await delay(300);
    assert.equal(frames.length, framesAtEnd);
    await assert.rejects(stat(path.dirname(shot.path)), { code: 'ENOENT' });
  });

for (const source of ['browser lifetime', 'active call', 'queued call']) {
  test(source + ' cancellation interrupts pending CDP navigation, clears the queue and removes its files',
    { skip: !chromeAvailable, timeout: 18000 }, async (t) => {
      const { base, server } = await fixture(t);
      const controller = new AbortController();
      const signal = controller.signal;
      const browser = new BackgroundBrowser({ signal: source === 'browser lifetime' ? signal : undefined, allowLoopback: true });
      t.after(() => browser.close());
      await browser.run('browser_open');
      const shot = await browser.run('browser_screenshot');
      const received = once(server, 'fixture:blocked');
      const blocked = browser.run('browser_navigate', { url: base + '/blocked' }, source === 'active call' ? { signal } : undefined);
      const rejected = assert.rejects(blocked, /BROWSER_CLOSED/);
      const queued = assert.rejects(browser.run('browser_type', { text: 'Never send' }, source === 'queued call' ? { signal } : undefined), /BROWSER_CLOSED/);
      const alsoQueued = assert.rejects(browser.run('browser_type', { text: 'Never send either' }), /BROWSER_CLOSED/);
      await received;
      controller.abort();
      // Let browser.run prove it closed the task on its own; invoking close()
      // here would make these assertions pass even if the signal was ignored.
      await Promise.all([rejected, queued, alsoQueued]);
      assert.equal((await browser.run('browser_status')).state, 'closed');
      await browser.close();
      await assert.rejects(stat(shot.path), { code: 'ENOENT' });
    });
}
