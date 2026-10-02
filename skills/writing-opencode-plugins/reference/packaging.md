Verified against OpenCode v2.0.20 (@opencode/plugin 2.0.20).

# Package, load, and verify a plugin

## Choose entrypoints and pin the SDK

Run `opencode --version`, then pin the authoring SDK to that release. For this reference, use `@opencode/plugin: "2.0.20"`. Check the package and lockfile resolved **from the plugin directory**, including workspace peers. A successful typecheck against an old SDK does not prove compatibility with the host.

| Runtime or shared contract | Import |
| --- | --- |
| Promise server | `@opencode/plugin` |
| Effect server | `@opencode/plugin/effect` |
| Terminal | `@opencode/plugin/tui` |
| RPC contract | `@opencode/plugin/rpc` |
| Entrypoint resolver | `@opencode/plugin/host` |

Use the V2 package name. `@opencode-ai/plugin` is the V1 API shown in the migration guide; broad or wildcard declarations and stale lockfiles can leave a plugin resolving that old package. Verify the installed manifest and its exported subpaths rather than copying a dependency from an older plugin.

Server modules default-export `Plugin.define({ id, setup })`, or the Effect definition with `effect`. TUI modules default-export the TUI definition with `id` and `setup`. Give the plugin a stable ID; IDs identify status and storage namespaces. See [server.md](server.md), [tui.md](tui.md), and [rpc.md](rpc.md).

### Server-only package

This raw-TS layout targets the Bun loader. `index.ts` is also a conventional local entrypoint.

```json
{
  "name": "opencode-example-server",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.ts",
  "files": ["index.ts"],
  "exports": { ".": "./index.ts", "./server": "./index.ts" },
  "dependencies": { "@opencode/plugin": "2.0.20" }
}
```

