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
    it("projects subagent lifecycle as metadata-only session updates", () => {
        const p = new SessionProjection();

        expect(
            p.onEvent(
                event("subagent/start", {
                    runId: "run-1",
                    provider: "local",
                    id: "child-1",
                    local: true,
                    parentToolCallId: "subagent:parent-run",
                }),
            ),
        ).toEqual([
            {
                sessionUpdate: "session_info_update",
                _meta: {
                    dsh: {
                        event: "subagent/lifecycle",
                        subagent: {
                            state: "started",
                            runId: "run-1",
                            childSessionId: "child-1",
                            provider: "local",
                            local: true,
                            parentToolCallId: "subagent:parent-run",
                        },
                    },
                },
            },
        ]);

        expect(
            p.onEvent(
                event("subagent/end", {
                    runId: "run-1",
                    provider: "local",
                    id: "child-1",
                    local: true,
                    stopReason: "completed",
                    lastAssistantMessage: [{ type: "text", text: "done" }],
                    parentToolCallId: "subagent:parent-run",
                }),
            ),
        ).toEqual([
            {
                sessionUpdate: "session_info_update",
                _meta: {
                    dsh: {
                        event: "subagent/lifecycle",
                        subagent: {
                            state: "finished",
                            runId: "run-1",
                            childSessionId: "child-1",
                            provider: "local",
                            local: true,
                            parentToolCallId: "subagent:parent-run",
                            stopReason: "completed",
                        },
                    },
                },
            },
        ]);
    });

    it("attributes nested child updates to their subagent tool call", () => {
        const p = new SessionProjection(undefined, {
            subagent: {
                childSessionId: "child-1",
                parentToolCallId: "subagent:run-1",
                provider: "local",
            },
        } as never);

        expect(
            p.onEvent(
                event("assistant/chunk", {
                    turn: 1,
                    step: 0,
                    chunk: { type: "text-delta", index: 0, text: "child says hi" },
                }),
            ),
        ).toEqual([
            {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "child says hi" },
                messageId: "1:0",
                _meta: {
                    dsh: {
                        subagent: {
                            childSessionId: "child-1",
                            parentToolCallId: "subagent:run-1",
                            provider: "local",
                        },
                    },
                },
            },
        ]);
    });

    it("puts the standard ACP messageId on streamed assistant chunks", () => {
        const p = new SessionProjection();
        const updates = p.onEvent(
            event("assistant/chunk", {
                turn: 2,
                step: 3,
                chunk: { type: "text-delta", index: 0, text: "hi" },
            }),
        );

        expect(updates[0]).toMatchObject({
            sessionUpdate: "agent_message_chunk",
            messageId: "2:3",
        });
    });

    it("marks an assembled assistant message complete without duplicating streamed text", () => {
        const p = new SessionProjection();
        p.onEvent(
            event("assistant/chunk", {
                turn: 2,
                step: 3,
                chunk: { type: "text-delta", index: 0, text: "hi" },
            }),
        );

        const updates = p.onEvent(
            event("assistant/message", {
                turn: 2,
                step: 3,
                message: {
                    content: [{ type: "text", text: "hi" }],
                    source: { model: "deepseek-v4" },
                },
            }),
        );

        expect(updates).toEqual([
            {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "" },
                messageId: "2:3",
                _meta: {
                    dsh: { event: "assistant_message", model: "deepseek-v4" },
                },
            },
        ]);
    });

    it("streams text deltas and suppresses the assembled duplicate", () => {
        const p = new SessionProjection();
        const chunkUpdates = p.onEvent(
            event("assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "Hel" } }),
        );
        expect(chunkUpdates).toEqual([
            {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Hel" },
                messageId: "1:0",
            },
        ]);
        const assembled = p.onEvent(
            event("assistant/message", {
                turn: 1,
                step: 0,
                message: { content: [{ type: "text", text: "Hello" }] },
            }),
        );
        expect(assembled).toEqual([
            {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "" },
                messageId: "1:0",
                _meta: { dsh: { event: "assistant_message" } },
            },
        ]);
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
            {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: "hmm" },
                messageId: "1:0",
            },
            {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Hi" },
                messageId: "1:0",
                _meta: { dsh: { event: "assistant_message" } },
            },
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
    it("publishes a live tool request and streams later input into the same row", () => {
        const p = new SessionProjection();

        expect(
            p.onEvent(
                event("assistant/chunk", {
                    turn: 1,
                    step: 0,
                    chunk: {
                        type: "tool-call-delta",
                        index: 1,
                        id: "c-live",
                        name: "subagent",
                        argumentsDelta: "",
                    },
                }),
            ),
        ).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call",
                toolCallId: "c-live",
                name: "subagent",
                status: "pending",
            }),
        ]);

        expect(
            p.onEvent(
                event("assistant/chunk", {
                    turn: 1,
                    step: 0,
                    chunk: {
                        type: "tool-call-delta",
                        index: 1,
                        id: "c-live",
                        argumentsDelta: '{"description":"first","prompt":"one"}',
                    },
                }),
            ),
        ).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "c-live",
                status: "pending",
                rawInput: { description: "first", prompt: "one" },
            }),
        ]);

        expect(
            p.onEvent(
                event("assistant/chunk", {
                    turn: 1,
                    step: 0,
                    chunk: {
                        type: "block-end",
                        index: 1,
                        block: {
                            type: "tool-call",
                            id: "c-live",
                            name: "subagent",
                            arguments: '{"description":"first","prompt":"one"}',
                        },
                    },
                }),
            ),
        ).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "c-live",
                rawInput: { description: "first", prompt: "one" },
            }),
        ]);
    });

    it("publishes each tool request while its own input is streaming", () => {
        const p = new SessionProjection();

        expect(
            p.onEvent(
                event("tool-call-chunks", {
                    turn: 1,
                    step: 0,
                    index: 1,
                    id: "c1",
                    name: "subagent",
                    args: ['{"description":"first",', '"prompt":"one"}'],
                }),
            ),
        ).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call",
                toolCallId: "c1",
                name: "subagent",
                status: "pending",
            }),
        ]);
        const first = p.onEvent(
            event("assistant/chunk", {
                turn: 1,
                step: 0,
                chunk: { type: "block-end", index: 1 },
            }),
        );
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: "c1",
            rawInput: { description: "first", prompt: "one" },
        });

        expect(p.onEvent(
            event("tool-call-chunks", {
                turn: 1,
                step: 0,
                index: 2,
                id: "c2",
                name: "subagent",
                args: ['{"description":"second","prompt":"two"}'],
            }),
        )).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call",
                toolCallId: "c2",
                status: "pending",
            }),
        ]);
        const second = p.onEvent(
            event("assistant/chunk", {
                turn: 1,
                step: 0,
                chunk: { type: "block-end", index: 2 },
            }),
        );
        expect(second).toHaveLength(1);
        expect(second[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: "c2",
            rawInput: { description: "second", prompt: "two" },
        });

        expect(
            p.onEvent(
                event("tool/call", {
                    turn: 1,
                    step: 0,
                    callId: "c1",
                    name: "subagent",
                    arguments: '{"description":"first","prompt":"one"}',
                }),
            ),
        ).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "c1",
                status: "in_progress",
            }),
        ]);
        expect(
            p.onEvent(
                event("tool/call", {
                    turn: 1,
                    step: 0,
                    callId: "c2",
                    name: "subagent",
                    arguments: '{"description":"second","prompt":"two"}',
                }),
            ),
        ).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "c2",
                status: "in_progress",
            }),
        ]);

        expect(
            p.onEvent(
                event("tool/result", {
                    callId: "c1",
                    message: {
                        content: [
                            { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "done" }] },
                        ],
                    },
                }),
            ),
        ).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "c1",
                status: "completed",
            }),
        ]);
    });

    it("drops projection state without fabricating a failed tool event when a turn ends", () => {
        const p = new SessionProjection();
        p.onEvent(
            event("tool-call-chunks", {
                turn: 1,
                step: 0,
                index: 1,
                id: "c1",
                name: "subagent",
                args: ["{}"],
            }),
        );
        p.onEvent(
            event("assistant/chunk", {
                turn: 1,
                step: 0,
                chunk: { type: "block-end", index: 1 },
            }),
        );

        expect(
            p.onEvent(
                event("turn/end", {
                    turn: 1,
                    reason: { kind: "aborted", reason: { kind: "user" } },
                }),
            ),
        ).toEqual([]);
    });

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

    it.each([
        {
            name: "bash",
            arguments: '{"command":"sleep 4","run_in_background":true}',
            text: "started background job bash-1",
            typed: { kind: "background", jobId: "bash-1" },
        },
        {
            name: "subagent",
            arguments: '{"description":"check","prompt":"inspect","run_in_background":true}',
            text: "started background subagent job subagent-2",
            typed: { kind: "background", jobId: "subagent-2" },
        },
        {
            name: "subagent",
            arguments: '{"description":"check","prompt":"inspect"}',
            text: "started subagent child-3",
            typed: { kind: "continuable", subagentId: "child-3" },
        },
    ])("publishes the typed $typed.kind fallback for $name acknowledgements", ({ name, arguments: args, text, typed }) => {
        const p = new SessionProjection();
        p.onEvent(event("tool/call", { turn: 1, step: 0, callId: "background-call", name, arguments: args }));

        const done = p.onEvent(
            event("tool/result", {
                turn: 1,
                step: 0,
                message: {
                    content: [
                        {
                            type: "tool-result",
                            toolCallId: "background-call",
                            content: [{ type: "text", text }],
                        },
                    ],
                },
            }),
        );

        expect(done[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: "background-call",
            status: "completed",
            _meta: { dsh: { toolResult: { value: typed } } },
        });
        expect(
            (done[0] as unknown as { _meta: { dsh: { toolResult: unknown } } })._meta.dsh.toolResult,
        ).toEqual({ value: typed });
        expect((done[0] as Record<string, unknown>)["rawOutput"]).toEqual({ output: text, isError: false });
    });

    it("publishes a captured canonical tool value through generic metadata", () => {
        const p = new SessionProjection();
        p.recordToolResult("search-call", {
            matches: [{ path: "/workspace/a.ts", line: 7 }],
            truncated: false,
        });
        p.onEvent(event("tool/call", {
            turn: 1,
            step: 0,
            callId: "search-call",
            name: "grep_search",
            arguments: '{"query":"needle"}',
        }));

        const done = p.onEvent(event("tool/result", {
            turn: 1,
            step: 0,
            message: {
                content: [{
                    type: "tool-result",
                    toolCallId: "search-call",
                    content: [{ type: "text", text: "/workspace/a.ts:7:needle" }],
                }],
            },
        }));

        expect(done[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: "search-call",
            _meta: {
                dsh: {
                    toolResult: {
                        value: {
                            matches: [{ path: "/workspace/a.ts", line: 7 }],
                            truncated: false,
                        },
                    },
                },
            },
        });
        expect(
            (done[0] as unknown as { _meta: { dsh: { toolResult: unknown } } })._meta.dsh.toolResult,
        ).toEqual({
            value: {
                matches: [{ path: "/workspace/a.ts", line: 7 }],
                truncated: false,
            },
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
    it("carries non-human injected context in metadata without echoing user prompts", () => {
        const p = new SessionProjection();

        expect(
            p.onEvent(
                event("user/message", {
                    source: { kind: "compaction" },
                    content: [{ type: "text", text: "summary context" }],
                }),
            ),
        ).toEqual([
            {
                sessionUpdate: "session_info_update",
                _meta: {
                    dsh: {
                        event: "user/message",
                        source: "compaction",
                        preview: "summary context",
                    },
                },
            },
        ]);
        expect(
            p.onEvent(
                event("user/message", {
                    source: { kind: "user" },
                    content: [{ type: "text", text: "hello" }],
                }),
            ),
        ).toEqual([]);
    });

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

    it("maps an empty todo/write snapshot so clients can clear the plan", () => {
        const p = new SessionProjection();

        expect(p.onEvent(event("todo/write", { todos: [] }))).toEqual([
            {
                sessionUpdate: "plan",
                entries: [],
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
