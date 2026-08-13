# ACP adapter for DeepSeek Harness

Use [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) from [Agent Client Protocol](https://agentclientprotocol.com/) clients such as [Zed](https://zed.dev).

`dsh-acp` is a stdio ACP agent server. It attaches to **your** DeepSeek Harness installation — the way [codex-acp](https://github.com/agentclientprotocol/codex-acp) runs the Codex you point it at — composes the harness agent runtime in-process (model adapter, sandboxed bash/filesystem tools, todo planning, JSONL session persistence, context compaction), and maps the harness session-event log onto the full ACP update vocabulary.

## Install

**1. Install DeepSeek Harness first** (the host this adapter attaches to):

```bash
npm install -g @deepseek-ai/dsh
dsh --version
```

**2. Install dsh-acp** (from a checkout, until it is published):

```bash
npm install
npm run pack:local
npm install -g ./deepseek-ai-harness-dsh-acp-0.1.0.tgz
dsh-acp --version
```

The adapter's only runtime dependency is the ACP SDK (22 kB tarball); every harness module loads from your `@deepseek-ai/dsh` installation.

**3. Get a credential**: a DeepSeek API key in `DEEPSEEK_API_KEY`, or an OpenAI-compatible proxy in `DEEPSEEK_BASE_URL`.

Requires Node.js ≥ 20 (the harness targets `^22.19 || >=24`; use 22+ for best results) on macOS or Linux.

## Finding the harness

`dsh-acp` looks for a DeepSeek Harness installation in this order:

1. `--dsh-path` / `DSH_PATH` — the `dsh` binary path, the `@deepseek-ai/dsh` package directory, an npm prefix, or any directory whose `node_modules` carries the `@deepseek-ai` scope:

   ```bash
   DSH_PATH="$(which dsh)" dsh-acp
   ```

2. dsh-acp's own package tree (development checkouts).
3. `./node_modules` of the invoking directory (project-local installs).
4. **`dsh` on `PATH`** — the normal case after `npm install -g @deepseek-ai/dsh`.
5. The global npm root (`npm root -g`).

If nothing matches, it exits with the probed locations and the install command above. An explicit `DSH_PATH` that does not contain a harness is an error, never a silent fallback.

## Use with Zed

Configure `dsh-acp` as an agent server. The only optional argument is the path
to your `dsh` installation — leave it out and dsh-acp finds `dsh` on PATH:

```jsonc
// settings.json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "dsh-acp",
      "args": [],
      "env": {
        "DEEPSEEK_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

With an explicit harness location (e.g. a non-global or versioned install):

```jsonc
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "dsh-acp",
      "args": ["--dsh-path", "/opt/deepseek/lib/node_modules/@deepseek-ai/dsh"],
      "env": { "DEEPSEEK_API_KEY": "sk-your-key-here" }
    }
  }
}
```

Any ACP client works the same way: spawn `dsh-acp` and speak newline-delimited JSON-RPC on its stdio. Stdout is protocol-pure; diagnostics go to stderr.

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
