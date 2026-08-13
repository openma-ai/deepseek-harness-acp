import { describe, expect, it } from "vitest";
import { buildReplay } from "../src/bridge/history.ts";
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
    it("replays user text, tools, assistant text, and only the final plan", () => {
        const replay = buildReplay(log);
        const kinds = replay.updates.map((update) => update.sessionUpdate);
        expect(kinds).toEqual([
            "user_message_chunk",
            "tool_call",
            "tool_call_update",
            "agent_message_chunk",
            "plan",
        ]);
        const user = replay.updates[0];
        expect(user).toMatchObject({ content: { type: "text", text: "fix the bug" } });
        const plan = replay.updates.at(-1);
        expect(plan).toMatchObject({ entries: [{ content: "two", status: "in_progress" }] });
        expect(replay.title).toBe("Fix the bug");
        expect(replay.contextWindow).toBe(4096);
    });

    it("skips plugin-sourced context messages and usage telemetry", () => {
        const replay = buildReplay(log);
        const texts = replay.updates
            .filter((update) => update.sessionUpdate === "user_message_chunk")
            .map((update) => (update as { content: { text?: string } }).content.text);
        expect(texts).toEqual(["fix the bug"]);
        expect(replay.updates.some((update) => update.sessionUpdate === "usage_update")).toBe(false);
    });
});
