# ACP adapter for DeepSeek Harness

Use [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) from [Agent Client Protocol](https://agentclientprotocol.com/) clients such as [Zed](https://zed.dev).

`@deepseek-ai-harness/dsh-acp` is a **dsh profile plugin** (a harness bundle) and a standalone stdio ACP server. In both shapes it maps the harness session-event log onto the full ACP update vocabulary and reuses your existing dsh setup — including the API key you saved in the dsh Web UI. No credentials in your editor config.

## Install (recommended: as a dsh plugin)

**1. Have DeepSeek Harness** (you probably already do):

```bash
npm install -g @deepseek-ai/dsh
dsh web        # first run: save your DeepSeek API key in Settings → Models
```

**2. Add the ACP bundle to a profile:**

```bash
dsh plugin --profile acp add -w @deepseek-ai-harness/dsh-acp
```

This creates `$DSH_HOME/profiles/acp`, installs the package, and registers the
bundle (its `dsh.bundle` patch mounts the bridge over `@deepseek-ai/dsh-base`
— the same product baseline as `dsh web`, with the module-reload watcher off).

**3. Point Zed at it** (`settings.json`):

```jsonc
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "dsh",
      "args": ["--profile", "acp"]
    }
  }
}
```

That's it — no `env`, no keys in the editor. Credentials come from the
harness's own credential store (`$DSH_HOME/.credentials.yaml`, the file the
Web UI writes, hot-reloaded), with the process environment
(`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`) as a fallback layer.

Because the profile rides `dsh-base`, the agent in your editor is the full
product: sandboxed bash and filesystem tools, todo plans, skills, subagents,
workflows, web search, plan mode, LLM session titles, compaction — and it
shares `$DSH_HOME/sessions`, so conversations started in the dsh Web UI can
be listed and loaded from the editor.

Override provider/model per profile in `$DSH_HOME/profiles/acp/cordis.patch.yml`
(id-targeted patch on the `acp-bridge` row), or via `DSH_MODEL` /
`DSH_PERMISSION_MODE` in the launch environment.

## Install (alternative: standalone server)

The package is also a self-contained ACP server that attaches to a DeepSeek
Harness installation — the way codex-acp runs the Codex you point it at:

```bash
npm install -g @deepseek-ai-harness/dsh-acp
dsh-acp --help
```

```jsonc
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "dsh-acp",
      "args": []               // optional: ["--dsh-path", "/path/to/dsh"]
    }
  }
}
```

It finds the harness via `--dsh-path`/`DSH_PATH`, its own tree,
`./node_modules`, `dsh` on PATH, or `npm root -g` — and composes a fixed
coding-agent tree from it (spine, sandboxed bash/fs, todo, compaction). Use
this mode when you want an ACP server without creating a profile; use the
profile mode when you want your full dsh composition in the editor.

## Features

- Streamed assistant text and reasoning (`agent_message_chunk` / `agent_thought_chunk`), with assembled-message fallback when an adapter emits no deltas.
- Tool calls with ACP kinds, human titles, file locations, raw input/output — and real file diffs sourced from the fs tool's hunk metadata.
- `todo_write` snapshots as ACP plans; token accounting as `usage_update` (context pressure) plus per-turn `PromptResponse.usage`.
- Real cancellation: `session/cancel` interrupts the live turn through the harness agent, not by killing a process.
- Permission requests: sandboxed wider-access retries surface as `session/request_permission` with allow-once / always-allow / reject options.
- Session modes mapped to the harness sandbox policy: `read-only`, `workspace-write`, `danger-full-access` — switchable per session at runtime.
- Model switching through session config options (`session/set_config_option`), preserving full conversation history via durable resume.
- `session/load` with complete history replay from JSONL persistence, `session/list` from the same store, session titles as `session_info_update`.
- Slash commands (`/status`) advertised through `available_commands_update`.
- Env-var auth method advertisement (`DEEPSEEK_API_KEY`), honored by `authenticate`.

