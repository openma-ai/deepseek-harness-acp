# ACP adapter for DeepSeek Harness

Use [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) from [Agent Client Protocol](https://agentclientprotocol.com/) clients such as [Zed](https://zed.dev).

`dsh-acp` is a stdio ACP agent server. It boots a DeepSeek Harness agent composition in-process (model adapter, sandboxed bash and filesystem tools, todo planning, JSONL session persistence, context compaction) and maps the harness's append-only session-event log onto the full ACP update vocabulary.

Where the harness's built-in `@deepseek-ai/dsh-acp` bridge is automation-only (committed text, nothing else), this adapter is built for editors.

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

## Installation

Run from a checkout:

```bash
npm install
npm run build
node dist/index.js --help
```

Or pack and install the tarball locally:

```bash
npm run pack:local
npm install -g ./deepseek-ai-harness-dsh-acp-0.1.0.tgz
dsh-acp --version
```

Requires Node.js ≥ 20 (the harness packages target `^22.19 || >=24`; use 22+ for best results) on macOS or Linux.

## Use with Zed

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

Any ACP client works the same way: spawn `dsh-acp`, speak newline-delimited JSON-RPC on its stdio. Stdout is protocol-pure; diagnostics go to stderr.

## Configuration

Flags win over environment variables, which win over defaults.

| Flag | Env | Default | Purpose |
|---|---|---|---|
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
dsh-acp  (src/index.ts CLI → src/app.ts composition)
   ├─ src/bridge/            the ACP bridge (cordis plugin)
   │    ├─ index.ts          sessions, prompts, cancel, modes, options, permissions
   │    ├─ translate.ts      session-event → ACP update projection (pure)
   │    ├─ history.ts        stored-log replay for session/load (pure)
   │    └─ prompt.ts         ACP prompt blocks → harness content blocks (pure)
   └─ @deepseek-ai/* rc packages, composed in-process:
        llm-deepseek · agent-spine-demo · session-persistence-jsonl ·
        session-checkpoint-policy · sandbox(-local/-policy) · subprocess-local ·
        bash-sandbox · user-approval · fs-sandbox · fs-observation-policy ·
        tool-fs · tool-todo · token-meter · compaction-basic
```

The bridge consumes the harness `session/event` firehose (the same append-only log that persistence stores), so live streaming, history replay, and `session/list` all agree by construction.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: unit + e2e smoke (boots the real composition; no model calls)
npm run build       # esbuild → dist/index.js
npm run pack:local  # build + npm pack
```

The e2e suite spawns the real server and exercises initialize, session/new, modes, model switching, `/status`, session/list, and cross-process session/load — all without a model credential.

## License

Apache-2.0.
