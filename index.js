/**
 * dsh-mc-compiler — Host half.
 *
 * Compiles ProgrammableFurnace `.mc` scripts with the mod's own compiler
 * front-end. The front-end (`lex`, `syntax`, `sem` plus `CompilerAnalyzer`)
 * imports nothing from Minecraft, so it can be built with plain `javac` and
 * driven from a small CLI (`tools/McCompileCli.java`) instead of a game
 * instance. This file owns everything that touches the filesystem or a
 * subprocess:
 *
 *   GET  /api/mc-compiler/list     scan the script root for `*.mc` files
 *   POST /api/mc-compiler/compile  compile the requested files, return states
 *                                  and diagnostics
 *   tool `mc_compile`              the same compile path, callable by an agent
 *
 * Build caching: the compiler sources are hashed by content; a hash change
 * rebuilds `tools/.build/<hash>/` once and later compiles reuse it. Nothing is
 * written next to the mod's own sources.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable cordis plugin name (must match the package name). */
export const name = 'dsh-mc-compiler';

/** Services that must be up before the routes and the tool can mount. */
export const inject = ['webServer', 'tools'];

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(here, 'tools');
const CLI_SOURCE = path.join(TOOLS_DIR, 'McCompileCli.java');

const ROUTES = {
  list: '/api/mc-compiler/list',
  compile: '/api/mc-compiler/compile',
};

/** Default script directory: the sample programs shipped by the mod. */
const DEFAULT_ROOT = 'D:/MODS/ProgrammableFurnace/src/main/resources/programmablefurnace/scripts';

/** Default compiler source root (the mod's `src/main/java`). */
const DEFAULT_SOURCE_ROOT = 'D:/MODS/ProgrammableFurnace/src/main/java';

/** Package root of the mod inside `src/main/java`. */
const PACKAGE_ROOT = 'dev/programmablefurnace';

/** Compiler packages that carry the language front-end. */
const FRONTEND_DIRS = [
  `${PACKAGE_ROOT}/compiler/lex`,
  `${PACKAGE_ROOT}/compiler/syntax`,
  `${PACKAGE_ROOT}/compiler/sem`,
];

/** Front-end files that live outside those packages. */
const FRONTEND_FILES = [
  `${PACKAGE_ROOT}/base/CompilerAnalyzer.java`,
  `${PACKAGE_ROOT}/base/ContentState.java`,
  `${PACKAGE_ROOT}/base/CodeAnalyzer.java`,
];

/** Source text handed to the panel per file; larger files are truncated. */
const MAX_PREVIEW_CHARS = 20_000;

/** Hard cap on files scanned in one request. */
const MAX_FILES = 500;

/** Body cap for the compile route (path lists only, so tiny). */
const MAX_BODY_BYTES = 256 * 1024;

const JAVAC_TIMEOUT_MS = 180_000;
const JAVA_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** True when `file` resolves to a path inside `root` (defends `..` traversal). */
function isInside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Trust fence: the routes expose local paths and spawn a compiler, so a foreign
 * Host header (DNS rebinding) is refused. A request without a Host header comes
 * from the in-app bridge and passes.
 */
