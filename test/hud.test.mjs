import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { Hud } from '../lib/hud.mjs';

function decode(payload) {
  assert.equal(payload.readUInt32BE(), payload.length - 4);
  return JSON.parse(payload.subarray(4).toString('utf8'));
}

function fixture({ ignoreTerm = false } = {}) {
  const children = [];
  const hud = new Hud({
    binary: 'mock-hud',
    enabled: true,
    spawn: (command, args, options) => {
      assert.equal(command, 'mock-hud');
      assert.deepEqual(args, []);
      assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore']);
      assert.notEqual(options.detached, true);
      const child = new EventEmitter();
      const stdin = child.stdin = new EventEmitter();
      child.frames = [];
      child.callbacks = [];
      child.signals = [];
      stdin.write = (payload, cb) => {
        child.frames.push(decode(payload));
        child.callbacks.push(cb);
        return false; // shed backpressure via queue coalescing, not concurrent writes
      };
      stdin.destroy = () => { child.pipeDestroyed = true; };
      child.kill = (signal) => {
        child.signals.push(signal);
        if (!ignoreTerm || signal === 'SIGKILL') queueMicrotask(() => child.emit('close'));
      };
      children.push(child);
      return child;
    }
  });
  return { hud, children };
}

test('writes a placeholder first and coalesces pending streamed frames and metadata', async () => {
  const { hud, children } = fixture();
  const preview = hud.begin({ heading: '浏览器', source: 'external', pid: 88, windowId: 42 });
  const child = children[0];
  assert.deepEqual(child.frames, [{
    heading: '浏览器', caption: 'Starting…', lifecycle: 'begin', idleMs: hud.idleMs, source: 'external'
  }]);
  const status = preview.update({ caption: 'Opening page', image: 'old' });
  const latest = preview.update({ image: 'latest', pid: 88, windowId: 42, source: 'native' });
  assert.equal(await status, false);
  assert.equal(child.frames.length, 1);
  child.callbacks.shift()();
  assert.equal(await preview.ready, true);
  assert.deepEqual(child.frames[1], { caption: 'Opening page', image: 'latest' });
  child.callbacks.shift()();
  assert.equal(await latest, true);
  assert.equal(await preview.end(), true);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.pipeDestroyed, true);
});

test('ends out of band under backpressure; stale updates and ends cannot affect the replacement', async () => {
  const { hud, children } = fixture();
  const old = hud.begin({ heading: 'Old task' });
  const queued = old.update({ image: 'queued old upload' });
  const [first] = children;
  const next = hud.begin({ heading: 'New task' });
  const second = children[1];
  assert.equal(await old.ready, false);
  assert.equal(await queued, false);
  assert.equal(await old.update({ image: 'late old upload' }), false);
  assert.equal(await old.end(), false);
  assert.equal(await hud.send({ image: 'unscoped upload' }), false);
  first.callbacks.shift()(); // an old write callback may arrive after replacement
  assert.equal(first.frames.length, 1);
  assert.deepEqual(first.signals, ['SIGTERM']);
  assert.deepEqual(second.signals, []);
  second.callbacks.shift()();
  assert.equal(await next.ready, true);
  assert.equal(await next.end(), true);
  assert.equal(await next.update({ image: 'after end' }), false);
  assert.equal(children.length, 2);
});

test('preserves native static frames/target metadata without allowing hide injection', async () => {
  const { hud, children } = fixture();
  const preview = hud.begin({ source: 'native' });
  const child = children[0];
  child.callbacks.shift()();
  assert.equal(await preview.ready, true);
  const nativeFrame = { image: 'static-image', windowId: 8, pid: 101, title: 'Test app', cursor: { x: 0.5, y: 0.5 } };
  const result = preview.update({ ...nativeFrame, hide: true });
  assert.deepEqual(child.frames[1], nativeFrame);
  child.callbacks.shift()();
  assert.equal(await result, true);
  assert.equal(await preview.update({ cursor: { x: 4n } }), false);
  assert.equal(child.frames.length, 2);
  await hud.close();
  assert.equal(await hud.begin().ready, false);
});

