/**
 * Stored-log history replay (`session/load` and `session/resume`).
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

export type RestoreMetadata = Pick<ReplayResult, "title" | "contextWindow">;

/**
 * Fold only the state needed to continue a persisted session. Unlike
 * `buildReplay`, this never projects transcript events or retains ACP updates;
 * it backs the silent restore when a client keeps prompting an old session id
 * after an agent restart (the client already renders the thread itself).
 */
export function buildRestoreMetadata(events: readonly HarnessEvent[]): RestoreMetadata {
    let title: string | undefined;
    let contextWindow: number | undefined;
    for (const event of events) {
        if (event.type === "session/title") {
            const value = event.data?.["title"];
            if (typeof value === "string" && value.length > 0) title = value;
            continue;
        }
        if (event.type === "request/context") {
            const value = event.data?.["contextWindow"];
            if (typeof value === "number" && value > 0) contextWindow = value;
        }
    }
    return { title, contextWindow };
}

function userMessage(data: Record<string, unknown> | undefined): { text?: string } | undefined {
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
    return text.length > 0 ? { text } : {};
}

/**
 * Project a stored session log onto the replay update stream.
 */
export function buildReplay(events: readonly HarnessEvent[]): ReplayResult {
    const projection = new SessionProjection();
    const updates: SessionUpdate[] = [];
    let plan: SessionUpdate | undefined;
    let title: string | undefined;
    let sawUserInteraction = false;

    for (const event of events) {
        if (event.type === "user/message") {
            const user = userMessage(event.data);
            if (user !== undefined) {
                projection.beginPrompt();
                sawUserInteraction = true;
                if (user.text !== undefined) {
                    updates.push({
                        sessionUpdate: "user_message_chunk",
                        content: { type: "text", text: user.text },
                    });
                }
                continue;
            }
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
    const usage = sawUserInteraction ? projection.promptUsage() : undefined;
    if (usage !== undefined) {
        updates.push({
            sessionUpdate: "session_info_update",
            _meta: { dsh: { event: "prompt/usage", usage } },
        } as SessionUpdate);
    }
    return { updates, title, contextWindow: projection.contextWindow };
}
