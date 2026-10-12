import { describe, expect, it } from "vitest";
import { RequestIdTracker, tapRequestIds } from "../src/bridge/request-ids.ts";

describe("RequestIdTracker", () => {
    it("records the latest request id per method", () => {
        const tracker = new RequestIdTracker();
        tracker.record({ jsonrpc: "2.0", id: 1, method: "initialize" });
        tracker.record({ jsonrpc: "2.0", id: "req-2", method: "authenticate" });
        tracker.record({ jsonrpc: "2.0", id: 7, method: "authenticate" });
        expect(tracker.latestFor("initialize")).toBe(1);
        expect(tracker.latestFor("authenticate")).toBe(7);
        expect(tracker.latestFor("session/new")).toBeUndefined();
    });

    it("ignores non-requests and malformed messages", () => {
        const tracker = new RequestIdTracker();
        tracker.record(undefined);
        tracker.record(null);
        tracker.record("authenticate");
        tracker.record({ method: "authenticate" });
        tracker.record({ id: 3 });
        tracker.record({ id: 4, method: 5 });
        tracker.record({ id: {}, method: "authenticate" });
        tracker.record({ id: null, method: "authenticate" });
        tracker.record({ method: "authenticate", params: {} });
        expect(tracker.latestFor("authenticate")).toBeUndefined();
        tracker.record({ id: "r-1", method: "authenticate" });
        expect(tracker.latestFor("authenticate")).toBe("r-1");
    });
});

describe("tapRequestIds", () => {
    it("passes messages through while recording request ids", async () => {
        const input = new TransformStream();
        const output = new TransformStream();
        const tracker = new RequestIdTracker();
        const tapped = tapRequestIds(
            { readable: input.readable, writable: output.writable },
            tracker,
        );

        const writer = input.writable.getWriter();
        // pipeThrough backpressures after the first queued chunk, so writes
        // and reads interleave as they do on the live connection.
        const writes = (async () => {
            await writer.write({ jsonrpc: "2.0", id: 3, method: "authenticate", params: {} });
            await writer.write({ jsonrpc: "2.0", method: "session/cancel", params: {} });
            await writer.close();
        })();

        const reader = tapped.readable.getReader();
        const messages = [];
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            messages.push(value);
        }
        await writes;
        expect(messages).toEqual([
            { jsonrpc: "2.0", id: 3, method: "authenticate", params: {} },
            { jsonrpc: "2.0", method: "session/cancel", params: {} },
        ]);
        expect(tracker.latestFor("authenticate")).toBe(3);
        expect(tapped.writable).toBe(output.writable);
    });
});