test('a dead native renderer is not respawned by stale frames', async () => {
  const { hud, children } = fixture();
  const preview = hud.begin();
  const first = children[0];
  first.emit('close');
  assert.equal(await preview.ready, false);
  assert.equal(await preview.update({ image: 'late' }), false);
  assert.equal(children.length, 1);
  const next = hud.begin();
  assert.equal(children.length, 2);
  children[1].callbacks.shift()();
  assert.equal(await next.ready, true);
  await hud.close();
});

test('missing renderer fails closed without breaking callers', async () => {
  const hud = new Hud({ enabled: true, binary: '/dev/null/renderer' });
  const preview = hud.begin();
  assert.equal(await preview.ready, false);
  assert.equal(await preview.update({ caption: 'late' }), false);
  await hud.close();
});

test('legacy hide permanently suppresses late unscoped frames until an explicit begin', async () => {
  const { hud, children } = fixture();
  const first = hud.send({ heading: 'legacy' });
  children[0].callbacks.shift()();
  assert.equal(await first, true);
  assert.equal(await hud.hide(), true);
  assert.equal(await hud.send({ heading: 'late' }), false);
  assert.equal(children.length, 1);
  const next = hud.begin({ heading: 'explicit' });
  children[1].callbacks.shift()();
  assert.equal(await next.ready, true);
  await hud.close();
});

test('with preview disabled no child is launched', async () => {
  const hud = new Hud({ enabled: false, spawn: () => assert.fail('spawned disabled renderer') });
  const preview = hud.begin();
  assert.equal(await preview.ready, false);
  assert.equal(await preview.update({ image: 'disabled' }), false);
  assert.equal(await preview.end(), false);
  await hud.close();
});

test('delivers UTF-8 frames to a real private subprocess and confirms it exited', { timeout: 5000 }, async (t) => {
  const reader = `
    let buffered = Buffer.alloc(0);
    process.stdin.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE()) {
        const end = 4 + buffered.readUInt32BE();
        process.stdout.write(buffered.subarray(4, end).toString('utf8') + '\\n');
        buffered = buffered.subarray(end);
      }
    });
  `;
  const seen = new EventEmitter();
  let child;
  const hud = new Hud({ enabled: true, spawn: (_command, _args, options) => {
    child = spawn(process.execPath, ['-e', reader], { ...options, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffered = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        seen.emit('frame', JSON.parse(buffered.slice(0, end)));
        buffered = buffered.slice(end + 1);
      }
    });
    return child;
  } });
  t.after(() => hud.close());
  const gotFirst = once(seen, 'frame');
  const preview = hud.begin({ heading: '任务 🎬' });
  assert.equal(await preview.ready, true);
  assert.equal((await gotFirst)[0].heading, '任务 🎬');
  const gotNext = once(seen, 'frame');
  assert.equal(await preview.update({ image: 'cG5n' }), true);
  assert.equal((await gotNext)[0].image, 'cG5n');
  const closed = once(child, 'close');
  assert.equal(await preview.end(), true);
  const [code, signal] = await closed;
  assert.ok(code === 0 || signal === 'SIGTERM');
});

test('force-stops an owned renderer that ignores the first cancellation signal', { timeout: 2500 }, async () => {
  const { hud, children } = fixture({ ignoreTerm: true });
  const preview = hud.begin();
  const child = children[0];
  const ended = preview.end();
  assert.equal(await preview.ready, false);
  assert.equal(await preview.update({ image: 'blocked' }), false);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(await ended, true);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  await hud.close();
});

test('renderer receives EOF when the owner exits without cleanup', { timeout: 5000 }, async () => {
  const readThroughEof = [
    "const fail = setTimeout(() => process.exit(2), 2000);",
    "let bytes = 0;",
    "process.stdin.on('data', chunk => { bytes += chunk.length; });",
    "process.stdin.on('end', () => { clearTimeout(fail); if (bytes > 4) console.log('renderer EOF'); });"
  ].join('\n');
  const owner = [
    'import { spawn } from "node:child_process";',
    'import { Hud } from ' + JSON.stringify(new URL('../lib/hud.mjs', import.meta.url).href) + ';',
    'const hud = new Hud({ enabled: true, spawn: () => spawn(process.execPath, ["-e", '
      + JSON.stringify(readThroughEof) + '], { stdio: ["pipe", process.stdout, "ignore"] }) });',
    'if (!await hud.begin().ready) process.exit(1);',
    'process.exit(0);'
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', owner], { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (data) => { output += data; });
  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0);
  assert.equal(output.trim(), 'renderer EOF');
});
