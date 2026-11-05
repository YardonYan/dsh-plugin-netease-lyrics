/**
 * Regression guards for the activation failures fixed in 1.0.1 and 1.0.2.
 *
 * The host treats a failing client plugin as fatal: a single throw from
 * apply() fails the fiber and the whole web app then refuses to boot. The
 * client half is a browser bundle that registers itself on
 * `window.__ModuleLoader__`, so the tests stub that facade, capture the
 * factory and drive apply() with several host contexts, including a hostile
 * context that throws on any property access, which is how the cordis
 * context behaves during early boot.
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

/** Capture console.warn for the duration of one test. */
function captureWarnings() {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => { calls.push(args.map(String).join(' ')); };
  calls.restore = () => { console.warn = original; };
  return calls;
}

/** A host whose slots service already exists; records what got registered. */
function hostWithSlots(record) {
  const slots = {
    inject: (name, callback) => { callback(); assert.equal(name, 'conversation.input.dock'); },
    register: (meta, component) => { record.meta = meta; record.component = component; },
  };
  return {
    effect: (factory) => { factory(); },
    inject: (deps, callback) => { callback({ slots }); return () => {}; },
  };
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

test('registers the dock and forwards anchorText once slots is available', async () => {
  const plugin = await loadPlugin();
  const record = {};
  plugin.apply(hostWithSlots(record), { anchorText: 'thinking for' });
  assert.ok(record.meta, 'dock was never registered');
  assert.equal(record.meta.id, 'netease-lyrics');
  assert.equal(record.meta.name, 'conversation.input.dock');
  assert.equal(typeof record.component, 'function');
  // The wrapper only builds an element, so calling it never runs the lyrics
  // component itself; it just proves the config value reached the dock.
  assert.equal(record.component({}).props.anchorText, 'thinking for');
});

test('falls back to the built-in anchor when config is absent or malformed', async () => {
  const plugin = await loadPlugin();
  for (const config of [undefined, {}, { anchorText: '   ' }, { anchorText: 42 }]) {
    const record = {};
    plugin.apply(hostWithSlots(record), config);
    assert.equal(record.component({}).props.anchorText, '深度求索中，用时');
  }
});

test('swallows a throwing slots implementation and warns', async () => {
  const plugin = await loadPlugin();
  const warnings = captureWarnings();
  try {
    const slots = { inject: () => { throw new Error('boom'); }, register: () => {} };
    const ctx = {
      effect: (factory) => { factory(); },
      inject: (deps, callback) => { callback({ slots }); return () => {}; },
    };
    assert.doesNotThrow(() => plugin.apply(ctx));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[netease-lyrics\] dock slot unavailable/);
  } finally {
    warnings.restore();
  }
});

test('falls back to a direct mount when deferral is unsupported', async () => {
  const plugin = await loadPlugin();
  const record = {};
  const slots = {
    inject: (name, callback) => { callback(); },
    register: (meta) => { record.meta = meta; },
  };
  assert.doesNotThrow(() => plugin.apply({ slots }));
  assert.ok(record.meta, 'dock was never registered');
  assert.equal(record.meta.id, 'netease-lyrics');
});

test('never reads config or options off the host context', async () => {
  const plugin = await loadPlugin();
  const accessed = [];
  const record = {};
  const slots = {
    inject: (name, callback) => { callback(); },
    register: (meta) => { record.meta = meta; },
  };
  const ctx = new Proxy({}, {
    get(target, prop) {
      accessed.push(String(prop));
      if (prop === 'effect') return (factory) => { factory(); };
      if (prop === 'inject') return (deps, callback) => { callback({ slots }); return () => {}; };
      return undefined;
    },
  });
  plugin.apply(ctx, { anchorText: 'thinking for' });
  assert.ok(record.meta, 'dock was never registered');
  // 1.0.0 and 1.0.1 probed ctx.config / ctx.options here; that read throws
  // during early boot and took the whole host down with it.
  for (const forbidden of ['config', 'options', 'plugin']) {
    assert.ok(!accessed.includes(forbidden), `apply read ctx.${forbidden}: [${accessed.join(', ')}]`);
  }
});

test('survives a context that throws on any property access', async () => {
  const plugin = await loadPlugin();
  const warnings = captureWarnings();
  try {
    const ctx = new Proxy({}, {
      get(target, prop) {
        throw new TypeError(`illegal access to ctx.${String(prop)} during early boot`);
      },
    });
    assert.doesNotThrow(() => plugin.apply(ctx, { anchorText: 'thinking for' }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[netease-lyrics\] activation degraded/);
  } finally {
    warnings.restore();
  }
});
