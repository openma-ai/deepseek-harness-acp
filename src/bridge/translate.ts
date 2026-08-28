/**
 * Pure translation between the DeepSeek Harness session-event log and ACP
 * session updates.
 *
 * The harness appends every observable fact to an append-only session log
 * (`session/event` firehose). This module projects those events onto the ACP
 * update vocabulary: streamed text and reasoning chunks, tool calls with
 * kinds/titles/locations/diffs, plans, token usage, and turn endings.
 *
 * Everything here is pure and synchronous so it can be unit-tested without a
 * harness runtime and reused verbatim for `session/load` history replay.
 */

import type {
    ContentBlock as AcpContentBlock,
    PlanEntry,
    SessionNotification,
    StopReason,
    ToolCallContent,
    ToolCallLocation,
    ToolKind,
    Usage,
} from "@agentclientprotocol/sdk";

/** One ACP `session/update` payload (without the session id envelope). */
export type SessionUpdate = SessionNotification["update"];

/**
 * A harness session-log event, deliberately widened: `SessionEventMap` is
 * merge-extensible (plugins add event types), so the projection switches on
 * `type` strings and reads `data` defensively.
 */
export interface HarnessEvent {
    type: string;
    data: Record<string, unknown> | undefined;
    seq?: number;
    time?: number;
}

export interface SubagentAttribution {
    childSessionId: string;
    parentToolCallId: string;
    provider: string;
}

/** Harness `TurnEndReason` (structurally typed; see dsh-session types). */
export interface TurnEndReason {
    kind: string;
    reason?: { kind?: string };
    error?: { message?: string; code?: string };
}

const MAX_TITLE_LENGTH = 80;
const MAX_RESULT_TEXT = 20_000;

// ---------------------------------------------------------------------------
// Tool-call classification
// ---------------------------------------------------------------------------

/** Mapping facts derived from one `tool/call` event. */
export interface ToolCallFacts {
    kind: ToolKind;
    title: string;
    locations: ToolCallLocation[];
    rawInput: unknown;
}

interface ProjectedToolCall {
    callId: string;
    name: string;
    arguments: string;
    facts: ToolCallFacts;
    status: "pending" | "in_progress";
}

function firstLine(text: string, limit = MAX_TITLE_LENGTH): string {
    const line = text.split("\n", 1)[0] ?? "";
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pathLocations(args: Record<string, unknown>): ToolCallLocation[] {
    const locations: ToolCallLocation[] = [];
    for (const key of ["path", "file_path", "filePath", "file"]) {
        const path = asString(args[key]);
        if (path !== undefined) {
            locations.push({ path });
            break;
        }
    }
    return locations;
}

/**
 * Classify a harness tool call for ACP presentation. Covers the tool names
 * mounted by the bundled composition (bash, read/write/edit, str_replace_editor,
 * todo_write, subagent, skill, jobs) and falls back on name heuristics so
 * custom compositions still get sensible kinds.
 */
export function classifyToolCall(name: string, rawArguments: string): ToolCallFacts {
    let args: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(rawArguments);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
        }
    } catch {
        // Raw model output may be truncated JSON; keep the raw string visible.
        args = { arguments: rawArguments };
    }

    const locations = pathLocations(args);
    const path = locations[0]?.path;
    const facts = (kind: ToolKind, title: string): ToolCallFacts => ({
        kind,
        title,
        locations,
        rawInput: args,
    });

    switch (name) {
        case "bash": {
            const command = asString(args["command"]);
            const restart = args["restart"] === true;
            return facts("execute", command !== undefined ? firstLine(command) : restart ? "Restart bash" : "bash");
        }
        case "read":
            return facts("read", path !== undefined ? `Read ${path}` : "Read file");
        case "write":
            return facts("edit", path !== undefined ? `Write ${path}` : "Write file");
        case "edit":
            return facts("edit", path !== undefined ? `Edit ${path}` : "Edit file");
        case "str_replace_editor": {
            const command = asString(args["command"]) ?? "edit";
            const kind: ToolKind = command === "view" ? "read" : "edit";
            return facts(kind, path !== undefined ? `${command} ${path}` : command);
        }
        case "todo_write":
            return facts("think", "Update plan");
        case "subagent":
        case "subagent_fork": {
            const task = asString(args["task"]) ?? asString(args["prompt"]);
            return facts("other", task !== undefined ? `Subagent: ${firstLine(task, 60)}` : "Subagent");
        }
        case "skill": {
            const skillName = asString(args["name"]) ?? asString(args["skill"]);
            return facts("other", skillName !== undefined ? `Skill: ${skillName}` : "Skill");
        }
        default:
            break;
    }

    const lowered = name.toLowerCase();
    if (/(^|_)(grep|glob|find|search|ls|list)($|_)/.test(lowered)) {
        const query = asString(args["query"]) ?? asString(args["pattern"]);
        return facts("search", query !== undefined ? `Search for '${firstLine(query, 50)}'` : name);
    }
    if (/(fetch|web|http|browse)/.test(lowered)) {
        const url = asString(args["url"]) ?? asString(args["query"]);
        return facts("fetch", url !== undefined ? `Fetch ${firstLine(url, 60)}` : name);
    }
    if (/(job|task|run|exec)/.test(lowered)) return facts("execute", name);
    return facts("other", name);
}

