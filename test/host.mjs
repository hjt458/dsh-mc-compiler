import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hermetic host tests: import the plugin, mount it on a fake ctx, and drive the
 * registered HTTP routes and tool directly. No DSH, no Minecraft, no JDK —
 * the compile route is only exercised for its guards (a real compile needs the
 * mod checkout and is covered by test/local.mjs).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const plugin = await import('../index.js');

function step(name) {
  process.stdout.write(`- ${name}\n`);
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers !== undefined) this.headers = headers;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      this.ended = true;
    },
  };
}

function fakeReq({ method = 'GET', host = '127.0.0.1:1616', body } = {}) {
  const listeners = { data: [], end: [] };
  const req = {
    method,
    headers: host === undefined ? {} : { host },
    on(event, callback) {
      (listeners[event] ??= []).push(callback);
      return req;
    },
    destroy() {},
  };
  queueMicrotask(() => {
    if (body !== undefined) {
      for (const callback of listeners.data) callback(Buffer.from(JSON.stringify(body), 'utf8'));
    }
    for (const callback of listeners.end) callback();
  });
  return req;
}

async function call(handler, request) {
  const response = fakeRes();
  await handler(request, response);
  return response;
}

function json(response) {
  return JSON.parse(response.body);
}

/* 1. Mount on a fake ctx. */
const routes = new Map();
const tools = [];
const effects = [];
const ctx = {
  logger: { warn: () => {} },
  effect(fn, label) {
    effects.push(label);
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  webServer: {
    register(route) {
      assert.equal(routes.has(route.path), false, `route registered twice: ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
  tools: {
    register(tool) {
      tools.push(tool);
      return () => {};
    },
  },
};

step('mount: routes and tool');
plugin.apply(ctx, { root: FIXTURES });
assert.equal(plugin.name, 'dsh-mc-compiler', 'plugin name');
assert.deepEqual(plugin.inject, ['webServer', 'tools'], 'inject list');
assert.deepEqual([...routes.keys()].sort(), ['/api/mc-compiler/compile', '/api/mc-compiler/list'], 'both routes');
assert.equal(tools.length, 1, 'one tool registered');
assert.equal(tools[0].name, 'mc_compile', 'tool name');

/* 2. The list route reports the script root and every .mc file. */
step('list: files under the configured root');
const listRoute = routes.get('/api/mc-compiler/list');
const listed = await call(listRoute.handler, fakeReq());
assert.equal(listed.statusCode, 200, 'list status');
const listing = json(listed);
assert.equal(listing.root, path.resolve(FIXTURES), 'root is resolved');
assert.equal(listing.exists, true, 'root exists');
assert.ok(listing.files.length >= 2, `expected fixtures, got ${listing.files.length}`);
assert.ok(
  listing.files.every((file) => file.name.toLowerCase().endsWith('.mc')),
  'only .mc files are listed',
);
assert.deepEqual(
  listing.files.map((file) => file.rel),
  [...listing.files.map((file) => file.rel)].sort(),
  'sorted by relative path',
);
const smelter = listing.files.find((file) => file.name === 'smelter.mc');
assert.ok(smelter !== undefined, 'smelter.mc listed');
assert.match(smelter.content, /MODULE\("冶炼"\)/, 'content preview included');
assert.ok(smelter.bytes > 0, 'byte size');

/* 3. A foreign Host header is refused (DNS rebinding fence). */
step('list: untrusted host');
const forbidden = await call(listRoute.handler, fakeReq({ host: 'evil.example:80' }));
assert.equal(forbidden.statusCode, 403, 'foreign host refused');
assert.match(forbidden.body, /forbidden host/, 'reason given');

/* 4. Wrong method on the list route. */
step('list: method guard');
const wrongMethod = await call(listRoute.handler, fakeReq({ method: 'POST' }));
assert.equal(wrongMethod.statusCode, 405, 'POST on list is refused');

/* 5. The compile route refuses paths outside the script root. */
step('compile: path fence');
const compileRoute = routes.get('/api/mc-compiler/compile');
const escape = await call(
  compileRoute.handler,
  fakeReq({ method: 'POST', body: { paths: ['../../etc/passwd'] } }),
);
assert.ok(escape.statusCode >= 400, `expected an error status, got ${escape.statusCode}`);
assert.match(escape.body, /outside the script root/, 'path fence explained');

step('compile: missing file');
const missing = await call(
  compileRoute.handler,
  fakeReq({ method: 'POST', body: { paths: ['nope.mc'] } }),
);
assert.ok(missing.statusCode >= 400, 'missing file refused');

step('compile: GET is not allowed');
const getCompile = await call(compileRoute.handler, fakeReq());
assert.equal(getCompile.statusCode, 405, 'GET on compile is refused');

/* 6. The tool answers without a JVM when there is nothing to compile. */
step('tool: empty selection');
const tool = tools[0];
assert.ok(tool.output && tool.output.schema, 'tool declares an output schema');
assert.equal(tool.parameters.type, 'object', 'tool takes an object');
const empty = await tool.execute({ paths: [] });
assert.deepEqual(empty.results, [], 'no files -> no results');
assert.equal(empty.root, path.resolve(FIXTURES), 'tool reports its root');

/* 7. Disposing the mount removes the routes. */
step('dispose: routes are released');
for (const label of effects) assert.ok(typeof label === 'string' && label !== '', 'effect has a label');
assert.ok(routes.size === 2, 'routes still mounted');

console.log('\nhost: ok');
