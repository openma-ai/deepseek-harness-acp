# ACP `_meta` registry

This file is the source of truth for every `_meta` field read or emitted by
`@openma/deepseek-harness-acp`. It documents adapter-owned DSH extensions and
the compatibility extensions the adapter implements for existing ACP clients.
Standard ACP fields remain sufficient unless a client explicitly opts into one
of the capabilities below.

Clients must ignore unknown `_meta` fields. Every block is optional unless the
client selected an authentication method whose request requires that block.
Several blocks can coexist on one object; for example, a completed command can
carry both `_meta.dsh.toolResult` and `_meta.terminal_exit`.

DSH-owned JSON keys use camelCase below `_meta.dsh`. Keys outside that namespace
retain the spelling of the external contract they implement, including
`terminal_output`, `terminal_info`, `terminal_exit`, `commandAction`, and
`dsh.userQuestions`.

## Initialization and capability negotiation

The client sends capability metadata in `initialize.params.clientCapabilities`.
The adapter reads only the paths listed here; omission keeps the corresponding
extension disabled.

| Path | Type | Effect |
|---|---|---|
| `clientCapabilities._meta.terminal_output` | literal `true` | Enables display-terminal content and the `terminal_*` metadata blocks. This is the Codex/Zed terminal extension. |
| `clientCapabilities._meta["subagent-transcript"]` | literal `true` | Forwards child-agent session updates onto the root ACP session with `_meta.dsh.subagent` attribution. |
| `clientCapabilities._meta.dsh.interaction.mode` | `"interactive" \| "rpc"` | Selects the DSH interaction mode passed to newly created agents. Unknown values are ignored. |
| `clientCapabilities._meta.dsh.cordis.protocol` | literal `0` | Negotiates the private `_dsh/cordis/*` TUI Client plane. Both peers must advertise the same protocol. |
| `clientCapabilities.auth._meta.gateway` | literal `true` | Requests advertisement of the custom gateway authentication method. |

The adapter advertises the Cordis protocol in the initialize response:

```json
{
  "agentCapabilities": {
    "_meta": {
      "dsh": {
        "cordis": {
          "protocol": 0
        }
      }
    }
  }
}
```

`_meta.dsh.cordis.protocol` only negotiates the package-private TUI plane. It
does not synchronize Cordis plugin ids, services, or fibers between processes.

## Authentication metadata

Authentication metadata appears on advertised `authMethods` and on the
client's `authenticate` request. API keys and gateway authorization headers are
secrets; clients must not log or persist the request metadata as transcript
content.

### Advertised auth methods

| Method | Advertised metadata | Meaning |
|---|---|---|
| `api-key` | `_meta["api-key"] = {}` | The method uses the current provider route. |
| `api-key:<provider>` | `_meta["api-key"].provider: string` | The API key belongs to the named provider route. |
| `gateway` | `_meta.gateway.protocol: "openai"` | The gateway must expose an OpenAI-compatible endpoint. |
| `gateway` | `_meta.gateway.restartRequired: "false"` | Authentication takes effect without restarting the ACP process. The value is the compatibility contract's string literal, not a boolean. |

### `authenticate` request

An API-key request uses this shape:

```json
{
  "methodId": "api-key:anthropic",
  "_meta": {
    "api-key": {
      "apiKey": "<secret>",
      "provider": "anthropic"
    }
  }
}
```

`apiKey` is required when the client supplies credentials over ACP. `provider`
is optional when it is already encoded in `methodId`.

A custom gateway request uses this shape:

```json
{
  "methodId": "gateway",
  "_meta": {
    "gateway": {
      "baseUrl": "https://gateway.example.com/v1",
      "headers": {
        "Authorization": "Bearer <secret>"
      },
      "providerName": "company-gateway"
    }
  }
}
```

`baseUrl` and an `Authorization` header are required. `headers` accepts a
string-to-string record. `providerName` is an optional display and route name.

## Session update metadata

These blocks annotate standard ACP `session/update` payloads. Clients that do
not consume them still receive the normal ACP message, tool-call, terminal,
plan, and session fields.

### Native DSH tool result value