// ---------------------------------------------------------------------------
// Tool-result extraction
// ---------------------------------------------------------------------------

/** `dsh-tool-fs` result meta shape (`FsDiffMeta`), parsed defensively. */
export interface FileDiffMeta {
    path: string;
    oldText: string | null;
    newText: string;
}

/** Read `{ diffs: FileDiff[] }` from a tool result's opaque `meta`. */
export function diffsFromToolMeta(meta: unknown): FileDiffMeta[] {
    if (meta === null || typeof meta !== "object") return [];
    const diffs = (meta as Record<string, unknown>)["diffs"];
    if (!Array.isArray(diffs)) return [];
    const result: FileDiffMeta[] = [];
    for (const entry of diffs) {
        if (entry === null || typeof entry !== "object") continue;
        const diff = entry as Record<string, unknown>;
        const path = asString(diff["path"]);
        const newText = diff["newText"];
        const oldText = diff["oldText"];
        if (path === undefined || typeof newText !== "string") continue;
        result.push({ path, oldText: typeof oldText === "string" ? oldText : null, newText });
    }
    return result;
}

interface ToolResultFacts {
    failed: boolean;
    text: string;
    diffs: FileDiffMeta[];
}

function acknowledgementId(text: string, prefix: string): string | undefined {
    if (!text.startsWith(prefix)) return undefined;
    const id = text.slice(prefix.length);
    if (id.length === 0 || id.trim() !== id || id.includes(" ") || id.includes("\t") || id.includes("\n")) {
        return undefined;
    }
    return id;
}

/** Restore typed handles from DSH's documented background-result renderings. */
function typedToolAcknowledgement(
    state: ProjectedToolCall | undefined,
    text: string,
    failed: boolean,
): Record<string, unknown> | undefined {
    if (state === undefined || failed) return undefined;
    if (state.name === "bash" || state.name === "pwsh") {
        const jobId = acknowledgementId(text, "started background job ");
        return jobId === undefined ? undefined : { kind: "background", jobId };
    }
    if (state.name === "subagent") {
        const jobId = acknowledgementId(text, "started background subagent job ");
        if (jobId !== undefined) return { kind: "background", jobId };
        const subagentId = acknowledgementId(text, "started subagent ");
        if (subagentId !== undefined) return { kind: "continuable", subagentId };
    }
    return undefined;
}

function extractToolResult(data: Record<string, unknown>): ToolResultFacts {
    let failed = data["error"] !== undefined && data["error"] !== null;
    const parts: string[] = [];
    const message = data["message"];
    const content =
        message !== null && typeof message === "object"
            ? (message as Record<string, unknown>)["content"]
            : undefined;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block === null || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if (b["type"] !== "tool-result") continue;
            if (b["isError"] === true) failed = true;
            const inner = b["content"];
            if (!Array.isArray(inner)) continue;
            for (const innerBlock of inner) {
                if (innerBlock === null || typeof innerBlock !== "object") continue;
                const ib = innerBlock as Record<string, unknown>;
                if (ib["type"] === "text" && typeof ib["text"] === "string") parts.push(ib["text"]);
            }
        }
    }
    let text = parts.join("");
    if (text.length > MAX_RESULT_TEXT) text = `${text.slice(0, MAX_RESULT_TEXT)}\n… (truncated)`;
    return { failed, text, diffs: diffsFromToolMeta(data["meta"]) };
}

// ---------------------------------------------------------------------------
// Assistant / user message text extraction
// ---------------------------------------------------------------------------

