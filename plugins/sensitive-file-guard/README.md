# sensitive-file-guard

Stops the agent from reading, editing, or copying secret files — `.env`, private keys, kubeconfigs, cloud credentials — while still letting it work with them structurally via a keys-only helper.

## What it blocks

For every matched path it intercepts:

- **`read` and `edit` tools** — direct reads/writes of protected files.
- **`bash` commands** that would exfiltrate a protected file, across several command classes:
  - **read**: `cat`, `grep`/`rg`, `head`, `less`, `awk`, `sed`, `base64`, `strings`, `jq`, `od`, `hexdump`, … (including `source`/`.` and stdin redirects)
  - **copy**: `cp`, `mv`, `rsync`, `scp`, `install`
  - **archive**: `tar`, `zip`, `gzip`, `7z`, …
  - **env dump**: `env`, `printenv`, `set`, `export`, `declare`
- **Interpreter reads** — e.g. `python`/`node`/`ruby` calling `open()` / `readFileSync()` on a protected path.
- **Sensitive env-var expansion** — shell expansion of variables named like `*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*`, etc.
- **Raw secret manifests** — content-sniffs Kubernetes `Secret` YAML rather than relying on filenames.

Shell comments are stripped before matching so `# cat .env` can't be used to smuggle intent.

## Default protected patterns

`.env`, `.env.*`, `**/.env*` · SSH/TLS keys (`id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, `*.pem`, `*.pfx`, `*.p12`, `*.jks`) · `.netrc`, `.npmrc`, `.pypirc` · `**/.aws/credentials` · `**/kubeconfig`, `**/*.kubeconfig` · `**/service-account*.json`.

Allowlisted (never blocked): `.env.example` and `*.pub`. Broad substring globs like `**/*secret*` are intentionally **not** used — they produce too many false positives (Helm `ExternalSecret` templates, docs, fixtures); real secrets are caught by content sniffing instead.

## `list_env_keys` tool

So the agent isn't flying blind, the plugin adds a **`list_env_keys`** tool that returns the **keys** of an env-style file (e.g. `.env`) — **never the values**. This lets the agent see an app's expected configuration shape without exposing secrets.

## Configuration

Two options (via `PluginOptions`):

| Option | Type | Effect |
|---|---|---|
| `protected` | `string[]` | Extra glob patterns to protect, **added** to the defaults. |
| `blockCopy` | `boolean` | Toggle blocking of copy/archive commands. |

Because this plugin is normally auto-scanned (symlinked file), passing options requires listing it **explicitly** in `opencode.jsonc` with the `[spec, options]` form:

```jsonc
{
  "plugin": [
    [
      "file:///Users/you/.config/opencode/plugins/sensitive-file-guard.ts",
      { "protected": ["**/*.mykey", "config/prod.json"], "blockCopy": true }
    ]
  ]
}
```

No environment variables required.
