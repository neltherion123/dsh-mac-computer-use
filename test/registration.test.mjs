import assert from 'node:assert/strict';
import { test } from 'node:test';

async function register(native) {
  if (native) delete process.env.DSH_MAC_CUA_NATIVE;
  else process.env.DSH_MAC_CUA_NATIVE = '0';
  const { apply } = await import('../index.mjs?native=' + native);
  let tool;
  let prompt;
  const cleanup = [];
  apply({
    agents: {}, on() {}, effect: (start) => cleanup.push(start()),
    tools: { register: (value) => { tool = value; }, definitions: () => [tool] },
    systemPrompt: { section: (section) => { prompt = section; } }
  });
  try { return { tool, text: prompt.text() }; }
  finally { for (const dispose of cleanup.reverse()) await dispose?.(); }
}

test('tool registration exposes Codex-style native controls by default and supports explicit disable', { skip: process.platform !== 'darwin' }, async () => {
  const disabled = await register(false);
  assert.equal(disabled.tool.name, 'mac_computer_use');
  assert.ok(disabled.tool.parameters.properties.action.enum.includes('browser_open'));
  assert.ok(disabled.tool.parameters.properties.action.enum.includes('browser_observe'));
  assert.deepEqual(disabled.tool.parameters.properties.clickCount.enum, [1, 2]);
  assert.ok(!disabled.tool.parameters.properties.action.enum.includes('open_app'));
  assert.match(disabled.text, /native app support disabled/);
  await assert.rejects(disabled.tool.execute({ action: 'open_app' }), /INVALID_ARGUMENT/);

  const enabled = await register(true);
  assert.ok(enabled.tool.parameters.properties.action.enum.includes('open_app'));
  assert.ok(enabled.tool.parameters.properties.action.enum.includes('drag'));
  assert.ok(enabled.tool.parameters.properties.action.enum.includes('paste'));
  assert.match(enabled.text, /task-scoped consent/);
});