interface MessageTexts {
    text: string;
    reasoning: string;
}

function extractMessageTexts(message: unknown): MessageTexts {
    const texts: string[] = [];
    const reasoning: string[] = [];
    const content =
        message !== null && typeof message === "object"
            ? (message as Record<string, unknown>)["content"]
            : undefined;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block === null || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if (b["type"] === "text" && typeof b["text"] === "string") texts.push(b["text"]);
            else if (b["type"] === "reasoning" && typeof b["text"] === "string") reasoning.push(b["text"]);
            else if (b["type"] === "image") texts.push("[image attachment]");
        }
    }
    return { text: texts.join(""), reasoning: reasoning.join("") };
}

// ---------------------------------------------------------------------------
// Plan (todo) mapping
// ---------------------------------------------------------------------------

function planEntries(data: Record<string, unknown>): PlanEntry[] | undefined {
    const todos = data["todos"];
    if (!Array.isArray(todos)) return undefined;
    const entries: PlanEntry[] = [];
    for (const todo of todos) {
        if (todo === null || typeof todo !== "object") continue;
        const t = todo as Record<string, unknown>;
        const content = asString(t["content"]);
        const status = t["status"];
        if (content === undefined) continue;
        entries.push({
            content,
            priority: "medium",
            status: status === "in_progress" || status === "completed" ? status : "pending",
        });
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

/**
 * Map a harness turn ending to ACP's stop-reason vocabulary.
 *
 * `aborted` by the user (or bridge disposal) is a client cancellation;
 * hook/parent aborts are ordinary quiescence. `error` is not mapped here —
 * failed turns surface as JSON-RPC errors on `session/prompt` instead.
 */
export function turnEndToStopReason(reason: TurnEndReason | undefined): StopReason {
    switch (reason?.kind) {
        case "completed":
            return "end_turn";
        case "max-tokens":
            return "max_tokens";
        case "blocked":
            return "refusal";
        case "interrupted":
            return "cancelled";
        case "aborted": {
            const cause = reason.reason?.kind;
            return cause === "user" || cause === "disposed" ? "cancelled" : "end_turn";
        }
        default:
            return "end_turn";
    }
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

interface UsageTotals {
    input: number;
    output: number;
    cachedRead: number;
    cachedWrite: number;
    thought: number;
}

/** Per-prompt accumulators, reset by {@link SessionProjection.beginPrompt}. */
interface PromptWindow {
    usage: UsageTotals;
    sawUsage: boolean;
    turnEnds: Map<number, TurnEndReason>;
    lastTurnEnd: TurnEndReason | undefined;
    error: { message: string } | undefined;
}

function emptyWindow(): PromptWindow {
    return {
        usage: { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, thought: 0 },
        sawUsage: false,
        turnEnds: new Map(),
        lastTurnEnd: undefined,
        error: undefined,
    };
}

/** Optional `presentCall` card used instead of the name heuristic. */
export interface ToolPresentView {
    card?: string;
    title?: string;
    kind?: string;
    locations?: { path: string; line?: number }[];
}

const TOOL_KINDS = new Set<ToolKind>([
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
]);

/**
 * Map a tool-owned `presentCall` card onto ACP tool-call facts.
 * Unknown kinds and empty titles fall back to {@link classifyToolCall}.
 */
function factsFromPresentCall(
    name: string,
    rawArguments: string,
    presented: ToolPresentView,
): ToolCallFacts {
    const fallback = classifyToolCall(name, rawArguments);
    const kind =
        presented.kind !== undefined && TOOL_KINDS.has(presented.kind as ToolKind)
            ? (presented.kind as ToolKind)
            : fallback.kind;
    const title =
        presented.title !== undefined && presented.title.length > 0 ? presented.title : fallback.title;
    const locations =
        presented.locations !== undefined && presented.locations.length > 0
            ? presented.locations.map((location) =>
                  location.line === undefined
                      ? { path: location.path }
                      : { path: location.path, line: location.line },
              )
            : fallback.locations;
    return { kind, title, locations, rawInput: fallback.rawInput };
}

/**
 * Stateful projection of one harness session's event stream onto ACP updates.
 *
 * Owns streaming bookkeeping (which steps already streamed deltas so the
 * assembled message is not duplicated), tool-call registry, context-window
 * knowledge, per-prompt usage accumulation, and turn-ending capture.
 *
 */
export class SessionProjection {
    /** Context capacity from the latest `request/context` event, when known. */
    contextWindow: number | undefined;
    /** Latest `session/title` text observed on the log. */
    title: string | undefined;

    private streamedText = new Set<string>();
    private streamedReasoning = new Set<string>();
    /** Structured tool values observed live before DSH omits them from its durable event. */
    private toolResultValues = new Map<string, unknown>();
    /** One authoritative state per open ACP tool call. Block indexes only
     * route streaming fragments to that state; they never own lifecycle. */
    private toolCalls = new Map<string, ProjectedToolCall>();
    private toolCallBlocks = new Map<string, string>();
    private window: PromptWindow = emptyWindow();
    private lastContextUse: number | undefined;
    /** Client renders `_meta.terminal_output` display terminals (Zed extension). */
    private readonly terminalOutput: boolean;
    /** Session working directory, advertised on display terminals. */
    private readonly cwd: string | undefined;
    private readonly presentCall: ((name: string, args: unknown) => ToolPresentView | undefined) | undefined;
    private readonly subagent: SubagentAttribution | undefined;

    constructor(
        contextWindow?: number,
        options?: {
            terminalOutput?: boolean;
            cwd?: string;
            presentCall?: (name: string, args: unknown) => ToolPresentView | undefined;
            subagent?: SubagentAttribution;
        },
    ) {
        this.contextWindow = contextWindow;
        this.terminalOutput = options?.terminalOutput ?? false;
        this.cwd = options?.cwd;
        this.presentCall = options?.presentCall;
        this.subagent = options?.subagent;
    }

    /** Stage one live `tools/result` value for the matching durable `tool/result` event. */
    recordToolResult(callId: string, value: unknown): void {
        this.toolResultValues.set(callId, value);
    }

    /** Reset per-prompt accumulators; call when a new `session/prompt` starts. */
    beginPrompt(): void {
        this.window = emptyWindow();
        this.toolCallBlocks.clear();
    }

    /** The captured ending for a specific turn, when it already ended. */
    turnEndFor(turn: number): TurnEndReason | undefined {
        return this.window.turnEnds.get(turn);
    }

    /** The last turn ending inside the current prompt window. */
    get lastTurnEnd(): TurnEndReason | undefined {
        return this.window.lastTurnEnd;
    }

    /** The first failed-turn error inside the current prompt window. */
    get turnError(): { message: string } | undefined {
        return this.window.error;
    }

    /** Accumulated ACP usage for the current prompt window. */
    promptUsage(): Usage | undefined {
        if (!this.window.sawUsage) return undefined;
        const { input, output, cachedRead, cachedWrite, thought } = this.window.usage;
        return {
            totalTokens: input + output + cachedRead + cachedWrite,
            inputTokens: input,
            outputTokens: output,
            ...(thought > 0 ? { thoughtTokens: thought } : {}),
            ...(cachedRead > 0 ? { cachedReadTokens: cachedRead } : {}),
            ...(cachedWrite > 0 ? { cachedWriteTokens: cachedWrite } : {}),
        };
    }

    /**
     * Project one session event onto zero or more ACP updates.
     */
    onEvent(event: HarnessEvent): SessionUpdate[] {
        const updates = this.projectEvent(event);
        return this.subagent === undefined
            ? updates
            : updates.map((update) => this.withSubagentAttribution(update));
    }

    /** Project one event before optional subagent attribution is attached. */
    private projectEvent(event: HarnessEvent): SessionUpdate[] {
        const data = event.data ?? {};
        switch (event.type) {
            case "assistant/chunk":
                return this.onChunk(data);
            case "tool-call-chunks":
                return this.onToolCallChunks(data);
            case "assistant/message":
                return this.onAssistantMessage(data);
            case "tool/call":
                return this.onToolCall(data);
            case "tool/result":
                return this.onToolResult(data);
            case "subagent/start":
                return this.onSubagentStart(data);
            case "subagent/end":
                return this.onSubagentEnd(data);
            case "todo/write": {
                const entries = planEntries(data);
                return entries !== undefined ? [{ sessionUpdate: "plan", entries }] : [];
            }
            case "user/message": {
                const source = data["source"];
                const kind =
                    source !== null && typeof source === "object"
                        ? asString((source as Record<string, unknown>)["kind"])
                        : undefined;
                if (kind === undefined || kind === "user") return [];
                const content = data["content"];
                const text = Array.isArray(content)
                    ? content
                          .filter(
                              (block): block is Record<string, unknown> =>
                                  block !== null &&
                                  typeof block === "object" &&
                                  (block as Record<string, unknown>)["type"] === "text" &&
                                  typeof (block as Record<string, unknown>)["text"] === "string",
                          )
                          .map((block) => block["text"] as string)
                          .join("")
                    : "";
                return [
                    {
                        sessionUpdate: "session_info_update",
                        _meta: {
                            dsh: {
                                event: "user/message",
                                source: kind,
                                preview: Array.from(text).slice(0, 160).join(""),
                            },
                        },
                    } as SessionUpdate,
                ];
            }
            case "turn/end":
                return this.onTurnEnd(data);
            case "request/context": {
                const contextWindow = data["contextWindow"];
                if (typeof contextWindow === "number" && contextWindow > 0) this.contextWindow = contextWindow;
                return [];
            }
            case "session/title": {
                const title = asString(data["title"]);
                if (title === undefined || title === this.title) return [];
                this.title = title;
                return [{ sessionUpdate: "session_info_update", title, updatedAt: new Date().toISOString() }];
            }
            default:
                return [];
        }
    }

    private stepKey(data: Record<string, unknown>): string {
        return `${String(data["turn"])}:${String(data["step"])}`;
    }

    private withSubagentAttribution(update: SessionUpdate): SessionUpdate {
        const value = update as unknown as Record<string, unknown>;
        const meta =
            value["_meta"] !== null && typeof value["_meta"] === "object"
                ? (value["_meta"] as Record<string, unknown>)
                : {};
        const dsh =
            meta["dsh"] !== null && typeof meta["dsh"] === "object"
                ? (meta["dsh"] as Record<string, unknown>)
                : {};
        return {
            ...value,
            _meta: { ...meta, dsh: { ...dsh, subagent: this.subagent } },
        } as unknown as SessionUpdate;
    }

    private subagentMeta(data: Record<string, unknown>, state: "started" | "finished"): Record<string, unknown> | undefined {
        const runId = asString(data["runId"]);
        const childSessionId = asString(data["id"]);
        const provider = asString(data["provider"]);
        if (runId === undefined || childSessionId === undefined || provider === undefined) return undefined;
        const parentToolCallId = asString(data["parentToolCallId"]);
        return {
            state,
            runId,
            childSessionId,
            provider,
            local: data["local"] === true,
            ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
        };
    }

    private onSubagentStart(data: Record<string, unknown>): SessionUpdate[] {
        const subagent = this.subagentMeta(data, "started");
        if (subagent === undefined) return [];
        return [{
            sessionUpdate: "session_info_update",
            _meta: { dsh: { event: "subagent/lifecycle", subagent } },
        } as unknown as SessionUpdate];
    }

    private onSubagentEnd(data: Record<string, unknown>): SessionUpdate[] {
        const subagent = this.subagentMeta(data, "finished");
        if (subagent === undefined) return [];
        const stopReason = asString(data["stopReason"]) ?? "error";
        return [{
            sessionUpdate: "session_info_update",
            _meta: {
                dsh: {
                    event: "subagent/lifecycle",
                    subagent: { ...subagent, stopReason },
                },
            },
        } as unknown as SessionUpdate];
    }

    private onChunk(data: Record<string, unknown>): SessionUpdate[] {
        const chunk = data["chunk"];
        if (chunk === null || typeof chunk === "undefined" || typeof chunk !== "object") return [];
        const c = chunk as Record<string, unknown>;
        if (c["type"] === "block-end") return this.onToolCallBlockEnd(data, c);
        if (c["type"] === "tool-call-delta") return this.onToolCallDelta(data, c);
        const text = c["text"];
        if (typeof text !== "string" || text.length === 0) return [];
        const messageId = this.stepKey(data);
        if (c["type"] === "text-delta") {
            this.streamedText.add(messageId);
            return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId }];
        }
        if (c["type"] === "reasoning-delta") {
            this.streamedReasoning.add(messageId);
            return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text }, messageId }];
        }
        return [];
    }

    private toolBlockKey(data: Record<string, unknown>, index: number): string {
        return `${this.stepKey(data)}:${index}`;
    }

    private onToolCallDelta(
        data: Record<string, unknown>,
        chunk: Record<string, unknown>,
    ): SessionUpdate[] {
        const callId = asString(chunk["id"]);
        const index = chunk["index"];
        const argumentsDelta = chunk["argumentsDelta"];
        if (
            callId === undefined ||
            typeof index !== "number" ||
            !Number.isInteger(index) ||
            typeof argumentsDelta !== "string"
        ) {
            return [];
        }
        const current = this.toolCalls.get(callId);
        const name = asString(chunk["name"]) ?? current?.name;
        if (name === undefined) return [];
        const rawArguments = `${current?.arguments ?? ""}${argumentsDelta}`;
        const state: ProjectedToolCall = {
            callId,
            name,
            arguments: rawArguments,
            facts: this.toolCallFacts(name, rawArguments),
            status: current?.status ?? "pending",
        };
        this.toolCalls.set(callId, state);
        this.toolCallBlocks.set(this.toolBlockKey(data, index), callId);
        if (current === undefined) return [this.toolCallCreated(state)];
        return [{
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            title: state.facts.title,
            name,
            kind: state.facts.kind,
            status: "pending",
            rawInput: state.facts.rawInput,
            ...(state.facts.locations.length > 0 ? { locations: state.facts.locations } : {}),
        } as SessionUpdate];
    }

    private onToolCallChunks(data: Record<string, unknown>): SessionUpdate[] {
        const callId = asString(data["id"]);
        const name = asString(data["name"]);
        const index = data["index"];
        const args = data["args"];
        if (
            callId === undefined ||
            name === undefined ||
            typeof index !== "number" ||
            !Number.isInteger(index) ||
            !Array.isArray(args)
        ) {
            return [];
        }
        const key = this.toolBlockKey(data, index);
        const current = this.toolCalls.get(callId);
        const fragments = args.filter((fragment): fragment is string => typeof fragment === "string").join("");
        const rawArguments = `${current?.arguments ?? ""}${fragments}`;
        const state: ProjectedToolCall = {
            callId,
            name,
            arguments: rawArguments,
            facts: this.toolCallFacts(name, rawArguments),
            status: current?.status ?? "pending",
        };
        this.toolCalls.set(callId, state);
        this.toolCallBlocks.set(key, callId);
        // ACP `pending` explicitly covers input that is still streaming. The
        // first fragment is the earliest event carrying a stable call id/name,
        // so create the row now instead of waiting for the whole batch.
        return current === undefined ? [this.toolCallCreated(state)] : [];
    }

    private onToolCallBlockEnd(
        data: Record<string, unknown>,
        chunk: Record<string, unknown>,
    ): SessionUpdate[] {
        const index = chunk["index"];
        if (typeof index !== "number" || !Number.isInteger(index)) return [];
        const key = this.toolBlockKey(data, index);
        const callId = this.toolCallBlocks.get(key);
        this.toolCallBlocks.delete(key);
        const block = chunk["block"];
        const complete = block !== null && typeof block === "object"
            ? (block as Record<string, unknown>)
            : undefined;
        const completeCallId = complete?.["type"] === "tool-call" ? asString(complete["id"]) : undefined;
        const resolvedCallId = callId ?? completeCallId;
        if (resolvedCallId === undefined) return [];
        const current = this.toolCalls.get(resolvedCallId);
        const name = (complete?.["type"] === "tool-call" ? asString(complete["name"]) : undefined) ?? current?.name;
        if (name === undefined) return [];
        const rawArguments =
            (complete?.["type"] === "tool-call" && typeof complete["arguments"] === "string"
                ? complete["arguments"]
                : undefined) ?? current?.arguments ?? "{}";
        const state: ProjectedToolCall = {
            callId: resolvedCallId,
            name,
            arguments: rawArguments,
            facts: this.toolCallFacts(name, rawArguments),
            status: current?.status ?? "pending",
        };
        this.toolCalls.set(resolvedCallId, state);
        if (current === undefined) return [this.toolCallCreated(state)];
        return [{
            sessionUpdate: "tool_call_update",
            toolCallId: resolvedCallId,
            title: state.facts.title,
            kind: state.facts.kind,
            rawInput: state.facts.rawInput,
            locations: state.facts.locations,
        } as SessionUpdate];
    }

    private onAssistantMessage(data: Record<string, unknown>): SessionUpdate[] {
        const updates: SessionUpdate[] = [];
        const key = this.stepKey(data);
        const message = data["message"];
        const { text, reasoning } = extractMessageTexts(message);
        const model =
            message !== null && typeof message === "object"
                ? asString(
                      (message as Record<string, unknown>)["source"] !== null &&
                          typeof (message as Record<string, unknown>)["source"] === "object"
                          ? ((message as Record<string, unknown>)["source"] as Record<string, unknown>)["model"]
                          : undefined,
                  )
                : undefined;
        const completionMeta = {
            dsh: {
                event: "assistant_message",
                ...(model !== undefined ? { model } : {}),
            },
        };
        // The assembled message is the durable source of truth; emit it only
        // when the adapter streamed no deltas for this step (some adapters or
        // replays carry no chunk events).
        if (reasoning.length > 0 && !this.streamedReasoning.has(key)) {
            updates.push({
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: reasoning },
                messageId: key,
            });
        }
        if (text.length > 0 && !this.streamedText.has(key)) {
            updates.push({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
                messageId: key,
                _meta: completionMeta,
            } as SessionUpdate);
        } else {
            // ACP has standard message identity but no message-complete update.
            // A metadata-only empty chunk closes the step without duplicating
            // streamed text; clients that do not understand the metadata see
            // no additional content.
            updates.push({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "" },
                messageId: key,
                _meta: completionMeta,
            } as SessionUpdate);
        }
        this.streamedText.delete(key);
        this.streamedReasoning.delete(key);

        const usage = data["usage"];
        if (usage !== null && typeof usage === "object") {
            const u = usage as Record<string, unknown>;
            const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
            const input = num(u["inputTokens"]);
            const output = num(u["outputTokens"]);
            const cachedRead = num(u["cacheReadTokens"]);
            const cachedWrite = num(u["cacheWriteTokens"]);
            this.window.usage.input += input;
            this.window.usage.output += output;
            this.window.usage.cachedRead += cachedRead;
            this.window.usage.cachedWrite += cachedWrite;
            this.window.usage.thought += num(u["reasoningTokens"]);
            this.window.sawUsage = true;
            // Context use ≈ this step's full request + response footprint.
            this.lastContextUse = input + cachedRead + cachedWrite + output;
            if (this.contextWindow !== undefined && this.lastContextUse > 0) {
                updates.push({
                    sessionUpdate: "usage_update",
                    used: this.lastContextUse,
                    size: this.contextWindow,
                });
            }
        }
        return updates;
    }

    private toolCallFacts(name: string, rawArguments: string): ToolCallFacts {
        let parsedArgs: unknown = {};
        try {
            parsedArgs = JSON.parse(rawArguments);
        } catch {
            parsedArgs = { arguments: rawArguments };
        }
        const presented = this.presentCall?.(name, parsedArgs);
        return presented !== undefined
            ? factsFromPresentCall(name, rawArguments, presented)
            : classifyToolCall(name, rawArguments);
    }

    private toolCallCreated(state: ProjectedToolCall): SessionUpdate {
        const { callId, name, facts, status } = state;
        const displayTerminal = this.terminalOutput && facts.kind === "execute";
        return {
            sessionUpdate: "tool_call",
            toolCallId: callId,
            title: facts.title,
            name,
            kind: facts.kind,
            status,
            rawInput: facts.rawInput,
            ...(facts.locations.length > 0 ? { locations: facts.locations } : {}),
            ...(displayTerminal
                ? {
                      content: [{ type: "terminal", terminalId: callId }],
                      _meta: {
                          terminal_info: {
                              terminal_id: callId,
                              ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
                          },
                      },
                  }
                : {}),
        } as unknown as SessionUpdate;
    }

    private onToolCall(data: Record<string, unknown>): SessionUpdate[] {
        const callId = asString(data["callId"]);
        const name = asString(data["name"]) ?? "tool";
        if (callId === undefined) return [];
        const rawArguments = typeof data["arguments"] === "string" ? (data["arguments"] as string) : "{}";
        const facts = this.toolCallFacts(name, rawArguments);
        const current = this.toolCalls.get(callId);
        const state: ProjectedToolCall = { callId, name, arguments: rawArguments, facts, status: "in_progress" };
        this.toolCalls.set(callId, state);
        if (current === undefined) return [this.toolCallCreated(state)];
        if (current.status === "in_progress" && current.arguments === rawArguments && current.name === name) return [];
        return [{
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            title: facts.title,
            name,
            kind: facts.kind,
            status: "in_progress",
            rawInput: facts.rawInput,
            locations: facts.locations,
        } as SessionUpdate];
    }

    private onToolResult(data: Record<string, unknown>): SessionUpdate[] {
        const message = data["message"];
        const callId =
            asString(
                message !== null && typeof message === "object"
                    ? ((): unknown => {
                          const content = (message as Record<string, unknown>)["content"];
                          if (!Array.isArray(content)) return undefined;
                          const block = content.find(
                              (b: unknown) =>
                                  b !== null && typeof b === "object" && (b as Record<string, unknown>)["type"] === "tool-result",
                          );
                          return block === undefined ? undefined : (block as Record<string, unknown>)["toolCallId"];
                      })()
                    : undefined,
            ) ?? asString(data["callId"]);
        if (callId === undefined) return [];
        const state = this.toolCalls.get(callId);
        const facts = state?.facts;
        const { failed, text, diffs } = extractToolResult(data);
        const hasLiveValue = this.toolResultValues.has(callId);
        const liveValue = this.toolResultValues.get(callId);
        this.toolResultValues.delete(callId);
        const toolResultValue = hasLiveValue ? liveValue : typedToolAcknowledgement(state, text, failed);
        const toolResultMeta =
            toolResultValue === undefined
                ? undefined
                : {
                      dsh: {
                          toolResult: {
                              value: toolResultValue,
                          },
                      },
                  };
        const rawOutput = text.length > 0 ? { output: text, isError: failed } : undefined;
        const content: ToolCallContent[] = diffs.map((diff) => ({
            type: "diff",
            path: diff.path,
            ...(diff.oldText !== null ? { oldText: diff.oldText } : {}),
            newText: diff.newText,
        }));
        const isCommand = facts?.kind === "execute";
        if (this.terminalOutput && isCommand) {
            // Display-terminal path: stream the whole captured output onto the
            // embedded terminal, then close it with the exit status. Content
            // stays empty — the terminal is the presentation.
            this.toolCalls.delete(callId);
            for (const [key, value] of this.toolCallBlocks) {
                if (value === callId) this.toolCallBlocks.delete(key);
            }
            return [
                ...(text.length > 0
                    ? [
                          {
                              sessionUpdate: "tool_call_update",
                              toolCallId: callId,
                              _meta: { terminal_output: { terminal_id: callId, data: text } },
                          } as unknown as SessionUpdate,
                      ]
                    : []),
                {
                    sessionUpdate: "tool_call_update",
                    toolCallId: callId,
                    status: failed ? "failed" : "completed",
                    ...(rawOutput !== undefined ? { rawOutput } : {}),
                    _meta: {
                        ...(toolResultMeta ?? {}),
                        terminal_exit: { terminal_id: callId, exit_code: failed ? 1 : 0, signal: null },
                    },
                } as unknown as SessionUpdate,
            ];
        }
        if (text.length > 0 && diffs.length === 0) {
            // Fenced output renders in tool-call cards (raw text does not in
            // every client); markdown-ish tool output passes through as is.
            const block: AcpContentBlock = {
                type: "text",
                text: isCommand ? `\`\`\`sh\n${text.replace(/\n+$/, "")}\n\`\`\`\n` : text,
            };
            content.push({ type: "content", content: block });
        }
        this.toolCalls.delete(callId);
        for (const [key, value] of this.toolCallBlocks) {
            if (value === callId) this.toolCallBlocks.delete(key);
        }
        return [
            {
                sessionUpdate: "tool_call_update",
                toolCallId: callId,
                status: failed ? "failed" : "completed",
                ...(content.length > 0 ? { content } : {}),
                ...(rawOutput !== undefined ? { rawOutput } : {}),
                ...(toolResultMeta !== undefined ? { _meta: toolResultMeta } : {}),
            },
        ];
    }

    private onTurnEnd(data: Record<string, unknown>): SessionUpdate[] {
        const reason = data["reason"];
        const turn = data["turn"];
        if (reason !== null && typeof reason === "object") {
            const r = reason as TurnEndReason;
            if (typeof turn === "number") this.window.turnEnds.set(turn, r);
            this.window.lastTurnEnd = r;
            if (r.kind === "error" && this.window.error === undefined) {
                this.window.error = { message: r.error?.message ?? "model turn failed" };
            }
        }
        this.toolCallBlocks.clear();
        this.toolCalls.clear();
        this.toolResultValues.clear();
        // A stopped prompt turn owns presentation settlement for any orphaned
        // calls. Do not rewrite `pending`/`in_progress` into a fabricated ACP
        // failure; clients already have the authoritative prompt boundary.
        return [];
    }
}
