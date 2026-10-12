/**
 * Capture inbound JSON-RPC request ids on the ACP stream.
 *
 * The SDK's `Agent` interface hides the request id, but request-scoped url
 * elicitation (browser login during `authenticate`, which has no session)
 * needs it. A transparent tap on the readable side records the id of the most
 * recent inbound request per method.
 */

import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

export type JsonRpcId = string | number;

export class RequestIdTracker {
    private readonly latest = new Map<string, JsonRpcId>();

    record(message: unknown): void {
        if (message === null || typeof message !== "object") return;
        const record = message as { method?: unknown; id?: unknown };
        if (typeof record.method !== "string") return;
        if (typeof record.id !== "string" && typeof record.id !== "number") return;
        this.latest.set(record.method, record.id);
    }

    /** Id of the most recent inbound request for `method`, if any. */
    latestFor(method: string): JsonRpcId | undefined {
        return this.latest.get(method);
    }
}

export function tapRequestIds(stream: Stream, tracker: RequestIdTracker): Stream {
    const tap = new TransformStream<AnyMessage, AnyMessage>({
        transform(message, controller) {
            tracker.record(message);
            controller.enqueue(message);
        },
    });
    return { writable: stream.writable, readable: stream.readable.pipeThrough(tap) };
}
