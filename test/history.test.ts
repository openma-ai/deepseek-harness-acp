import { describe, expect, it } from "vitest";
import { buildReplay, buildResumeMetadata } from "../src/bridge/history.ts";
import type { HarnessEvent } from "../src/bridge/translate.ts";

const log: HarnessEvent[] = [
    { type: "turn/start", data: { turn: 1 } },
    {
        type: "user/message",
        data: { source: { kind: "user" }, content: [{ type: "text", text: "fix the bug" }] },
    },
    {
        type: "user/message",
        data: { source: { kind: "plugin", plugin: "workspace" }, content: [{ type: "text", text: "AGENTS.md" }] },
    },
    { type: "request/context", data: { provider: "p", model: "m", contextWindow: 4096 } },
    {
        type: "tool/call",
        data: { turn: 1, step: 0, callId: "c1", name: "bash", arguments: '{"command":"pytest"}' },
    },
    {
        type: "tool/result",
        data: {
            turn: 1,
            step: 0,
            message: { content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }] },
        },
    },
    { type: "todo/write", data: { todos: [{ content: "one", status: "completed" }] } },
    { type: "todo/write", data: { todos: [{ content: "two", status: "in_progress" }] } },
    {
        type: "assistant/message",
        data: {
            turn: 1,
            step: 1,
            message: { content: [{ type: "text", text: "Done." }] },
            usage: { inputTokens: 10, outputTokens: 2 },
        },
    },
    { type: "session/title", data: { title: "Fix the bug" } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
];

describe("buildReplay", () => {
    it("folds resume metadata without constructing replay updates", () => {
        expect(buildResumeMetadata(log)).toEqual({
            title: "Fix the bug",
            contextWindow: 4096,
        });
    });

    it("replays user text, tools, assistant text, and only the final plan", () => {
        const replay = buildReplay(log);
        const kinds = replay.updates.map((update) => update.sessionUpdate);
        expect(kinds).toEqual([
            "user_message_chunk",
            "session_info_update",
            "tool_call",
            "tool_call_update",
            "agent_message_chunk",
            "plan",
            "session_info_update",
        ]);
        const user = replay.updates[0];
        expect(user).toMatchObject({ content: { type: "text", text: "fix the bug" } });
        const plan = replay.updates.find((update) => update.sessionUpdate === "plan");
        expect(plan).toMatchObject({ entries: [{ content: "two", status: "in_progress" }] });
        expect(replay.title).toBe("Fix the bug");
        expect(replay.contextWindow).toBe(4096);
    });

    it("keeps plugin-sourced context as metadata and skips usage telemetry", () => {
        const replay = buildReplay(log);
        const texts = replay.updates
            .filter((update) => update.sessionUpdate === "user_message_chunk")
            .map((update) => (update as { content: { text?: string } }).content.text);
        expect(texts).toEqual(["fix the bug"]);
        expect(replay.updates).toContainEqual({
            sessionUpdate: "session_info_update",
            _meta: {
                dsh: {
                    event: "user/message",
                    source: "plugin",
                    preview: "AGENTS.md",
                },
            },
        });
        expect(replay.updates.some((update) => update.sessionUpdate === "usage_update")).toBe(false);
    });

    it("restores only the latest user interaction's aggregate token snapshot", () => {
        const replay = buildReplay([
            {
                type: "user/message",
                data: { source: { kind: "user" }, content: [{ type: "text", text: "first" }] },
            },
            {
                type: "assistant/message",
                data: {
                    turn: 1,
                    step: 0,
                    message: { content: [] },
                    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20 },
                },
            },
            {
                type: "user/message",
                data: { source: { kind: "user" }, content: [{ type: "text", text: "second" }] },
            },
            {
                type: "assistant/message",
                data: {
                    turn: 2,
                    step: 0,
                    message: { content: [] },
                    usage: {
                        inputTokens: 30,
                        outputTokens: 4,
                        cacheReadTokens: 7,
                        cacheWriteTokens: 2,
                        reasoningTokens: 3,
                    },
                },
            },
            {
                type: "assistant/message",
                data: {
                    turn: 2,
                    step: 1,
                    message: { content: [] },
                    usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 6, reasoningTokens: 1 },
                },
            },
        ]);

        expect(replay.updates.at(-1)).toEqual({
            sessionUpdate: "session_info_update",
            _meta: {
                dsh: {
                    event: "prompt/usage",
                    usage: {
                        totalTokens: 65,
                        inputTokens: 41,
                        outputTokens: 9,
                        thoughtTokens: 4,
                        cachedReadTokens: 13,
                        cachedWriteTokens: 2,
                    },
                },
            },
        });
    });

    it("treats an image-only user message as the latest interaction boundary", () => {
        const replay = buildReplay([
            {
                type: "user/message",
                data: { source: { kind: "user" }, content: [{ type: "text", text: "first" }] },
            },
            {
                type: "assistant/message",
                data: {
                    turn: 1,
                    step: 0,
                    message: { content: [] },
                    usage: { inputTokens: 100, outputTokens: 10 },
                },
            },
            {
                type: "user/message",
                data: { source: { kind: "user" }, content: [{ type: "image", attachment: "sha256:x" }] },
            },
            {
                type: "assistant/message",
                data: {
                    turn: 2,
                    step: 0,
                    message: { content: [] },
                    usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
                },
            },
        ]);

        expect(replay.updates.at(-1)).toMatchObject({
            _meta: {
                dsh: {
                    event: "prompt/usage",
                    usage: {
                        totalTokens: 12,
                        inputTokens: 7,
                        outputTokens: 2,
                        cachedReadTokens: 3,
                    },
                },
            },
        });
    });
});