## Configuration

Flags win over environment variables, which win over defaults.

| Flag | Env | Default | Purpose |
|---|---|---|---|
| `--dsh-path` | `DSH_PATH` | auto-detect | DeepSeek Harness installation |
| `--provider` | `DSH_PROVIDER` | `deepseek-official` | Provider route for created agents |
| `--model` | `DSH_MODEL` | `deepseek-v4-flash` | Default model |
| `--models` | `DSH_ACP_MODELS` | `deepseek-v4-flash,deepseek-v4-pro` | Selectable models for the session **Model** option |
| `--max-tokens` | `DSH_MAX_TOKENS` | provider default | Per-request output-token cap |
| `--permission-mode` | `DSH_PERMISSION_MODE` | `workspace-write` | Initial sandbox mode (`read-only` / `workspace-write` / `danger-full-access`) |
| `--session-root` | `DSH_SESSION_ROOT` | `~/.dsh-acp/sessions` | JSONL session store |
| `--persona` | `DSH_SYSTEM_PROMPT` | built-in coding persona | System-prompt persona (`{{model}}`, `{{cwd}}` interpolate) |
| `--reasoning-effort` | `DSH_REASONING_EFFORT` | `high` | `off` / `high` / `max` |
| `--no-thinking` | — | thinking on | Disable model thinking output |
| `--bash-timeout` | `DSH_BASH_TIMEOUT_MS` | `60000` | Foreground bash timeout (ms) |
| — | `DEEPSEEK_API_KEY` | — | API credential (advertised as the ACP auth method) |
| — | `DEEPSEEK_BASE_URL` | DeepSeek endpoint | OpenAI-compatible endpoint override |
| — | `DSH_ACP_DEBUG` | off | Verbose stderr diagnostics |

## Permissions and sandboxing

Sessions start in `workspace-write`: bash and file mutations are confined to the session's `cwd` (plus shared temp roots), and a model retry requesting wider access raises an ACP permission request. Choosing **Always allow (this session)** flips the harness approval policy to `never` for that session. `danger-full-access` disables both the sandbox and the prompts — use it only in disposable checkouts or containers.

## Architecture

```
ACP client (Zed, …)
   │  ACP JSON-RPC over stdio
   ▼
dsh-acp
   ├─ src/harness.ts          host discovery + module loading (DSH_PATH / auto-detect)
   ├─ src/app.ts              composition built from the host's packages
   ├─ src/bridge/             the ACP bridge (cordis plugin)
   │    ├─ index.ts           sessions, prompts, cancel, modes, options, permissions
   │    ├─ translate.ts       session-event → ACP update projection (pure)
   │    ├─ history.ts         stored-log replay for session/load (pure)
   │    └─ prompt.ts          ACP prompt blocks → harness content blocks (pure)
   ▼
your @deepseek-ai/dsh installation   (agent spine, llm-deepseek, persistence,
                                      sandbox, bash, fs, approvals, todo,
                                      token meter, compaction)
```

The bridge consumes the harness `session/event` firehose (the same append-only log that persistence stores), so live streaming, history replay, and `session/list` all agree by construction. All harness modules — including cordis itself — load from the host tree, so plugin and service identity is never split across copies.

## Development

```bash
npm install         # dev deps include the harness packages (types + tests)
npm run typecheck   # tsc --noEmit
npm test            # vitest: unit + e2e smoke (boots the real composition; no model calls)
npm run build       # esbuild → dist/index.js
npm run pack:local  # build + npm pack
```

The e2e suite exercises initialize, session/new, modes, model switching, `/status`, session/list, and cross-process session/load — all without a model credential. To also test against a standalone host install:

```bash
npm install --prefix /tmp/dsh-host @deepseek-ai/dsh
DSH_ACP_TEST_HOST=/tmp/dsh-host npm test
```

## License

Apache-2.0.
