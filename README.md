# dsh-mc-compiler

[![CI](https://github.com/hjt458/dsh-mc-compiler/actions/workflows/ci.yml/badge.svg)](https://github.com/hjt458/dsh-mc-compiler/actions/workflows/ci.yml)

A DeepSeek Harness plugin that compiles `.mc` scripts — the embedded DSL of the
**ProgrammableFurnace** mod — from the GUI sidebar and from an agent tool.

It does not reimplement the language. It runs the mod's own analyzer
(`dev.programmablefurnace.base.CompilerAnalyzer`) — bundled as
`compiler/mc-compiler.jar`, so no mod checkout and no JDK are needed — and the
verdict a script gets here is the same one the game will reach.

## What you get

- A sidebar row **MC compiler** (below *Skill board*) with a panel that lists
  every `.mc` file under the configured scripts directory.
- Per-file **Compile** plus **Compile all**, showing the resulting `ContentState`
  (`EXECUTABLE` / `DEPENDENCY` / `FAILED` / `BLANK` / `READONLY`), the module
  name, and every diagnostic as `code line:col message`.
- An agent tool `mc_compile` with the same behaviour, so the model can compile a
  script while editing it and read the diagnostics back.

## Files

| Path | Role |
| --- | --- |
| `index.js` | Host half: config, `.mc` discovery, compiler selection (jar or `javac` fallback), two HTTP routes, `mc_compile` tool |
| `compiler/mc-compiler.jar` | Prebuilt front end + CLI driver; `provenance.json` records where it came from |
| `client.js` | Client half: zero-JSX React panel, sidebar row registration (`window.__ModuleLoader__`) |
| `tools/McCompileCli.java` | Standalone driver for `CompilerAnalyzer`; prints JSON, one entry per file |
| `cordis.patch.yml` | Inserts this plugin into the profile |
| `locale/{en,zh}.json` | Plugin metadata (`meta.title` / `description` / `detail`) |
| `icon.svg` | Sidebar icon |

## Configuration

The plugin reads two paths. Both default to the author's checkout, so set them
when installing elsewhere:

```yaml
# <profile>/cordis.patch.yml — inside the inserted plugin row
- id: mc-compiler
  name: dsh-mc-compiler
  config:
    # Directory scanned for *.mc, recursively.
    root: D:/MODS/ProgrammableFurnace/src/main/resources/programmablefurnace/scripts
    # Java source root that contains dev/programmablefurnace/**.
    sourceRoot: D:/MODS/ProgrammableFurnace/src/main/java
```

Requirements: a JDK on `PATH` (`javac` and `java`). Developed and tested against
JDK 25.

## How compiling works

The compiler is picked in this order:

1. **`jar` config** — a jar you point at explicitly.
2. **Bundled `compiler/mc-compiler.jar`** — 93 KB, built from the mod's own
   front end (`compiler/lex`, `compiler/syntax`, `compiler/sem`, plus
   `base/CompilerAnalyzer`, `base/ContentState`, `base/CodeAnalyzer`). This is
   the default, so the plugin works on a machine with **no mod checkout and no
   JDK** — only a JRE 17+ is needed to run the compiler.
3. **Compile from sources** — the fallback: `javac` builds the front end into
   `tools/.build/<sha1-of-sources>/` on first use. The cache key changes when any
   source changes, so editing the analyzer invalidates it automatically.

Either way the host runs
`java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -cp <jar-or-classes> McCompileCli <files…>`,
one JVM start per request, and forwards the JSON array to the panel or the tool.

Only the front end is involved — the analyzer has no Minecraft imports, which is
what makes this possible.

The jar is byte-identical to the one shipped by
[`vscode-mc-compiler`](https://github.com/hjt458/vscode-mc-compiler) and carries
its provenance in `compiler/provenance.json` / `compiler/PROVENANCE.md`
(upstream commit, javac version, source list, SHA-256). To rebuild it:

```bash
node tools/build-compiler.mjs   # from a vscode-mc-compiler checkout
```

## HTTP routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/mc-compiler/list` | GET | `{ root, files: [{ name, rel, path, bytes, content, truncated }] }` |
| `/api/mc-compiler/compile` | POST | Body `{ paths: string[] }` or `{ all: true }` → `{ results: [...] }` |

Requests are restricted to loopback hosts, and `paths` must stay inside `root`.

## Pitfalls worth knowing

- **A client bundle receives `require` only.** The loader calls
  `factory(this.makeRequire(...))` — there is no `module` or `exports` in scope.
  Return the plugin exports directly (`return { apply, inject }`). Writing
  `module.exports = …` throws a `ReferenceError`, and the failure is silent apart
  from `entry did not activate` in `~/.dsh/logs/desktop-next.log`.
- **Client URLs are document-relative** (`api/mc-compiler/list`), because the GUI
  is served with `<base href="./">`; host routes keep the leading slash.
- **Java output needs an explicit encoding.** Without
  `-Dstdout.encoding=UTF-8` Chinese identifiers and messages come back as
  replacement characters.
- Test the halves separately: the host with a fake `ctx` (call the handlers
  directly) and the client with a module harness that stubs
  `window.__ModuleLoader__` and `require('react')`.

## Install

```
plugin_manager: install_bundle, target: <absolute path to this directory>
```

The profile links the package into `node_modules`, so subsequent edits to
`client.js` are picked up by the client's file watcher and edits to `index.js`
need a restart.

## Uninstall

`plugin_manager: remove_bundle` with the package name, or delete the inserted row
from the profile's `cordis.patch.yml`.

## Tests

```bash
npm test          # everything, including the javac fallback (needs the mod checkout)
npm run test:ci   # host + client + compile through the bundled jar (needs only a JRE)
```

`test/host.mjs` imports `index.js`, mounts it on a fake ctx, and drives the two
routes plus the tool: file listing, the foreign-`Host` fence, method guards, the
path fence, and the "nothing to compile" answer. `test/client-harness.cjs`
fakes `window.__ModuleLoader__` and `react`, then asserts the sidebar row, the
main panel key, and the dictionaries. `test/compile.mjs` compiles the fixtures through the bundled jar while pointing
`sourceRoot` at a directory that does not exist — if the jar were not used, the
run would fail. `test/local.mjs` builds the front end with `javac` (the fallback)
and compiles against the real mod checkout; it prints `local: skipped` when
`D:/MODS/ProgrammableFurnace` is absent, so CI can run it safely.

## License

[MIT](LICENSE) © 2026 hjt458