`index.ts`:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example.package",
  async setup(ctx) {
    await ctx.storage.set("loaded", true)
    return () => ctx.storage.remove("loaded")
  },
})
```

### TUI-only package

Export only `./tui`. A root server entrypoint is unnecessary for a TUI-only package.

```json
{
  "name": "opencode-example-tui",
  "version": "0.1.0",
  "type": "module",
  "files": ["tui.ts"],
  "exports": { "./tui": "./tui.ts" },
  "dependencies": { "@opencode/plugin": "2.0.20" }
}
```

`tui.ts`:

```ts
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "example.package.tui",
  setup(ctx) {
    ctx.ui.toast.show({ message: "Plugin loaded", variant: "info" })
  },
})
```

For JSX, declare host UI peers: `@opentui/core: ">=0.5.12"`, `@opentui/solid: ">=0.5.12"`, and `solid-js: ">=1.9.0"`. Add `@opencode/theme: "2.0.20"` if imported. These versions match the published SDK's peer declarations. Keep host UI modules external when compiling; inspect [tui.md](tui.md) for component ownership and JSX setup.

### Combined package

Expose the server, terminal, and inert shared RPC contract separately. This manifest matches the complete example in [rpc.md](rpc.md); omit `./rpc` and Zod when the package has no shared contract.

```json
{
  "name": "opencode-example-counter",
  "version": "0.1.0",
  "type": "module",
  "main": "./server.ts",
  "files": ["server.ts", "tui.ts", "rpc.ts"],
  "exports": {
    ".": "./server.ts",
    "./server": "./server.ts",
    "./tui": "./tui.ts",
    "./rpc": "./rpc.ts"
  },
  "dependencies": { "@opencode/plugin": "2.0.20", "zod": "4.1.8" }
}
```

### Resolve local and installed entrypoints correctly

| Target | Server lookup | Terminal lookup | Contract lookup |
| --- | --- | --- | --- |
| Installed named package | `<name>/server`, then `<name>` | `<name>/tui` | `<name>/rpc` |
| Configured local directory | `<directory>/server`, then `<directory>/index` | `<directory>/tui` | `<directory>/rpc` |

Installed packages honor `exports`. An explicit `./server` wins over the root; import conditions win over require conditions. Without `exports`, installed packages can use `main` or default `index`. TUI-only exports do not fall back to unexported root files.

Local directories use absolute conventional filenames. An exports map pointing at `src/` or `dist/` does **not** redirect that lookup. Keep root `server.ts`/`index.ts`, `tui.ts`/`tui.tsx`, and `rpc.ts` bridges when implementation files live deeper. For a TUI-only local directory, keep only the terminal entrypoint, without an accidental root server file.

Use ESM (`"type": "module"`). Bun imports raw TS and supplies the OpenTUI runtime transform. The Node TUI host explicitly expects precompiled plugins; `Host.load` itself does no compilation. For cross-runtime distribution, publish compiled ESM JS and declarations, and change `files`, `main`, and `exports` to those artifacts. Build JSX for OpenTUI/Solid, rather than leaving browser JSX in the output. Raw TSX portability to Node is not established by a Bun smoke test.

Remote installation skips lifecycle scripts (`ignoreScripts: true`). Ship runnable source for a supported loader or already-built artifacts. Git installs cannot depend on `prepare`/`postinstall` producing missing output. Local directory loading does not install dependencies; resolve imports from that directory's own dependency tree.

Ground truth: `packages/plugin/src/host.ts`, `packages/plugin/test/host.test.ts`, `packages/core/src/plugin/module.ts`, `packages/util/src/npm.ts`, and `packages/tui/src/plugin/runtime-plugin-support.*.ts`.

## Put the plugin in the right config

Configure a server or combined package in global or project `opencode.json(c)`. Configure a TUI-only package in global `~/.config/opencode/cli.json` (or the XDG config equivalent). A combined package listed in server config reaches the TUI through active server plugin inventory; a same-machine install normally needs only that entry. Inventory-derived targets resolve with `install: false`. With a remote server, the terminal half must already resolve on the terminal machine, or have an explicit local `cli.json` entry that permits installing it there. Server inventory does not transfer remote filesystem paths or install missing terminal packages.

`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-example-server@0.1.0",
    "github:acme/plugin#main",
    "github:acme/plugins#main::path:packages/example",
    "./plugins/example",
    { "package": "../shared/example", "options": { "strict": true } }
  ]
}
```

These entries illustrate alternative source forms, not a requirement to configure every one. Bare npm names mean `latest`; versions, ranges, and dist tags are accepted. `::path:` is npm's Git-subdirectory syntax passed to the installer. Tagged upstream tests cover branch and full-commit subdirectory installs, but an earlier v2 beta installed the repository root instead of the subdirectory in a live test. Confirm the installed package contents on the target host before depending on `::path:`; publishing each plugin to its own branch avoids the question.

String and `{ package, options }` entries load identically; server options default to `{}` and reach `ctx.options`. The schema has no per-entry `enabled` field. Relative server paths resolve against the containing config file, or the Location directory for inline config. Absolute paths and `file://` directory URLs work. Use absolute paths in `cli.json` to avoid depending on command-specific relative-path handling. JSON strings do not expand `~`.

**Configured local paths must be directories.** Existing regular-file entries are skipped with `configured plugin path must be a directory`. Standalone `.ts`/`.js` server files survive only through legacy auto-discovery. Prefer directory layouts so helpers are not mistaken for independent plugins:

```text
.opencode/plugins/example/
  index.ts
  helper.ts
  tui.ts
```

Server discovery scans immediate children of both `plugin/` and `plugins/` under global config and discovered `.opencode` directories. It accepts directories, `.ts`/`.js` files, and corresponding symlinks. A `plugins/` directory beside a root `opencode.jsonc` needs an explicit config entry. Server discovery walks Location ancestors through the filesystem root, even above the repository root.

TUI-only discovery scans directories under global `plugins/` and project `.opencode/plugins/`, between the nearest Git/Hg root and cwd (cwd alone without a repository). It admits directories and directory symlinks, not standalone files. There is no project-local `cli.json`; `OPENCODE_CLI_CONFIG_CONTENT` overlays the global document, replacing arrays.

### Control precedence and duplicates

Server document precedence, low to high: well-known config, global supplementary config, explicit config file, direct ancestor configs, `.opencode` supplementary configs, inline content. Ancestor lists are parent-first. Plugin scanning applies **all discovered sources first**, then explicit document entries in that precedence order.

| Rule | Result |
| --- | --- |
| Repeat an identical target | Latest options/revision replace it; original Map position remains |
| Distinct targets export the same server plugin ID | First in boot order stays; later occurrences report duplicate-ID failures |
| `-example`, `-example.*`, `-*` | Disable already-known matching plugin IDs |
| Later `example`, `example.*`, `*` | Re-enable already-known matching IDs |
| Target begins `opencode.` | Interpret as an ID selector, not an install request |

