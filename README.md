<p align="center">
  <img src="assets/acp-x-deepseek.svg" width="520" alt="Agent Client Protocol × DeepSeek Harness" />
</p>

<h1 align="center">deepseek-harness-acp</h1>

<p align="center">
  Use <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> from
  <a href="https://agentclientprotocol.com/">Agent Client Protocol</a> clients such as
  <a href="https://zed.dev">Zed</a> and
  <a href="https://github.com/openma-ai/backchat">Backchat</a>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@openma/deepseek-harness-acp"><img src="https://img.shields.io/npm/v/%40openma%2Fdeepseek-harness-acp?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@openma/deepseek-harness-acp"><img src="https://img.shields.io/npm/dm/%40openma%2Fdeepseek-harness-acp" alt="npm downloads" /></a>
  <a href="https://github.com/openma-ai/deepseek-harness-acp/actions/workflows/ci.yml"><img src="https://github.com/openma-ai/deepseek-harness-acp/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://agentclientprotocol.com/"><img src="https://img.shields.io/badge/ACP-protocol%20v1-6f42c1" alt="ACP protocol v1" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0" /></a>
  <img src="https://img.shields.io/node/v/%40openma%2Fdeepseek-harness-acp" alt="node >= 22.15" />
</p>

---

The adapter composes the harness **in-process** and maps its session-event log
onto the full ACP vocabulary: streamed text and reasoning, tool calls with
diffs and display terminals, plans, permission requests, session modes,
config options, slash commands, skills, and MCP servers. Credentials never
touch your editor config — it reuses the key you saved in the dsh Web UI, or
`dsh-acp login` saves one to the same store.

## Two ways to plug it in

| | **A · Standalone server** | **B · dsh profile plugin** |
|---|---|---|
| Best for | Getting started in one command | Living inside your dsh setup |
| Install | `npm i -g @openma/deepseek-harness-acp` | `dsh plugin --profile acp add -w @openma/deepseek-harness-acp` |
| Zed runs | `dsh-acp` | `dsh --profile acp` |
| Harness | Your installed dsh — or the npm-installed peer when none exists | The dsh that owns the profile |
| Composition | dsh-base + this bundle (profile machinery booted in-process) | dsh-base + this bundle + your profile's own patches |

Both shapes share `$DSH_HOME`: the same credential store, settings, presets,
and session logs as `dsh web` — conversations started in the Web UI can be
listed and loaded from the editor.

Other dsh surfaces can mount the transport-independent
`@openma/deepseek-harness-acp/plugin` on their Base Host tree and own the
transport adapter. The TUI profile uses this path: it starts a separate TUI
Client process and connects ACP over that process's standard stdin/stdout; it
does not start `dsh-acp` or use an in-process Client stream.

### A · Standalone server

```bash
npm install -g @openma/deepseek-harness-acp
dsh-acp login        # interactive; or save the key in the dsh Web UI
```

```jsonc
// Zed settings.json
{
  "agent_servers": {
    "DeepSeek Harness": { "command": "dsh-acp" }
  }
}
```

Self-contained: it finds your DeepSeek Harness via `--dsh-path` / `DSH_PATH`,
its own tree, `./node_modules`, `dsh` on PATH, or `npm root -g` — and ships a
npm-installed harness peer as the **last** candidate, so it works out of the box
and always prefers the dsh you installed. When a real
`$DSH_HOME/profiles/acp` exists, that profile owns the composition.

### B · dsh profile plugin

```bash
npm install -g @deepseek-ai/dsh
dsh web                                                  # save your API key once
dsh plugin --profile acp add -w @openma/deepseek-harness-acp
```

```jsonc
// Zed settings.json
{
  "agent_servers": {
    "DeepSeek Harness": { "command": "dsh", "args": ["--profile", "acp"] }
  }
}
```

This creates `$DSH_HOME/profiles/acp` and registers the package's
`dsh.bundle` patch: the bridge mounts over `@deepseek-ai/dsh-base` — the same
product baseline as `dsh web`, with the module-reload watcher off. Extend the
profile in `$DSH_HOME/profiles/acp/cordis.patch.yml` like any other dsh
profile.

## Authentication

No keys in editor config, no secrets pasted into chat. ACP clients follow
the protocol: `initialize` advertises three **Agent Auth** methods.

1. **API key** — `api-key`, or `api-key:<provider>` when more than one
   route is live. The client may pass `_meta["api-key"].apiKey`.
2. **Browser** — `browser`. The adapter opens a localhost sign-in page;
   the secret never travels over ACP. Hidden when `NO_BROWSER` is set.
3. **Custom gateway** — `gateway`, only when the client opts in with
   `clientCapabilities.auth._meta.gateway === true`. The client sends
   `_meta.gateway` `{ baseUrl, headers, providerName? }`.

The adapter writes credentials to the harness store. Missing credentials
fail `session/new` and `session/prompt` with `auth_required` (`-32000`).
Logout is the ACP `logout` method.

1. **Harness credential store** — `$DSH_HOME/.credentials.yaml` (mode 600),
   the file the dsh Web UI writes; hot-reloaded. Save a key with
   `dsh-acp login [--provider <route>]`, or the Web UI (Settings → Models).
2. **Process environment** — `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` (and
   the matching `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` for those routes) in
   the environment that launches the agent.

The credential gate is the **current provider route**. An Anthropic-only
store is enough for an Anthropic session; a DeepSeek key does not unlock
another provider.

## Features

