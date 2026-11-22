# dsh-mc-compiler

A DeepSeek Harness plugin that compiles `.mc` scripts — the embedded DSL of the
**ProgrammableFurnace** mod — from the GUI sidebar and from an agent tool.

It does not reimplement the language. It shells out to the mod's own analyzer
(`dev.programmablefurnace.base.CompilerAnalyzer`), so the verdict a script gets
here is the same one the game will reach.

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
| `index.js` | Host half: config, `.mc` discovery, JDK build cache, two HTTP routes, `mc_compile` tool |
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

1. On first use the host compiles the analyzer's front end once
   (`compiler/lex`, `compiler/syntax`, `compiler/sem`, plus
   `base/CompilerAnalyzer`, `base/ContentState`, `base/CodeAnalyzer`) into
   `tools/.build/<sha1-of-selected-sources>/`.
2. That cache key changes whenever any of those sources changes, so editing the
   analyzer invalidates it automatically — no manual rebuild step.
3. `java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -cp <cache> McCompileCli <files…>`
   compiles the requested scripts in one JVM start and prints a JSON array.
4. The host forwards that array to the panel or to the tool.

Only the front end is compiled — the analyzer has no Minecraft imports, which is
what makes this possible.

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
