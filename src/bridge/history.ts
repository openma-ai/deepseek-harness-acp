/**
 * `session/load` history replay.
 *
 * The harness persists every session as an append-only event log; constructor
 * seeds do not re-fire the live `session/event` hook, so history replay reads
 * the stored log (`sessionPersistence.inspect`) and projects it through the
 * same translation used for live streaming — with two replay-specific
 * differences: user messages become `user_message_chunk`s, and only the final
 * plan snapshot is replayed (intermediate todo states are noise after the
 * fact).
 */

import type { SessionUpdate, HarnessEvent } from "./translate.ts";
import { SessionProjection } from "./translate.ts";

export interface ReplayResult {
    updates: SessionUpdate[];
    /** Last `session/title` on the log, when present. */
    title: string | undefined;
    /** Context window carried by the log's latest `request/context`. */
    contextWindow: number | undefined;
}

function userText(data: Record<string, unknown> | undefined): string | undefined {
    if (data === undefined) return undefined;
    const source = data["source"];
    const kind =
        source !== null && typeof source === "object" ? (source as Record<string, unknown>)["kind"] : undefined;
    if (kind !== "user") return undefined; // plugin/tool/model messages are context, not user turns
    const content = data["content"];
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const block of content) {
        if (block !== null && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
        }
    }
    const text = parts.join("");
    return text.length > 0 ? text : undefined;
}

/**
 * Project a stored session log onto the replay update stream.
 */
export function buildReplay(events: readonly HarnessEvent[]): ReplayResult {
    const projection = new SessionProjection();
    const updates: SessionUpdate[] = [];
    let plan: SessionUpdate | undefined;
    let title: string | undefined;

    for (const event of events) {
        if (event.type === "user/message") {
            const text = userText(event.data);
            if (text !== undefined) {
                updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
            }
            continue;
        }
        if (event.type === "session/title") {
            const t = event.data?.["title"];
            if (typeof t === "string" && t.length > 0) title = t;
            continue;
        }
        for (const update of projection.onEvent(event)) {
            // usage_update mid-replay is stale telemetry; the final one wins.
            if (update.sessionUpdate === "usage_update") continue;
            if (update.sessionUpdate === "plan") {
                plan = update; // whole-list snapshot: last write wins
                continue;
            }
            updates.push(update);
        }
    }
    if (plan !== undefined) updates.push(plan);
    return { updates, title, contextWindow: projection.contextWindow };
}