- **Streaming** — assistant text and reasoning deltas; assembled-message fallback.
- **Images** — `promptCapabilities.image` is advertised when the composition mounts `ctx.attachments` (dsh-base does). ACP `image` blocks are validated, stored with `saveImage`, and kept in wire order with surrounding text. `resource_link` stays a textual file pointer.
- **Tool calls** — ACP kinds, human titles, file locations, real diffs from fs-tool hunks, raw input/output; command output on a **display terminal** when the client supports one, fenced output otherwise.
- **Permission presets as session modes** — `read-only` / `workspace-write` / `danger-full-access`, each a named `{sandbox, approval}` pair recorded as a durable session fact (also exposed as a config option for clients that only render those).
- **Agent composition** — when the profile mounts `agentPresets`, an uncategorized config option `id: "agent"` lists the roster (`standard` / `code` / `minimal` / `cordis`, plus user copies). Switching rebuilds the agent live with history preserved. Authoring (copy/rm) stays on the Web settings page; there is no `/preset` slash.
- **Live model catalog** — providers × models from the running composition (third-party providers added in the Web UI appear immediately), plus reasoning-effort selection that follows your product default.
- **Slash commands** — adapter built-ins (`/status`, `/model`) plus the harness command registry (`/compact`, `/goal`, `/permission`, `/plan`, …) executed without a model turn, plus **skills** (`/skill-name` — the harness's own invocation gesture). Login and logout are ACP methods, not chat commands.
- **Plans & usage** — `todo_write` snapshots as ACP plans; token accounting as `usage_update` and per-turn usage.
- **Sessions** — `session/load` with full history replay, `session/list`, silent restore when a client prompts an old session after an agent restart, titles as `session_info_update`.
- **MCP servers** — per-session `mcpServers` mount `@deepseek-ai/dsh-mcp-client` instances (stdio + streamable HTTP); tools join as `mcp__<server>__<tool>`; a failing server never takes the session down.
- **Real cancellation** — `session/cancel` interrupts the live turn through the harness agent.

## Configuration

Flags win over environment variables, which win over defaults. All optional —
with no flags, sessions follow your product defaults (`settings.yaml`).

| Flag | Env | Default | Purpose |
|---|---|---|---|
| `--dsh-path` | `DSH_PATH` | auto-detect | DeepSeek Harness installation |
| `--provider` | `DSH_PROVIDER` | product default | Provider route override |
| `--model` | `DSH_MODEL` | product default | Model override |
| `--max-tokens` | `DSH_MAX_TOKENS` | provider default | Per-request output-token cap |
| `--permission-mode` | `DSH_PERMISSION_MODE` | `workspace-write` | Initial permission preset |
| `--reasoning-effort` | `DSH_REASONING_EFFORT` | product default | `off` / `high` / `max` |
| — | `DEEPSEEK_API_KEY` | — | API credential (fallback to the credential store) |
| — | `DEEPSEEK_BASE_URL` | DeepSeek endpoint | OpenAI-compatible endpoint override |
| — | `DSH_ACP_DEBUG` | off | Verbose stderr diagnostics |

Subcommands: `dsh-acp login [api-key]` (interactive when omitted; input never
echoes), `dsh-acp update` (self-update via npm).

## Permissions and sandboxing

Sessions start in `workspace-write`: bash and file mutations are confined to
the session's `cwd` (plus shared temp roots), and a model retry requesting
wider access raises an ACP permission request. **Always allow (this
session)** flips the approval policy to `never` for that session.
`danger-full-access` disables both the sandbox and the prompts — use it only
in disposable checkouts or containers. Each level is one durable preset
(sandbox + approval together), the same three the Web UI offers.

## Architecture

```
ACP client (Zed, …)
   │  ACP JSON-RPC over stdio
   ▼
dsh-acp
   ├─ src/profile-boot.ts     boots the harness's own profile machinery
   │                          (dsh-base + this bundle + $DSH_HOME layers)
   ├─ src/harness.ts          host discovery (DSH_PATH → cwd → PATH → npm -g → npm peer)
   └─ src/bridge/             the ACP bridge (a cordis plugin)
        ├─ index.ts           sessions, prompts, cancel, modes, options,
        │                     commands, credentials, MCP mounts
        ├─ translate.ts       session-event → ACP update projection (pure)
        ├─ history.ts         stored-log replay for session/load (pure)
        └─ prompt.ts          ACP prompt blocks → harness content blocks (pure)
   ▼
your @deepseek-ai/dsh installation   (agent spine, llm, persistence, sandbox,
                                      tools, presets, skills, compaction, …)
```

The bridge consumes the harness `session/event` firehose — the same
append-only log persistence stores — so live streaming, history replay, and
`session/list` agree by construction. All harness modules, including cordis
itself, load from one host tree: plugin and service identity is never split
across copies.

## Development

```bash
npm install         # dev deps include the harness packages (types + tests)
npm run typecheck   # tsc --noEmit
npm test            # vitest: unit + e2e smoke (boots the real composition; no model calls)
npm run build       # esbuild → dist/
```

To also run the e2e suite against a standalone host install:

```bash
npm install --prefix /tmp/dsh-host @deepseek-ai/dsh
DSH_ACP_TEST_HOST=/tmp/dsh-host npm test
```

### Live iteration: paired profiles

Keep the profile your editor uses on the published package, and point a
second profile at this worktree via a pnpm symlink:

```bash
dsh plugin --profile acp add -w @openma/deepseek-harness-acp   # stable
dsh plugin --profile acp-test add -w "link:$PWD"               # dev (symlink)
```

The dev loop is `npm run build` + restart — `dist/` and `cordis.patch.yml`
are read through the link. (pnpm treats `file:` as a copy install and caches
same-version tarballs; `link:` avoids both.)

```jsonc
{
  "agent_servers": {
    "DeepSeek Harness": { "command": "dsh", "args": ["--profile", "acp"] },
    "DeepSeek Harness (dev)": { "command": "dsh", "args": ["--profile", "acp-test"] }
  }
}
```

## License

Apache-2.0.
