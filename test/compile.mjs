import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Compile tests that need a JRE but nothing else: the bundled jar must compile
 * a fixture with no mod checkout and no `javac`. CI runs this with Temurin 17,
 * which also proves the jar's `--release 17` target.
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

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

const plugin = await import('../index.js');

const routes = new Map();
const tools = [];
const ctx = {
  logger: { warn: (error) => console.warn('[warn]', error?.message ?? error) },
  effect: (fn) => fn(),
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

/* 1. The resolver prefers the bundled jar over compiling sources. */
step('resolveClasspath: bundled jar');
const resolved = await plugin.resolveClasspath({});
assert.equal(resolved.kind, 'bundled', `expected the bundled jar, got ${resolved.kind}`);
assert.equal(path.basename(resolved.classpath), 'mc-compiler.jar', 'classpath is the jar');
assert.ok(resolved.classpath.startsWith(path.resolve(HERE, '..')), 'jar lives inside the plugin');

step('resolveClasspath: explicit jar wins, missing jar is reported');
const explicit = await plugin.resolveClasspath({ jar: resolved.classpath });
assert.equal(explicit.kind, 'jar', 'explicit jar kind');
await assert.rejects(
  () => plugin.resolveClasspath({ jar: path.join(os.tmpdir(), 'nope.jar') }),
  /configured jar not found/,
  'missing explicit jar is an error',
);

/* 2. The compile route works with the jar alone (no sourceRoot configured). */
step('compile route: jar only');
plugin.apply(ctx, { root: FIXTURES, sourceRoot: path.join(os.tmpdir(), 'no-sources-here') });
const response = fakeRes();
await routes.get('/api/mc-compiler/compile').handler(fakeReq({ paths: ['smelter.mc'] }), response);
assert.equal(response.statusCode, 200, `status ${response.statusCode}: ${response.body}`);
const payload = JSON.parse(response.body);
assert.equal(payload.results.length, 1, 'one result');
assert.equal(payload.results[0].state, 'EXECUTABLE', 'smelter.mc is executable');
assert.equal(payload.results[0].module, '冶炼', 'module name decoded');
assert.deepEqual(payload.results[0].errors, [], 'no diagnostics');

/* 3. A broken script reports diagnostics through the same route. */
step('compile route: diagnostics');
const broken = fakeRes();
await routes
  .get('/api/mc-compiler/compile')
  .handler(fakeReq({ paths: ['broken.mc'] }), broken);
assert.equal(broken.statusCode, 200, 'diagnostics are not an HTTP error');
const brokenPayload = JSON.parse(broken.body);
assert.equal(brokenPayload.results[0].state, 'FAILED', 'broken.mc fails');
assert.ok(brokenPayload.results[0].errors.length >= 1, 'diagnostics returned');
assert.ok(
  brokenPayload.results[0].errors.every((error) => /^[A-Z]\d\d$/.test(error.code)),
  'codes look like S05/M02',
);

/* 4. The tool answers from the same jar. */
step('tool: jar only');
const result = await tools[0].execute({ all: true });
assert.ok(result.results.length >= 3, `expected every fixture, got ${result.results.length}`);
const states = Object.fromEntries(result.results.map((item) => [path.basename(item.file), item.state]));
assert.equal(states['smelter.mc'], 'EXECUTABLE', 'tool: executable');
assert.equal(states['library.mc'], 'DEPENDENCY', 'tool: dependency');
assert.equal(states['broken.mc'], 'FAILED', 'tool: failed');

console.log('\ncompile: ok');
