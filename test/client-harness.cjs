'use strict';

/**
 * Headless harness for the client half: provide a fake `window.__ModuleLoader__`
 * and a minimal React stub, capture what the plugin registers, and assert the
 * slot contracts the sidebar expects. No browser, no DSH.
 *
 * Run with: node test/client-harness.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'client.js');
const PANEL_ID = 'mc-compiler';

/* ---------- React stub: enough for module load, not for rendering ---------- */

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
};

/* ---------- fake loader + ctx ---------- */

const registered = [];
let plugin = null;

global.window = {
  __ModuleLoader__: {
    load(spec) {
      assert.equal(spec.id, 'dsh-mc-compiler', 'loader id is the package name');
      assert.equal(typeof spec.factory, 'function', 'factory is a function');
      // The real loader passes `require` only: no module/exports in scope.
      plugin = spec.factory((id) => {
        assert.equal(id, 'react', `unexpected require: ${id}`);
        return react;
      });
    },
  },
};

const slots = [];
const dictionaries = [];
const effects = [];

const ctx = {
  effect(fn, label) {
    effects.push(label);
    return fn();
  },
  locale: {
    register(namespace, dicts) {
      dictionaries.push({ namespace, dicts });
      return () => {};
    },
    bind(namespace) {
      const dict = dictionaries.find((entry) => entry.namespace === namespace);
      return (key) => dict?.dicts?.zh?.[key] ?? key;
    },
  },
  slots: {
    inject(name, factory) {
      slots.push({ injected: name });
      factory();
      return () => {};
    },
    register(options, Component) {
      registered.push({ options, Component });
      return () => {};
    },
  },
};

/* ---------- drive ---------- */

new Function('window', fs.readFileSync(SOURCE, 'utf8'))(global.window);

process.stdout.write('- loader: factory returns exports\n');
assert.ok(plugin !== null, 'factory ran');
assert.equal(typeof plugin.apply, 'function', 'apply exported');
assert.deepEqual(plugin.inject, ['slots', 'locale'], 'inject list');

plugin.apply(ctx);

process.stdout.write('- slots: sidebar row + main panel\n');
assert.deepEqual(
  slots.map((entry) => entry.injected),
  ['sidebar.panellist', 'main'],
  'injects both seats',
);
const row = registered.find((entry) => entry.options.name === 'sidebar.panellist');
const panel = registered.find((entry) => entry.options.name === 'main');
assert.ok(row !== undefined, 'sidebar row registered');
assert.equal(row.options.id, PANEL_ID, 'row id');
assert.equal(typeof row.options.label, 'function', 'row label is a function');
assert.equal(row.options.label(), 'MC 编译', 'row label resolves through zh');
assert.equal(row.options.locale, 'dsh-mc-compiler', 'row locale namespace');
assert.equal(typeof row.Component, 'function', 'row has an icon component');

assert.ok(panel !== undefined, 'main panel registered');
assert.equal(panel.options.key, PANEL_ID, 'panel key matches the row id');
assert.equal(typeof panel.Component, 'function', 'panel has a component');

process.stdout.write('- locale: dictionaries registered\n');
assert.equal(dictionaries.length, 1, 'one dictionary bundle');
const { dicts } = dictionaries[0];
for (const key of ['entry.label', 'panel.compileAll', 'panel.refresh', 'state.EXECUTABLE']) {
  assert.ok(dicts.zh[key] !== undefined, `zh dictionary has ${key}`);
  assert.ok(dicts.en[key] !== undefined, `en dictionary has ${key}`);
}

process.stdout.write('- effects: labelled for disposal\n');
assert.ok(effects.length >= 2, `expected labelled effects, got ${effects.length}`);
assert.ok(effects.every((label) => typeof label === 'string' && label.length > 0), 'every effect labelled');

console.log('\nclient: ok');