Selectors use **plugin IDs**, not package specs, and affect definitions known at that point. Built-in guarded plugins cannot be disabled. Server boot order is internal `pre`, SDK globals, instance-bound plugins, configured/discovered packages, internal `post`.

The TUI merges discovery, server inventory, then explicit CLI entries. It dedupes normalized targets with later entries authoritative, then folds definitions into an ID-keyed Map: later TUI definitions replace the same ID. Do not assume the server's duplicate-ID failure rule also applies to the TUI.

Ground truth: `packages/core/src/config/discovery.ts`, `packages/core/src/config/plugin/source.ts`, `packages/core/src/plugin/supervisor.ts`, and `packages/tui/src/plugin/{discovery.ts,context.tsx}`.

## Install, inspect, and update packages

Check help on the target host before scripting. These are the v2.0.20 commands and command-specific flags:

| Command | Behavior |
| --- | --- |
| `opencode plugin add <package>` | Install an npm/Git spec; add the exact spec to global server config if a server entry exists, otherwise global `cli.json` for TUI-only |
| `opencode plugin remove <package>` | Remove that exact spec, string or object, from both global configs; leave project configs and cache intact |
| `opencode plugin list` | Show ID/version/source; `--builtin` includes built-in server plugins |
| `opencode plugin check [target]` | Check one exact configured package target or all; no installation of newer versions |
| `opencode plugin update [target]` | Update selected outdated targets, or all outdated targets when omitted |
| `opencode plugin inventory` | **No such exposed command**; `inventory.ts` is shared check/update implementation |

`add` accepts registry and Git specs, not local directory paths, tarballs, or npm aliases. Edit config for local directories. It checks entrypoint resolution, not successful setup. There are no `add --global`, `--local`, `--options`, or `update --force`/`--all` flags in this release. All plugin subcommands have global `--help`, `--log-level`, and `--print-logs`; help warns that server stderr logs require `--standalone`.

`list`, `check`, and `update` connect to a server using cwd as Location; they can activate that Location's plugins and are not offline file inspections. Use `opencode api --server <url>` for explicit server targeting. `check` and per-item update failures can set exit code 1; inspect server logs as well, since server availability-check failures are logged and can retain prior check status. Removing an exact spec does not disable another discovered source with the same plugin ID.

### Understand the cache before debugging a stale install

Default package cache: `~/.cache/opencode/npm/<key>/<numeric-generation>/node_modules/<package-name>`, overridden by `XDG_CACHE_HOME`. Registry keys include name and configured spec; Git keys include repository slug and a digest of the full spec, including ref/subdirectory.

The newest completed generation is current. Normal loads reuse it; missing packages install after already-available local/cached plugins activate. Availability checks run asynchronously and cache results for 24 hours; they report `outdated` without replacing packages. Explicit update stages a new generation and publishes it by rename. If the resolved revision is unchanged, it retains the old generation.

Exact npm versions and full 40/64-character Git commit hashes are pinned. Branches, tags, ranges, and dist tags are mutable. A mutable spec does not mean startup automatically refreshes its installed code. Change a pinned spec to select another version. Cache cleanup after updates keeps the newest two generations and removes eligible older generations past seven days; this is retention, not an update timer.

Do not edit installed cache files as a development loop. A TUI can keep an unchanged remote package entrypoint for its whole session; after package update, reopen the TUI when validating its terminal half.

## Develop with Location-owned setup and cleanup

Keep state inside setup unless it intentionally belongs to the whole process. Plugin registries, source watchers, and RPC registrations are Location-scoped. Global configuration can therefore run setup separately at several directories; embedded SDK instances can also have distinct plugin lists. `ctx.location` identifies this instance, not every session or event it observes.

Server reconciliation listens to config changes, watched local import-graph changes, SDK changes, and update status. Local sources track file contents, directory contents, and missing dependencies; unchanged import attempts, including failures, are cached. Reachable local imports reload; `node_modules` is excluded from ordinary graph traversal. Configured directories outside config roots get explicit watches. Creating a previously missing dependency can trigger recovery, but the host does not install it for a local plugin.

