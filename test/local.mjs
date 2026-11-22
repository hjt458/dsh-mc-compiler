import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Checks that need a real mod checkout plus a JDK: the compile route and the
 * tool actually run javac/java. CI skips this file; `npm test` runs it locally
 * and prints a skip when the checkout is missing.
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

const DEFAULT_MOD = 'D:/MODS/ProgrammableFurnace';
const modRoot = process.env.MC_MOD_ROOT || DEFAULT_MOD;
const sourceRoot = path.join(modRoot, 'src/main/java');

const { promises: fs } = await import('node:fs');

const hasCheckout = await fs
  .access(path.join(sourceRoot, 'dev/programmablefurnace/base/CompilerAnalyzer.java'))
  .then(() => true)
  .catch(() => false);

if (!hasCheckout) {
  console.log(`local: skipped (no mod checkout at ${modRoot})`);
  process.exit(0);
}

function step(name) {
  process.stdout.write(`- ${name}\n`);
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) {
      this.statusCode = status;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
    },
  };
}

function fakeReq(body) {
  const listeners = { data: [], end: [] };
  const req = {
    method: 'POST',
    headers: { host: '127.0.0.1:1616' },
    on(event, callback) {
      (listeners[event] ??= []).push(callback);
      return req;
    },
    destroy() {},
  };
  queueMicrotask(() => {
    for (const callback of listeners.data) callback(Buffer.from(JSON.stringify(body), 'utf8'));
    for (const callback of listeners.end) callback();
  });
  return req;
}

const routes = new Map();
const tools = [];
const ctx = {
  logger: { warn: (error) => console.warn('[warn]', error?.message ?? error) },
  effect(fn) {
    return fn();
  },
  webServer: {
    register(route) {
      routes.set(route.path, route);
      return () => {};
    },
  },
  tools: {
    register(tool) {
      tools.push(tool);
      return () => {};
    },
  },
};

const plugin = await import('../index.js');
plugin.apply(ctx, { root: FIXTURES, sourceRoot });

step('compile route: real javac + java');
const response = fakeRes();
await routes.get('/api/mc-compiler/compile').handler(fakeReq({ paths: ['smelter.mc'] }), response);
assert.equal(response.statusCode, 200, `status ${response.statusCode}: ${response.body}`);
const payload = JSON.parse(response.body);
assert.equal(payload.results.length, 1, 'one result');
assert.equal(payload.results[0].state, 'EXECUTABLE', 'smelter.mc is executable');
assert.equal(payload.results[0].module, '冶炼', 'module name decoded');
assert.deepEqual(payload.results[0].errors, [], 'no diagnostics');

step('tool: real compile');
const result = await tools[0].execute({ paths: ['smelter.mc'] });
assert.equal(result.results.length, 1, 'tool returned one file');
assert.equal(result.results[0].state, 'EXECUTABLE', 'tool sees the same state');

step('tool: output schema renders');
const rendered = tools[0].output.render({ paths: ['smelter.mc'] }, result);
assert.ok(Array.isArray(rendered) && rendered.length > 0, 'render returns blocks');
const text = rendered.map((block) => block.text ?? '').join('\n');
assert.match(text, /EXECUTABLE/, 'render mentions the state');
assert.match(text, /冶炼/, 'render mentions the module');

console.log('\nlocal: ok');