function isTrustedHost(header) {
  if (typeof header !== 'string' || header === '') return true;
  const text = header.toLowerCase();
  const name = text.startsWith('[') ? text.slice(1, text.indexOf(']')) : text.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function rejectUntrusted(req, res, allowed) {
  if (!isTrustedHost(req.headers.host)) {
    sendJson(res, 403, { error: 'forbidden host' });
    return true;
  }
  const method = req.method ?? 'GET';
  if (!allowed.includes(method)) {
    res.writeHead(405, { allow: allowed.join(', ') });
    res.end();
    return true;
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function warn(ctx, error) {
  const logger = ctx?.logger;
  if (logger && typeof logger.warn === 'function') logger.warn(error);
  else console.warn('[mc-compiler]', error);
}

// ---------------------------------------------------------------------------
// Script discovery
// ---------------------------------------------------------------------------

function scriptRoot(config) {
  const configured = typeof config?.root === 'string' ? config.root.trim() : '';
  return path.resolve(configured === '' ? DEFAULT_ROOT : configured);
}

/** Walk `root` for `*.mc` files, sorted by relative path. */
async function listScripts(root, withContent) {
  const files = [];
  async function walk(dir, depth) {
    if (files.length >= MAX_FILES || depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.mc')) continue;
      let stat = null;
      try {
        stat = await fs.stat(full);
      } catch {
        stat = null;
      }
      const item = {
        path: full,
        rel: path.relative(root, full).split(path.sep).join('/'),
        name: entry.name,
        bytes: stat ? stat.size : 0,
        updatedAt: stat ? Math.round(stat.mtimeMs) : 0,
      };
      if (withContent) {
        try {
          const raw = await fs.readFile(full, 'utf8');
          item.content = raw.length > MAX_PREVIEW_CHARS ? raw.slice(0, MAX_PREVIEW_CHARS) : raw;
          item.truncated = raw.length > MAX_PREVIEW_CHARS;
        } catch (error) {
          item.content = '';
          item.truncated = false;
          item.readError = String(error?.message ?? error);
        }
      }
      files.push(item);
    }
  }
  await walk(root, 0);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

// ---------------------------------------------------------------------------
// Compiler build (javac once per source hash) + one compile run
// ---------------------------------------------------------------------------

let buildInFlight = null;

async function collectFrontendSources(sourceRoot) {
  const files = [];
  for (const dir of FRONTEND_DIRS) {
    const full = path.join(sourceRoot, dir);
    let entries;
    try {
      entries = await fs.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.java')) files.push(path.join(full, entry.name));
    }
  }
  for (const rel of FRONTEND_FILES) {
    const full = path.join(sourceRoot, rel);
    if (await exists(full)) files.push(full);
  }
  files.sort();
  return files;
}

function javaBin(config) {
  const configured = typeof config?.javaBin === 'string' ? config.javaBin.trim() : '';
  return configured === '' ? 'java' : configured;
}

function javacBin(config) {
  const configured = typeof config?.javacBin === 'string' ? config.javacBin.trim() : '';
  if (configured !== '') return configured;
  const java = javaBin(config);
  if (path.isAbsolute(java)) {
    const candidate = path.join(path.dirname(java), process.platform === 'win32' ? 'javac.exe' : 'javac');
    return candidate;
  }
  return 'javac';
}

function run(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim() || String(stdout || '').trim() || error.message;
          reject(new Error(`${file} failed: ${detail.split(/\r?\n/).slice(0, 12).join('\n')}`));
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });
}

/** Build the CLI once per distinct compiler-source content, reuse afterwards. */
async function ensureClasses(config) {
  const sourceRoot = path.resolve(
    typeof config?.sourceRoot === 'string' && config.sourceRoot.trim() !== ''
      ? config.sourceRoot
      : DEFAULT_SOURCE_ROOT,
  );
  const sources = await collectFrontendSources(sourceRoot);
  if (sources.length === 0) {
    throw new Error(`no compiler sources under ${sourceRoot} (expected ${FRONTEND_DIRS.join(', ')})`);
  }
  const hash = createHash('sha1');
  for (const source of sources) {
    hash.update(path.basename(source));
    hash.update('\u0000');
    hash.update(await fs.readFile(source));
    hash.update('\u0000');
  }
  hash.update(await fs.readFile(CLI_SOURCE));
  const key = hash.digest('hex').slice(0, 16);
  const outDir = path.join(TOOLS_DIR, '.build', key);
  const marker = path.join(outDir, '.built');
  if (await exists(marker)) return outDir;

  if (buildInFlight) {
    await buildInFlight;
    if (await exists(marker)) return outDir;
  }

  buildInFlight = (async () => {
    await fs.mkdir(outDir, { recursive: true });
    const args = [
      '-encoding', 'UTF-8',
      '-nowarn',
      '-d', outDir,
      '-sourcepath', sourceRoot,
      ...sources,
      CLI_SOURCE,
    ];
    await run(javacBin(config), args, JAVAC_TIMEOUT_MS);
    await fs.writeFile(marker, `sources=${sources.length}\n`, 'utf8');
  })();
  try {
    await buildInFlight;
  } finally {
    buildInFlight = null;
  }
  return outDir;
}

/** Compile the given files; returns the CLI's parsed JSON array. */
async function compilePaths(files, config) {
  if (files.length === 0) return [];
  const classes = await ensureClasses(config);
  const args = [
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-cp', classes,
    'McCompileCli',
    ...files,
  ];
  const { stdout } = await run(javaBin(config), args, JAVA_TIMEOUT_MS);
  const text = stdout.trim();
  const start = text.indexOf('[');
  if (start < 0) throw new Error(`compiler produced no JSON: ${text.slice(0, 400)}`);
  return JSON.parse(text.slice(start));
}

/** Map request paths onto real `.mc` files inside `root`. */
async function resolveRequested(root, request) {
  const all = request?.all === true;
  const requested = Array.isArray(request?.paths) ? request.paths : [];
  if (all || requested.length === 0) {
    const found = await listScripts(root, false);
    return all ? found.map((item) => item.path) : [];
  }
  const available = await listScripts(root, false);
  const allowed = new Map(available.map((item) => [path.resolve(item.path), item]));
  const picked = [];
  for (const raw of requested) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const full = path.resolve(root, raw);
    const known = allowed.get(full);
    if (!known) {
      if (!isInside(root, full) || !full.toLowerCase().endsWith('.mc')) {
        throw new Error(`path is outside the script root: ${raw}`);
      }
      if (!(await exists(full))) throw new Error(`file not found: ${raw}`);
      picked.push(full);
      continue;
    }
    picked.push(known.path);
  }
  return [...new Set(picked)];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function listHandler(ctx, config) {
  return async (req, res) => {
    if (rejectUntrusted(req, res, ['GET', 'HEAD'])) return;
    const root = scriptRoot(config);
    try {
      const files = await listScripts(root, true);
      sendJson(res, 200, { root, exists: await exists(root), files });
    } catch (error) {
      warn(ctx, error);
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  };
}

function compileHandler(ctx, config) {
  return async (req, res) => {
    if (rejectUntrusted(req, res, ['POST'])) return;
    const root = scriptRoot(config);
    try {
      const body = await readBody(req);
      const files = await resolveRequested(root, body);
      const results = await compilePaths(files, config);
      sendJson(res, 200, { root, results });
    } catch (error) {
      warn(ctx, error);
      sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  };
}

// ---------------------------------------------------------------------------
// Agent tool
// ---------------------------------------------------------------------------

const TOOL_NAME = 'mc_compile';

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Script paths (absolute, or relative to the script root) to compile. Omit together with all:true to compile every .mc file under the root.',
    },
    all: {
      type: 'boolean',
      description: 'Compile every .mc file under the script root.',
    },
  },
  additionalProperties: false,
};

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['root', 'results'],
    properties: {
      root: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['file', 'state', 'module', 'errors'],
          properties: {
            file: { type: 'string' },
            state: { type: 'string' },
            module: { type: 'string' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'line', 'col', 'message'],
                properties: {
                  code: { type: 'string' },
                  line: { type: 'number' },
                  col: { type: 'number' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
  // The host calls `render(args, value)`; keep the fallback so calling it with
  // the value alone (as in a unit check) still works.
  render(args, value) {
    const payload = value && typeof value === 'object' && 'results' in value ? value : args;
    const results = payload?.results;
    if (!Array.isArray(results) || results.length === 0) {
      return [{ type: 'text', text: '没有编译任何文件。' }];
    }
    const lines = [];
    for (const item of results) {
      const label = String(item.file || '').split(/[\\/]/).pop() || item.file;
      lines.push(`${label}  ${item.state}${item.module ? `  (${item.module})` : ''}`);
      for (const error of item.errors || []) {
        lines.push(`  ${error.code} ${error.message} @ ${error.line}:${error.col}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
};

function buildTool(config) {
  return {
    name: TOOL_NAME,
    description:
      'Compile ProgrammableFurnace .mc scripts with the mod\'s own compiler front-end and return each file\'s state (EXECUTABLE / DEPENDENCY / FAILED / BLANK) plus diagnostics (error code, line, column, message). Use it to check .mc scripts without starting Minecraft.',
    parameters: TOOL_PARAMETERS,
    output: TOOL_OUTPUT,
    async execute(args) {
      const root = scriptRoot(config);
      const files = await resolveRequested(root, args ?? {});
      if (files.length === 0) {
        return { root, results: [] };
      }
      const results = await compilePaths(files, config);
      return {
        root,
        results: results.map((item) => ({
          file: String(item.file ?? ''),
          state: String(item.state ?? 'FAILED'),
          module: String(item.module ?? ''),
          errors: (item.errors ?? []).map((error) => ({
            code: String(error.code ?? ''),
            line: Number(error.line ?? 0),
            col: Number(error.col ?? 0),
            message: String(error.message ?? ''),
          })),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Mount the routes and the tool. Config:
 * `root` (script directory), `sourceRoot` (mod `src/main/java`), `javaBin`,
 * `javacBin`.
 */
export function apply(ctx, config = {}) {
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: ROUTES.list, handler: listHandler(ctx, config) }),
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTES.compile,
        handler: compileHandler(ctx, config),
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'mc-compiler: routes');

  // A tool registration failure must not take the panel down with it.
  try {
    ctx.effect(() => {
      const dispose = ctx.tools.register(buildTool(config));
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    }, 'mc-compiler: tool');
  } catch (error) {
    warn(ctx, error);
  }
}
