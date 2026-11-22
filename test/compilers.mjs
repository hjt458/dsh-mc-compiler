import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Compiler selection: the host lists candidate jars, the panel can switch
 * between them, and the choice lands in the profile's data directory.
 *
 * Hermetic — no mod checkout, no `javac`. The only requirement is a JRE, since
 * a switched jar is probed with a real (zero-file) compile.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
// A throwaway profile keeps the picker memory out of the real $HOME.
const PROFILE = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-profile-'));
process.env.DSH_PROFILE_DIR = PROFILE;
const SELECTION = path.join(PROFILE, 'data', 'mc-compiler', 'selection.json');
const plugin = await import('../index.js');
assert.equal(plugin.selectionPath(), SELECTION, 'selection lives under the profile');

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

async function mount(config) {
  const routes = new Map();
  const ctx = {
    logger: { warn: () => {} },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    tools: { register: () => () => {} },
  };
  plugin.apply(ctx, config);
  return routes;
}

async function call(handler, request) {
  const response = fakeRes();
  await handler(request, response);
  return { status: response.statusCode, body: JSON.parse(response.body || '{}') };
}

async function cleanup() {
  await fsp.rm(SELECTION, { force: true });
}

await cleanup();
const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-compiler-jars-'));
const extraJar = path.join(scratch, 'older.jar');
await fsp.copyFile(plugin.BUNDLED_JAR, extraJar);

try {
  /* 1. The bundled jar is always offered, and it names its own build. */
  step('listCompilers: the bundled jar leads');
  const listed = await plugin.listCompilers({});
  assert.equal(listed.items[0].role, 'bundled', 'bundled first');
  assert.equal(listed.items[0].path, plugin.BUNDLED_JAR, 'bundled path');
  assert.equal(listed.items[0].known, true, 'bundled jar has a manifest');
  assert.match(listed.items[0].commit, /^[0-9a-f]{7,}$/, 'commit looks like a hash');
  assert.ok(
    listed.dirs[0].endsWith(path.join('compiler', 'jars')),
    `default scan dir is compiler/jars, got ${listed.dirs[0]}`,
  );
  assert.equal(listed.selected, '', 'nothing selected yet');

  /* 2. Without a selection the bundled jar wins. */
  step('resolveClasspath: bundled by default');
  const byDefault = await plugin.resolveClasspath({});
  assert.equal(byDefault.kind, 'bundled', 'default kind');
  assert.equal(byDefault.classpath, plugin.BUNDLED_JAR, 'default classpath');

  /* 3. A jar dropped in a scanned directory becomes a candidate. */
  step('listCompilers: scans the configured directories');
  const config = { root: FIXTURES, jars: [scratch] };
  const scanned = await plugin.listCompilers(config);
  assert.equal(scanned.items.length, 2, `expected bundled + scanned, got ${scanned.items.length}`);
  const candidate = scanned.items.find((item) => item.role === 'dir');
  assert.ok(candidate, 'the dropped jar is listed');
  assert.equal(candidate.path, extraJar, 'candidate path');
  assert.equal(candidate.known, true, 'copied jar keeps its manifest');

  /* 4. The panel switches, and the choice is remembered on disk. */
  step('select: writes selection.json after probing the jar');
  const routes = await mount(config);
  const chosen = await call(routes.get('/api/mc-compiler/select').handler, {
    ...fakeReq({ method: 'POST', body: { jar: additionalJarPath(extraJar) } }),
  });
  assert.equal(chosen.status, 200, `select status ${chosen.status}: ${JSON.stringify(chosen.body)}`);
  assert.equal(chosen.body.selected, extraJar, 'selection echoes the jar');
  const persisted = JSON.parse(await fsp.readFile(SELECTION, 'utf8'));
  assert.equal(persisted.jar, extraJar, 'selection.json names the jar');

  const selected = await plugin.resolveClasspath(config);
  assert.equal(selected.kind, 'selected', 'selection beats the bundled jar');
  assert.equal(selected.classpath, extraJar, 'classpath is the chosen jar');

  /* 5. Compiling through the chosen jar still works end to end. */
  step('compile: the selected jar actually runs');
  const compiled = await call(routes.get('/api/mc-compiler/compile').handler, {
    ...fakeReq({ method: 'POST', body: { paths: ['smelter.mc'] } }),
  });
  assert.equal(compiled.status, 200, `compile status ${compiled.status}`);
  const first = compiled.body.results[0];
  assert.equal(first.state, 'EXECUTABLE', 'fixture compiles through the chosen jar');
  assert.equal(first.module, '冶炼', 'module name survives the switch');

  /* 6. A jar outside the candidate list cannot be smuggled in. */
  step('select: refuses a path that is not a candidate');
  const refused = await call(routes.get('/api/mc-compiler/select').handler, {
    ...fakeReq({ method: 'POST', body: { jar: path.join(os.tmpdir(), 'elsewhere.jar') } }),
  });
  assert.equal(refused.status, 400, 'unknown path is rejected');
  assert.match(refused.body.error, /not one of the candidates/, 'rejection explains itself');

  /* 7. Selecting the bundled jar clears the file again. */
  step('select: empty selection falls back to the bundled jar');
  const reset = await call(routes.get('/api/mc-compiler/select').handler, {
    ...fakeReq({ method: 'POST', body: { jar: '' } }),
  });
  assert.equal(reset.status, 200, `reset status ${reset.status}`);
  assert.equal(reset.body.selected, '', 'nothing selected');
  const backToBundled = await plugin.resolveClasspath(config);
  assert.equal(backToBundled.kind, 'bundled', 'back to the bundled jar');
  const cleared = JSON.parse(await fsp.readFile(SELECTION, 'utf8'));
  assert.equal(cleared.jar, '', 'selection.json records the fallback');

  /* 8. The compilers route reports what the panel needs. */
  step('compilers route: mirrors listCompilers');
  const overHttp = await call(routes.get('/api/mc-compiler/compilers').handler, fakeReq());
  assert.equal(overHttp.status, 200, 'compilers status');
  assert.equal(overHttp.body.items.length, 2, 'both candidates over HTTP');
  assert.equal(overHttp.body.selected, '', 'selection is reported');
} finally {
  await cleanup();
  await fsp.rm(scratch, { recursive: true, force: true });
  await fsp.rm(PROFILE, { recursive: true, force: true });
}

/** Keep the branch readable: the jar path is used verbatim. */
function additionalJarPath(jar) {
  return jar;
}

console.log('\ncompilers: ok');
