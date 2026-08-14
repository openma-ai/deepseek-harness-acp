import { describe, expect, it } from "vitest";
import {
    SessionProjection,
    classifyToolCall,
    diffsFromToolMeta,
    turnEndToStopReason,
    type HarnessEvent,
} from "../src/bridge/translate.ts";

function event(type: string, data: Record<string, unknown>): HarnessEvent {
    return { type, data };
}

describe("classifyToolCall", () => {
    it("maps bash to execute with the command as title", () => {
        const facts = classifyToolCall("bash", JSON.stringify({ command: "npm test\necho done" }));
        expect(facts.kind).toBe("execute");
        expect(facts.title).toBe("npm test");
    });

    it("maps file tools to read/edit kinds with locations", () => {
        expect(classifyToolCall("read", JSON.stringify({ path: "/w/a.ts" }))).toMatchObject({
            kind: "read",
            title: "Read /w/a.ts",
            locations: [{ path: "/w/a.ts" }],
        });
        expect(classifyToolCall("write", JSON.stringify({ path: "/w/a.ts" })).kind).toBe("edit");
        expect(classifyToolCall("edit", JSON.stringify({ file_path: "/w/b.ts" })).locations).toEqual([
            { path: "/w/b.ts" },
        ]);
    });

    it("maps str_replace_editor view to read and mutations to edit", () => {
        expect(classifyToolCall("str_replace_editor", JSON.stringify({ command: "view", path: "/w" })).kind).toBe(
            "read",
        );
        expect(
            classifyToolCall("str_replace_editor", JSON.stringify({ command: "str_replace", path: "/w/x" })).kind,
        ).toBe("edit");
    });

    it("survives truncated JSON arguments", () => {
        const facts = classifyToolCall("bash", '{"command": "ls');
        expect(facts.kind).toBe("execute");
        expect(facts.rawInput).toEqual({ arguments: '{"command": "ls' });
    });

    it("classifies unknown tools by name heuristics", () => {
        expect(classifyToolCall("grep_search", JSON.stringify({ query: "foo" })).kind).toBe("search");
        expect(classifyToolCall("web_fetch", JSON.stringify({ url: "https://x" })).kind).toBe("fetch");
        expect(classifyToolCall("mystery", "{}").kind).toBe("other");
    });
});

describe("SessionProjection streaming", () => {
    it("streams text deltas and suppresses the assembled duplicate", () => {
        const p = new SessionProjection();
        const chunkUpdates = p.onEvent(
            event("assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "Hel" } }),
        );
        expect(chunkUpdates).toEqual([
            { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
        ]);
        const assembled = p.onEvent(
            event("assistant/message", {
                turn: 1,
                step: 0,
                message: { content: [{ type: "text", text: "Hello" }] },
            }),
        );
        expect(assembled).toEqual([]);
    });

    it("falls back to the assembled message when no deltas streamed", () => {
        const p = new SessionProjection();
        const updates = p.onEvent(
            event("assistant/message", {
                turn: 1,
                step: 0,
                message: { content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Hi" }] },
            }),
        );
        expect(updates).toEqual([
            { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
            { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } },
        ]);
    });

    it("streams reasoning deltas as thought chunks", () => {
        const p = new SessionProjection();
        const updates = p.onEvent(
            event("assistant/chunk", { turn: 1, step: 0, chunk: { type: "reasoning-delta", index: 0, text: "th" } }),
        );
        expect(updates[0]).toMatchObject({ sessionUpdate: "agent_thought_chunk" });
    });
});

describe("SessionProjection tool calls", () => {
    it("emits tool_call then a completed tool_call_update with text content", () => {
        const p = new SessionProjection();
        const start = p.onEvent(
            event("tool/call", { turn: 1, step: 0, callId: "c1", name: "bash", arguments: '{"command":"ls"}' }),
        );
        expect(start[0]).toMatchObject({
            sessionUpdate: "tool_call",
            toolCallId: "c1",
            kind: "execute",
            status: "in_progress",
            title: "ls",
        });
        const done = p.onEvent(
            event("tool/result", {
                turn: 1,
                step: 0,
                message: {
                    content: [
                        { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "a.ts\n" }] },
                    ],
                },
            }),
        );
        expect(done[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: "c1",
            status: "completed",
            // Command output renders as a fenced block (raw text does not
            // render in every client's tool-call card).
            content: [{ type: "content", content: { type: "text", text: "```sh\na.ts\n```\n" } }],
            rawOutput: { output: "a.ts\n", isError: false },
        });
    });

    it("streams command output onto a display terminal when the client supports one", () => {
        const p = new SessionProjection(undefined, { terminalOutput: true, cwd: "/ws" });
        const start = p.onEvent(
            event("tool/call", { turn: 1, step: 0, callId: "t1", name: "bash", arguments: '{"command":"pwd"}' }),
        );
        expect(start[0]).toMatchObject({
            sessionUpdate: "tool_call",
            content: [{ type: "terminal", terminalId: "t1" }],
            _meta: { terminal_info: { terminal_id: "t1", cwd: "/ws" } },
        });
        const done = p.onEvent(
            event("tool/result", {
                turn: 1,
                step: 0,
                message: {
                    content: [
                        { type: "tool-result", toolCallId: "t1", content: [{ type: "text", text: "/ws\n" }] },
                    ],
                },
            }),
        );
        expect(done[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            _meta: { terminal_output: { terminal_id: "t1", data: "/ws\n" } },
        });
        expect(done[1]).toMatchObject({
            sessionUpdate: "tool_call_update",
            status: "completed",
            _meta: { terminal_exit: { terminal_id: "t1", exit_code: 0, signal: null } },
        });
        expect((done[1] as Record<string, unknown>)["content"]).toBeUndefined();
    });

    it("marks failed results and carries fs diffs as diff content", () => {
        const p = new SessionProjection();
        p.onEvent(event("tool/call", { turn: 1, step: 0, callId: "c2", name: "edit", arguments: "{}" }));
        const failed = p.onEvent(
            event("tool/result", {
                turn: 1,
                step: 0,
                error: { name: "ToolError", code: "E" },
                message: {
                    content: [
                        {
                            type: "tool-result",
                            toolCallId: "c2",
                            isError: true,
                            content: [{ type: "text", text: "nope" }],
                        },
                    ],
                },
            }),
        );
        expect(failed[0]).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });

        p.onEvent(event("tool/call", { turn: 1, step: 1, callId: "c3", name: "edit", arguments: "{}" }));
        const withDiff = p.onEvent(
            event("tool/result", {
                turn: 1,
                step: 1,
                message: { content: [{ type: "tool-result", toolCallId: "c3", content: [] }] },
                meta: { diffs: [{ path: "/w/a.ts", oldText: "a", newText: "b" }] },
            }),
        );
        expect(withDiff[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            status: "completed",
            content: [{ type: "diff", path: "/w/a.ts", oldText: "a", newText: "b" }],
        });
    });
});