Server activation preserves only the unchanged prefix of plugin order. It cleans up the changed suffix in reverse order and runs setup forward. Editing an early plugin can rerun later healthy setups. Domain `reload()` replays transforms; it is a different operation from source/config reconciliation and does not itself rerun setup.

Return cleanup for timers, streams, sockets, subprocesses, and process listeners you create. Host registrations are scoped automatically. Effect plugins use scoped resources/finalizers. Launch background consumption without holding setup open forever. See [server.md](server.md) for lifecycle forms.

Import/definition failures record failed inventory and can keep the last healthy generation. Setup failure closes the failed scope and can restore the previous definition. A transform failure disables that activation and removes its registrations; other plugins remain active. TUI import/setup/cleanup failures produce toasts and `/plugins` details, with last-good fallback where available. Isolation handles registration and lifecycle failures; trusted plugin code still executes in the host process.

Max's local dev and publish workflow: the `my-opencode` skill.

## Test setup, hooks, and packaging separately

Use the repository's existing runner, and typecheck with a modern target (the complete config is in [tui.md](tui.md#compile-solidopentui-jsx-and-use-the-host-theme)). Unit-test pure helpers, schemas, setup registrations, callbacks, and cleanup with a fake context. Keep the fake limited to the methods the example calls, and place any context assertion at the test boundary. A fake proves your code's interaction with that contract; it cannot prove that a live host still has those APIs.

For the server example above, `setup.test.ts`:

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import plugin from "./index.js"

