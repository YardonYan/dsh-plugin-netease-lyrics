/**
 * Regression guard for the boot-blocking bug fixed in 1.0.1.
 *
 * The client half is a browser bundle that registers itself on
 * `window.__ModuleLoader__`; the test stubs that facade, captures the
 * factory and drives `apply()` with several host contexts. The only
 * contract under test is that apply never throws: a throw fails the plugin
 * fiber and the host then refuses to boot the web app at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client.js');
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
};

let loadSeq = 0;

/** Import the bundle with a stubbed loader and return the plugin object. */
async function loadPlugin() {
  const previousWindow = globalThis.window;
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (mod) => { captured = mod; } } };
  try {
    loadSeq += 1;
    await import(`${pathToFileURL(clientPath).href}?case=${loadSeq}`);
  } finally {
    globalThis.window = previousWindow;
  }
  assert.ok(captured, 'client bundle did not register itself on the loader facade');
  return captured.factory((specifier) => {
    if (specifier === 'react') return reactStub;
    throw new Error(`unexpected require: ${specifier}`);
  });
}

/** Collects warnings instead of writing to a real logger. */
function logger() {
  const warnings = [];
  return { warnings, logger: { warn: (message) => warnings.push(String(message)) } };
}

test('does not declare a hard service dependency', async () => {
  const plugin = await loadPlugin();
  assert.equal(plugin.inject, undefined);
  assert.equal(typeof plugin.apply, 'function');
});

test('survives a host without slots, inject or effect', async () => {
  const plugin = await loadPlugin();
  assert.doesNotThrow(() => plugin.apply({}));
});

test('survives a host whose inject callback never fires', async () => {
  const plugin = await loadPlugin();
  let subscribed = null;
  const ctx = {
    effect: (factory) => { factory(); },
    inject: (deps, callback) => { subscribed = { deps, callback }; return () => {}; },
  };
  assert.doesNotThrow(() => plugin.apply(ctx));
  assert.deepEqual(subscribed.deps, ['slots']);
});

test('registers the dock once slots is available', async () => {
  const plugin = await loadPlugin();
  let registered = null;
  const slots = {
    inject: (name, callback) => { callback(); assert.equal(name, 'conversation.input.dock'); },
    register: (meta, component) => { registered = { meta, component }; },
  };
  const ctx = {
    effect: (factory) => { factory(); },
    inject: (deps, callback) => { callback({ slots }); return () => {}; },
  };
  plugin.apply(ctx, { anchorText: 'thinking for' });
  assert.ok(registered, 'dock was never registered');
  assert.equal(registered.meta.id, 'netease-lyrics');
  assert.equal(registered.meta.name, 'conversation.input.dock');
  assert.equal(typeof registered.component, 'function');
});

test('swallows a throwing slots implementation and warns', async () => {
  const plugin = await loadPlugin();
  const { warnings, logger: hostLogger } = logger();
  const slots = {
    inject: () => { throw new Error('boom'); },
    register: () => {},
  };
  const ctx = {
    logger: hostLogger,
    effect: (factory) => { factory(); },
    inject: (deps, callback) => { callback({ slots }); return () => {}; },
  };
  assert.doesNotThrow(() => plugin.apply(ctx));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /netease-lyrics: dock slot unavailable/);
});

test('falls back to a direct mount when deferral is unsupported', async () => {
  const plugin = await loadPlugin();
  let registered = null;
  const slots = {
    inject: (name, callback) => { callback(); },
    register: (meta) => { registered = meta; },
  };
  assert.doesNotThrow(() => plugin.apply({ slots }));
  assert.ok(registered, 'dock was never registered');
  assert.equal(registered.id, 'netease-lyrics');
});