describe("diffsFromToolMeta", () => {
    it("parses well-formed diffs and drops junk", () => {
        expect(
            diffsFromToolMeta({
                diffs: [
                    { path: "/a", oldText: null, newText: "x" },
                    { path: 42, newText: "y" },
                    "junk",
                ],
            }),
        ).toEqual([{ path: "/a", oldText: null, newText: "x" }]);
        expect(diffsFromToolMeta(undefined)).toEqual([]);
        expect(diffsFromToolMeta({ diffs: "no" })).toEqual([]);
    });
});

describe("plans, usage, titles, turn ends", () => {
    it("maps todo/write onto a plan update", () => {
        const p = new SessionProjection();
        const updates = p.onEvent(
            event("todo/write", {
                todos: [
                    { content: "a", status: "completed" },
                    { content: "b", status: "in_progress" },
                    { content: "c", status: "bogus" },
                ],
            }),
        );
        expect(updates).toEqual([
            {
                sessionUpdate: "plan",
                entries: [
                    { content: "a", priority: "medium", status: "completed" },
                    { content: "b", priority: "medium", status: "in_progress" },
                    { content: "c", priority: "medium", status: "pending" },
                ],
            },
        ]);
    });

    it("accumulates usage and reports context pressure once the window is known", () => {
        const p = new SessionProjection();
        p.onEvent(event("request/context", { provider: "p", model: "m", contextWindow: 1000 }));
        const updates = p.onEvent(
            event("assistant/message", {
                turn: 1,
                step: 0,
                message: { content: [{ type: "text", text: "x" }] },
                usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, reasoningTokens: 5 },
            }),
        );
        expect(updates.at(-1)).toEqual({ sessionUpdate: "usage_update", used: 170, size: 1000 });
        expect(p.promptUsage()).toEqual({
            totalTokens: 170,
            inputTokens: 100,
            outputTokens: 20,
            thoughtTokens: 5,
            cachedReadTokens: 50,
        });
    });

    it("resets usage per prompt window", () => {
        const p = new SessionProjection();
        p.onEvent(
            event("assistant/message", {
                turn: 1,
                step: 0,
                message: { content: [] },
                usage: { inputTokens: 10, outputTokens: 1 },
            }),
        );
        p.beginPrompt();
        expect(p.promptUsage()).toBeUndefined();
    });

    it("captures turn endings by turn number and emits session titles", () => {
        const p = new SessionProjection();
        p.onEvent(event("turn/end", { turn: 3, reason: { kind: "completed" } }));
        expect(p.turnEndFor(3)).toEqual({ kind: "completed" });
        const titleUpdates = p.onEvent(event("session/title", { title: "Fix the tests" }));
        expect(titleUpdates[0]).toMatchObject({ sessionUpdate: "session_info_update", title: "Fix the tests" });
        expect(p.onEvent(event("session/title", { title: "Fix the tests" }))).toEqual([]);
    });
});

describe("turnEndToStopReason", () => {
    it("maps the harness vocabulary onto ACP stop reasons", () => {
        expect(turnEndToStopReason({ kind: "completed" })).toBe("end_turn");
        expect(turnEndToStopReason({ kind: "max-tokens" })).toBe("max_tokens");
        expect(turnEndToStopReason({ kind: "blocked" })).toBe("refusal");
        expect(turnEndToStopReason({ kind: "interrupted" })).toBe("cancelled");
        expect(turnEndToStopReason({ kind: "aborted", reason: { kind: "user" } })).toBe("cancelled");
        expect(turnEndToStopReason({ kind: "aborted", reason: { kind: "hook" } })).toBe("end_turn");
        expect(turnEndToStopReason(undefined)).toBe("end_turn");
    });
});