test("setup writes state and cleanup removes it", async () => {
  const calls: unknown[][] = []
  const fake = {
    storage: {
      set: async (key: string, value: unknown) => { calls.push(["set", key, value]) },
      remove: async (key: string) => { calls.push(["remove", key]) },
    },
  } as unknown as Context
  const cleanup = await plugin.setup(fake)
  assert.equal(typeof cleanup, "function")
  await cleanup?.()
  assert.deepEqual(calls, [["set", "loaded", true], ["remove", "loaded"]])
})
```

For hook tests, fake the domain's `hook` method, capture the registered name/callback/options, return a disposable registration, and invoke the captured callback with the SDK's actual event type. Assert mutations and cancellation, then call cleanup. For transforms, invoke the captured synchronous callback against a small editor fake. Exercise multiple calls so retained state and repeatability are visible. See `packages/plugin/src/promise/session.ts` and [server.md](server.md) for callback types.

`@opencode/plugin/host` exports only the resolver/loader, not a context factory, setup runner, or test runtime. `Host.resolve({ directory })` checks local conventional entrypoints; adding `name` checks installed package resolution. It does not execute modules. `Host.load(entrypoint)` imports them but does not activate setup. Upstream `packages/plugin/test/host.test.ts` builds temporary packages to test exactly those resolution rules. Use `packages/core/test/plugin-failure.test.ts` and `packages/core/test/plugin/supervisor-reload.test.ts` as integration-test references, not an assumed public test-host API.

### Smoke-test the intended server

Run from the test project's directory. Reuse the target server's authentication context; loopback does not imply no authentication.

```sh
opencode api --server http://127.0.0.1:4096 get /api/info
opencode api --server http://127.0.0.1:4096 plugin.list --param 'location[directory]=/absolute/project'
opencode run --server http://127.0.0.1:4096 -m provider/model "Exercise the example plugin"
```

`plugin.list` returns status and features, unlike the CLI's ID/version/source table. Confirm `state.status: "active"`, the expected source, and the installed version/revision. Then call the actual tool, hook-triggering request, command, or RPC. A prompt asking to exercise a plugin is not proof that the model exercised it. Use [rpc.md](rpc.md)'s explicit HTTP call for deterministic RPC smoke tests. Render TUI behavior in a real terminal; `opencode run` cannot verify terminal UI.

### Report the highest verified stage

| Stage | Required evidence |
| --- | --- |
| Typecheck | Correct resolved SDK version; example/implementation compiler check passes |
| Unit test | Registered callback/logic/cleanup acceptance assertions pass |
| Local directory load | Intended server or terminal imports the directory and reports active status |
| Installed package load | Actual installed npm/Git artifact resolves and reports the expected revision |
| Live behavior | Registered behavior runs on the intended target; options/state/cancellation and unload/reload cleanup behave as requested |

A local workspace test does not establish installed-package load. Active status does not establish that hooks ran. After publication, repeat the installed-package and live-behavior stages rather than claiming rollout from typecheck alone.

## Read the right logs

Inspect `~/.local/share/opencode/log/opencode.log`, or `$XDG_DATA_HOME/opencode/log/opencode.log`. Local/development channels can use `opencode-<channel>.log`. Filter `role=server` for server work and `role=cli` for terminal/client work. Load warnings include target, cause, and an `err_...` reference; correlate that reference with `/plugins` or API inventory. Setup logs include plugin ID/span attributes. TUI reconciliation logs identify stages such as discover, prepare, load, setup, and cleanup.

Set `OPENCODE_LOG_LEVEL=DEBUG` in the process being diagnosed; supported logger env levels are DEBUG/INFO/WARN/ERROR, case-insensitive. `OPENCODE_PRINT_LOGS=1` mirrors structured logs to stderr. A client env change does not reconfigure an already-running server. CLI `--log-level debug`/`--print-logs` are separate invocation flags; consult their help for the wider CLI parser spellings.

Effect plugins can use `Effect.logInfo`/`Effect.logError` within their scoped Effects. Promise docs use `console.log`; automatic capture of arbitrary console output into the structured file is unverified. The V2 Promise context has no `ctx.app.log` or V1 `client.app.log`. Do not log credentials, full prompt bodies, authorization headers, or sensitive tool results.

## Gotchas

- Resolve conventional root files for local directories and package exports for installed packages; test both paths.
- Pin and inspect the SDK resolved from the plugin itself; older copied manifests are not compatibility evidence.
- Build before distribution when needed. Installer lifecycle scripts do not build the plugin for you.
- Use directory config entries, inert RPC contracts, and helpers inside the plugin directory.
- Separate availability checks, installed revisions, active inventory, and observed behavior in verification reports.
- Keep cleanup complete and setup repeatable across source/config reload and multiple Locations.

## Source map

All upstream paths below refer to tag `v2.0.20`.

- `packages/plugin/package.json`, `packages/plugin/script/publish.ts`: package exports and compiled publication; published `@opencode/plugin/package.json` confirms exact dependencies/peers.
- `packages/plugin/src/host.ts`, `packages/plugin/test/host.test.ts`, `packages/util/src/runtime/import.*.ts`: resolution versus import.
- `packages/schema/src/config/plugin.ts`, `packages/core/src/config.ts`, `packages/core/src/config/discovery.ts`, `packages/core/src/config/plugin/source.ts`, `packages/core/src/plugin/source-directory.ts`: config schema, precedence, selectors, and discovery.
- `packages/core/src/plugin/{module.ts,supervisor.ts,update.ts}`, `packages/core/src/plugin.ts`, `packages/plugin/src/source*.ts`: loading, scope, watching, cache fingerprints, failure isolation, and reconciliation.
- `packages/util/src/npm.ts`, `packages/core/test/npm.test.ts`, `packages/util/src/global-roots.ts`: install specs, ignored scripts, subdirectory fixtures, generations, and XDG roots.
- `packages/cli/src/commands/handlers/plugin/{add,remove,list,check,update,inventory}.ts`: CLI semantics; `opencode plugin <subcommand> --help` confirms exposed flags.
- `packages/cli/src/config/config.ts`, `packages/cli/src/commands/handlers/default.ts`, `packages/tui/src/plugin/{discovery.ts,context.tsx,runtime-plugin-support.bun.ts,runtime-plugin-support.node.ts}`: global CLI config, local package preparation, and terminal loading.
- `packages/protocol/src/groups/plugin.ts`, `packages/cli/src/commands/handlers/api.ts`: inventory endpoint and operation-ID/query handling; `opencode api --help` and `opencode run --help` confirm smoke-test flags.
- `packages/util/src/observability/logging.ts`, `packages/cli/src/{index.ts,server-process.ts}`, `packages/plugin/src/promise/plugin.ts`: logging and context boundaries.
- `packages/core/test/plugin-failure.test.ts`, `packages/core/test/plugin/supervisor-reload.test.ts`, `services/www/src/docs/content/build/plugins/migrate-v1.mdx`: lifecycle integration and installed-package verification.