A successful `tool_call_update` can carry the tool's structured value before
DSH renders it into model-readable content:

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call_123",
  "status": "completed",
  "content": [
    {
      "type": "content",
      "content": {
        "type": "text",
        "text": "```sh\nstarted background job bash-1\n```\n"
      }
    }
  ],
  "rawOutput": {
    "output": "started background job bash-1",
    "isError": false
  },
  "_meta": {
    "dsh": {
      "toolResult": {
        "value": {
          "kind": "background",
          "jobId": "bash-1"
        }
      }
    }
  }
}
```

`content` and `rawOutput` are the normalized ACP result. They remain the result
shown to the model and to ordinary clients. `_meta.dsh.toolResult.value` is the
optional native value for programmatic clients; it is not a second model-visible
result.

Live updates use the exact `value` observed from DSH's `tools/result` event.
DSH deliberately omits that execution-local value from its durable session
event. During history replay, the adapter can restore the block only for the
documented background bash, background subagent, and continuable subagent
acknowledgements. Clients must not assume the block exists on every successful
result or replayed tool call.

### DSH event annotations

`_meta.dsh.event` discriminates metadata-only facts that have no dedicated ACP
session update. The accompanying fields depend on the event value.

| Event value | ACP update | Accompanying fields |
|---|---|---|
| `"assistant_message"` | `agent_message_chunk` | `model?: string`. The adapter emits this on the assembled-message boundary, including an empty chunk when text already streamed. |
| `"user/message"` | `session_info_update` | `source: string`, `preview: string`. This represents non-user context injected by a plugin or another harness source; `preview` is capped at 160 Unicode code points. |
| `"prompt/usage"` | `session_info_update` | `usage`, using ACP `Usage` fields: `totalTokens`, `inputTokens`, `outputTokens`, and optional `thoughtTokens`, `cachedReadTokens`, `cachedWriteTokens`. This is the final aggregate restored by history replay. |
| `"subagent/lifecycle"` | `session_info_update` | `subagent`, using the lifecycle shape below. |

The subagent lifecycle shape is:

```json
{
  "state": "started",
  "runId": "run-1",
  "childSessionId": "child-1",
  "provider": "local",
  "local": true,
  "parentToolCallId": "subagent:run-1"
}
```

`state` is `"started"` or `"finished"`. `parentToolCallId` is optional. A
finished lifecycle adds `stopReason: string`.

### Child transcript attribution

When the client advertises
`clientCapabilities._meta["subagent-transcript"]: true`, each forwarded child
update carries:

```json
{
  "_meta": {
    "dsh": {
      "subagent": {
        "childSessionId": "child-1",
        "parentToolCallId": "subagent:run-1",
        "provider": "local"
      }
    }
  }
}
```

The annotation lets a client group child output beneath the parent subagent
tool call without changing the standard ACP update type.

### Display terminal metadata

The terminal blocks are emitted only when the client advertises
`clientCapabilities._meta.terminal_output: true`.

| Block | ACP update | Shape |
|---|---|---|
| `_meta.terminal_info` | Initial `tool_call` | `{ terminal_id: string, cwd?: string }` |
| `_meta.terminal_output` | Streaming `tool_call_update` | `{ terminal_id: string, data: string }` |
| `_meta.terminal_exit` | Final `tool_call_update` | `{ terminal_id: string, exit_code: number, signal: string \| null }` |

These snake_case names belong to the existing display-terminal compatibility
contract. They are not DSH-owned names and must not be converted to camelCase.

## Command metadata

Entries in `available_commands_update.availableCommands` can carry
`_meta.commandAction`. This compatibility extension tells capable clients to
render a command as a UI action instead of inserting its slash command into the
prompt.

The plan-mode command uses:

```json
{
  "commandAction": {
    "kind": "setConfigOption",
    "configId": "collaboration_mode",
    "value": "plan",
    "resetValue": "default",
    "presentation": "state"
  }
}
```

The TUI-only plan viewer, advertised after Cordis protocol negotiation, uses:

```json
{
  "commandAction": {
    "kind": "clientCommand",
    "presentation": "view"
  }
}
```

## User-question elicitation metadata

A standard ACP `elicitation/create` form generated for a DSH user-question
request includes `_meta["dsh.userQuestions"]`. The standard form schema is
complete on its own; this block preserves the original DSH questions for
clients that provide a specialized renderer.

```json
{
  "_meta": {
    "dsh.userQuestions": {
      "version": 1,
      "questions": [
        {
          "id": "target",
          "question": "Where should this run?",
          "header": "Target",
          "detail": "Choose the deployment target.",
          "options": [
            {
              "label": "Local",
              "description": "Run on this machine."
            }
          ],
          "multiSelect": false
        }
      ]
    }
  }
}
```

Each question has required `id` and `question` strings. `header`, `detail`,
`options`, `multiSelect`, and `intent` are optional. Each option requires
`label` and can include `description`. The currently defined intent is
`{ kind: "plan-review", approve: string }`; unknown future intents must fall
back to the standard form presentation.

## Compatibility checklist

An ordinary ACP client can ignore this entire document and use the standard
fields. A client that consumes an extension should advertise its capability
when one exists, branch on the complete metadata path rather than display text,
treat every annotation as optional, and ignore fields it does not understand.
Authentication request metadata is the exception to ordinary transcript data:
it can contain secrets and must be handled as credential material.
