import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { buildForkSeed, SessionSeq } from "@deepseek-ai/dsh-session";

import {
    ACP_INCLUSIVE_FORK_CAPABILITY,
    acpInclusiveForkCapabilityMeta,
    assistantMessageFingerprint,
    inclusiveHistoryPrefix,
    locateForkPoint,
    parseForkRequest,
    type ForkLogEvent,
    type JetbrainsAirForkRequest,
} from "../src/bridge/fork.ts";

function sha256(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function assistant(turn: number, step: number, text: string, extra: Record<string, unknown> = {}): ForkLogEvent {
    return {
        type: "assistant/message",
        seq: turn * 10 + step,
        data: {
            turn,
            step,
            message: {
                role: "assistant",
                content: [
                    ...(extra["reasoning"] !== undefined
                        ? [{ type: "reasoning", text: extra["reasoning"] }]
                        : []),
                    { type: "text", text },
                    ...(extra["toolCall"] === true
                        ? [{ type: "tool-call", id: "call-1", name: "bash", arguments: "{}" }]
                        : []),
                    ...(extra["image"] === true ? [{ type: "image" }] : []),
                ],
            },
        },
    };
}

function forkAt(messageId: string, extra: Record<string, unknown> = {}): unknown {
    return {
        jetbrains: {
            air: {
                fork: { version: 1, messageId, ...extra },
            },
        },
    };
}

function expectInvalid(meta: unknown, message: string): void {
    try {
        parseForkRequest(meta);
        throw new Error("expected invalidParams");
    } catch (error: unknown) {
        expect(error).toBeInstanceOf(RequestError);
        expect((error as RequestError).code).toBe(-32602);
        expect((error as RequestError).message).toContain(message);
    }
}

describe("jetbrains.air.fork meta", () => {
    it("advertises the inclusive capability next to other _meta keys", () => {
        expect(ACP_INCLUSIVE_FORK_CAPABILITY).toEqual({ version: 1, inclusive: true });
        expect(Object.isFrozen(ACP_INCLUSIVE_FORK_CAPABILITY)).toBe(true);
        expect(acpInclusiveForkCapabilityMeta()).toEqual({
            jetbrains: { air: { fork: { version: 1, inclusive: true } } },
        });
    });

    it("ignores a missing fork block", () => {
        expect(parseForkRequest(undefined)).toBeUndefined();
        expect(parseForkRequest(null)).toBeUndefined();
        expect(parseForkRequest({ steering: { supported: true } })).toBeUndefined();
        expect(parseForkRequest({ jetbrains: { air: {} } })).toBeUndefined();
        expect(parseForkRequest({ jetbrains: "nope" })).toBeUndefined();
    });

    it("rejects illegal fork meta with -32602", () => {
        expectInvalid({ jetbrains: { air: { fork: null } } }, "Unsupported jetbrains.air.fork version");
        expectInvalid({ jetbrains: { air: { fork: [] } } }, "Unsupported jetbrains.air.fork version");
        expectInvalid({ jetbrains: { air: { fork: { version: 2, messageId: "1:0" } } } }, "Unsupported jetbrains.air.fork version");
        expectInvalid({ jetbrains: { air: { fork: { version: "1", messageId: "1:0" } } } }, "Unsupported jetbrains.air.fork version");
        expectInvalid({ jetbrains: { air: { fork: { version: 1 } } } }, "messageId must be a non-empty string");
        expectInvalid({ jetbrains: { air: { fork: { version: 1, messageId: "   " } } } }, "messageId must be a non-empty string");
        expectInvalid({ jetbrains: { air: { fork: { version: 1, messageId: 2 } } } }, "messageId must be a non-empty string");
        expectInvalid(
            { jetbrains: { air: { fork: { version: 1, messageId: "1:0", messageFingerprint: "sha256:abcd" } } } },
            "messageFingerprint must match sha256:",
        );
        expectInvalid(
            { jetbrains: { air: { fork: { version: 1, messageId: "1:0", messageFingerprint: "SHA256:" + "a".repeat(64) } } } },
            "messageFingerprint must match sha256:",
        );
        expectInvalid(
            { jetbrains: { air: { fork: { version: 1, messageId: "1:0", messageOccurrence: 0 } } } },
            "messageOccurrence must be a positive safe integer",
        );
        expectInvalid(
            { jetbrains: { air: { fork: { version: 1, messageId: "1:0", messageOccurrence: 1.5 } } } },
            "messageOccurrence must be a positive safe integer",
        );
        expectInvalid(
            { jetbrains: { air: { fork: { version: 1, messageId: "1:0", messageOccurrence: Number.MAX_SAFE_INTEGER + 1 } } } },
            "messageOccurrence must be a positive safe integer",
        );
    });

    it("trims the message id and defaults occurrence to 1", () => {
        expect(parseForkRequest(forkAt("  2:1  "))).toEqual({ messageId: "2:1", messageOccurrence: 1 });
        const fingerprint = sha256("hello");
        expect(parseForkRequest(forkAt("2:1", { messageFingerprint: fingerprint, messageOccurrence: 2 }))).toEqual({
            messageId: "2:1",
            messageFingerprint: fingerprint,
            messageOccurrence: 2,
        });
    });
});

describe("fork point lookup", () => {
    const same = "Same text";
    const events: ForkLogEvent[] = [
        { type: "user/message", data: { content: [{ type: "text", text: "first" }] } },
        assistant(1, 0, same, { reasoning: "hidden" }),
        { type: "user/message", data: { content: [{ type: "text", text: "second" }] } },
        assistant(2, 0, "Middle"),
        { type: "user/message", data: { content: [{ type: "text", text: "third" }] } },
        assistant(3, 0, same),
        assistant(4, 0, "picture", { image: true }),
    ];

    function request(messageId: string, extra: Partial<JetbrainsAirForkRequest> = {}): JetbrainsAirForkRequest {
        return { messageId, messageOccurrence: 1, ...extra };
    }

    it("hits an exact message id", () => {
        expect(locateForkPoint(events, request("2:0"), "s").index).toBe(3);
    });

    it("resolves a :segment:N id to the assistant message", () => {
        expect(locateForkPoint(events, request("2:0:segment:4"), "s").index).toBe(3);
    });

    it("selects the only fingerprint match", () => {
        const point = locateForkPoint(
            events,
            request("missing", { messageFingerprint: sha256("Middle"), messageOccurrence: 9 }),
            "s",
        );
        expect(point.index).toBe(3);
    });

    it("uses messageOccurrence when several fingerprints match", () => {
        const fingerprint = sha256(same);
        expect(locateForkPoint(events, request("missing", { messageFingerprint: fingerprint, messageOccurrence: 1 }), "s").index).toBe(1);
        expect(locateForkPoint(events, request("missing", { messageFingerprint: fingerprint, messageOccurrence: 2 }), "s").index).toBe(5);
    });

    it("falls back when the id hits a message with a different fingerprint", () => {
        const point = locateForkPoint(
            events,
            request("1:0", { messageFingerprint: sha256("Middle") }),
            "s",
        );
        expect(point.index).toBe(3);
    });

    it("prefers an id hit over occurrence when the fingerprint matches", () => {
        const point = locateForkPoint(
            events,
            request("3:0", { messageFingerprint: sha256(same), messageOccurrence: 1 }),
            "s",
        );
        expect(point.index).toBe(5);
    });

    it("fingerprints visible text, including the image placeholder and excluding thoughts", () => {
        expect(assistantMessageFingerprint("picture[image attachment]")).toBe(sha256("picture[image attachment]"));
        expect(locateForkPoint(events, request("nope", { messageFingerprint: sha256("picture[image attachment]") }), "s").index).toBe(6);
    });

    it("errors when nothing matches", () => {
        expect(() => locateForkPoint(events, request("9:9"), "sess-1")).toThrow(RequestError);
        try {
            locateForkPoint(events, request("9:9", { messageFingerprint: sha256("nope") }), "sess-1");
            throw new Error("expected invalidParams");
        } catch (error: unknown) {
            expect(error).toBeInstanceOf(RequestError);
            const requestError = error as RequestError;
            expect(requestError.code).toBe(-32602);
            expect(requestError.message).toContain("Fork point message 9:9 was not found in session sess-1");
            expect(requestError.data).toEqual({ messageId: "9:9" });
        }
    });
});

describe("inclusive truncation", () => {
    it("keeps the target assistant message and drops everything after it", () => {
        const events: ForkLogEvent[] = [
            { type: "turn/start", seq: 0, data: { turn: 1 } },
            { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "earlier" }] } },
            {
                type: "tool/call",
                seq: 2,
                data: { turn: 1, step: 0, callId: "old", name: "bash", arguments: "{}" },
            },
            {
                type: "tool/result",
                seq: 3,
                data: {
                    turn: 1,
                    step: 0,
                    message: { source: { callId: "old" }, content: [{ type: "text", text: "ok" }] },
                },
            },
            assistant(1, 1, "keep me", { toolCall: true }),
            { type: "tool/call", seq: 5, data: { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: "{}" } },
            { type: "tool/result", seq: 6, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "later result" }] } } },
            { type: "user/message", seq: 7, data: { content: [{ type: "text", text: "after" }] } },
            assistant(2, 0, "after reply"),
        ];
        events[4]!.seq = 4;
        const prefix = inclusiveHistoryPrefix(events, 4);
        expect(prefix.map((event) => event.type)).toEqual([
            "turn/start",
            "user/message",
            "tool/call",
            "tool/result",
            "assistant/message",
        ]);
        const content = (prefix[4]?.data as { message: { content: Array<{ type: string; text?: string }> } }).message.content;
        expect(content.map((block) => block.type)).toEqual(["text"]);
        expect(content[0]?.text).toBe("keep me");
        const sourceContent = (events[4]?.data as { message: { content: Array<{ type: string }> } }).message.content;
        expect(sourceContent.map((block) => block.type)).toEqual(["text", "tool-call"]);

        const seed = buildForkSeed(prefix as never, SessionSeq(4));
        expect(seed.some((event) => event.type === "tool/result" && Number(event.seq) > 4)).toBe(false);
        expect(seed.some((event) => event.type === "user/message" && Number(event.seq) > 4)).toBe(false);
        expect(seed[4]?.type).toBe("assistant/message");
    });
});
