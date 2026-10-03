/**
 * Inclusive `session/fork` (`jetbrains.air.fork` v1).
 *
 * Whole-session fork is the ACP default. When the request carries
 * `_meta.jetbrains.air.fork`, the new session keeps the selected assistant
 * message and everything before it, and drops everything after that message.
 */

import { createHash } from "node:crypto";
import { RequestError } from "@agentclientprotocol/sdk";

import { visibleAssistantText } from "./translate.ts";

// Contract owned by openma-ai/openma-common (src/acp-runtime/fork-support.ts, ACP_INCLUSIVE_FORK_CAPABILITY). Keep byte-identical.
export const ACP_INCLUSIVE_FORK_VERSION = 1 as const;

export interface AcpInclusiveForkCapability {
    version: typeof ACP_INCLUSIVE_FORK_VERSION;
    inclusive: true;
}

export const ACP_INCLUSIVE_FORK_CAPABILITY: AcpInclusiveForkCapability = Object.freeze({
    version: ACP_INCLUSIVE_FORK_VERSION,
    inclusive: true,
});

/** `{ jetbrains: { air: { fork: ACP_INCLUSIVE_FORK_CAPABILITY } } }`, to deep-merge into agentCapabilities._meta. */
export function acpInclusiveForkCapabilityMeta(): { jetbrains: { air: { fork: AcpInclusiveForkCapability } } } {
    return { jetbrains: { air: { fork: ACP_INCLUSIVE_FORK_CAPABILITY } } };
}

const UNSUPPORTED_VERSION = "Unsupported jetbrains.air.fork version";
const MESSAGE_ID_REQUIRED = "jetbrains.air.fork messageId must be a non-empty string";
const FINGERPRINT_INVALID = "jetbrains.air.fork messageFingerprint must match sha256:<64 lowercase hex>";
const OCCURRENCE_INVALID = "jetbrains.air.fork messageOccurrence must be a positive safe integer";
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SEGMENT_SUFFIX = /:segment:\d+$/;

export interface JetbrainsAirForkRequest {
    messageId: string;
    messageFingerprint?: string;
    /** 1-based. Defaults to 1 when the request omits it. */
    messageOccurrence: number;
}

export interface ForkLogEvent {
    type?: string;
    data?: unknown;
    seq?: number;
}

function invalid(detail: string, data?: unknown): RequestError {
    return RequestError.invalidParams(data, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read `_meta.jetbrains.air.fork`. Missing meta keeps whole-session fork.
 * A present but unusable value is `invalidParams` and must not fall back.
 */
export function parseForkRequest(meta: unknown): JetbrainsAirForkRequest | undefined {
    if (!isRecord(meta)) return undefined;
    const jetbrains = meta["jetbrains"];
    if (jetbrains === undefined || !isRecord(jetbrains)) return undefined;
    const air = jetbrains["air"];
    if (air === undefined || !isRecord(air) || !Object.hasOwn(air, "fork")) return undefined;
    const fork = air["fork"];
    if (!isRecord(fork) || fork["version"] !== ACP_INCLUSIVE_FORK_VERSION) {
        throw invalid(UNSUPPORTED_VERSION);
    }

    const rawId = fork["messageId"];
    if (typeof rawId !== "string" || rawId.trim().length === 0) throw invalid(MESSAGE_ID_REQUIRED);
    const messageId = rawId.trim();

    let messageFingerprint: string | undefined;
    if (Object.hasOwn(fork, "messageFingerprint")) {
        const value = fork["messageFingerprint"];
        if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) throw invalid(FINGERPRINT_INVALID);
        messageFingerprint = value;
    }

    let messageOccurrence = 1;
    if (Object.hasOwn(fork, "messageOccurrence")) {
        const value = fork["messageOccurrence"];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
            throw invalid(OCCURRENCE_INVALID);
        }
        messageOccurrence = value;
    }

    return {
        messageId,
        messageOccurrence,
        ...(messageFingerprint !== undefined ? { messageFingerprint } : {}),
    };
}

/** `sha256:` + SHA-256 of the assistant message's UTF-8 text. */
export function assistantMessageFingerprint(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function candidateIds(messageId: string): string[] {
    const ids = [messageId];
    if (!SEGMENT_SUFFIX.test(messageId)) return ids;
    const stripped = messageId.replace(SEGMENT_SUFFIX, "");
    if (stripped.length > 0 && stripped !== messageId) ids.push(stripped);
    return ids;
}

function assistantMessageId(data: unknown): string | undefined {
    if (!isRecord(data)) return undefined;
    const turn = data["turn"];
    const step = data["step"];
    if ((typeof turn !== "number" && typeof turn !== "string") || (typeof step !== "number" && typeof step !== "string")) {
        return undefined;
    }
    return `${String(turn)}:${String(step)}`;
}

interface AssistantHit {
    index: number;
    messageId: string;
    fingerprint: string;
}

/** Top-level persisted assistant messages, in log order. Child sessions are separate logs. */
function assistantHits(events: readonly ForkLogEvent[]): AssistantHit[] {
    const hits: AssistantHit[] = [];
    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event?.type !== "assistant/message") continue;
        const messageId = assistantMessageId(event.data);
        if (messageId === undefined || !isRecord(event.data)) continue;
        const text = visibleAssistantText(event.data["message"]);
        hits.push({ index, messageId, fingerprint: assistantMessageFingerprint(text) });
    }
    return hits;
}

/**
 * Locate the inclusive fork point. An id hit whose fingerprint does not match
 * is treated as a miss so a reused counter cannot select the wrong message.
 */
export function locateForkPoint(
    events: readonly ForkLogEvent[],
    request: JetbrainsAirForkRequest,
    sessionId: string,
): { index: number } {
    const hits = assistantHits(events);
    let idHit: AssistantHit | undefined;
    for (const candidate of candidateIds(request.messageId)) {
        const found = hits.find((hit) => hit.messageId === candidate);
        if (found !== undefined) {
            idHit = found;
            break;
        }
    }
    if (
        idHit !== undefined &&
        (request.messageFingerprint === undefined || idHit.fingerprint === request.messageFingerprint)
    ) {
        return { index: idHit.index };
    }

    if (request.messageFingerprint !== undefined) {
        const matches = hits.filter((hit) => hit.fingerprint === request.messageFingerprint);
        if (matches.length === 1) return { index: matches[0]!.index };
        const chosen = matches[request.messageOccurrence - 1];
        if (chosen !== undefined) return { index: chosen.index };
    }

    throw invalid(
        `Fork point message ${request.messageId} was not found in session ${sessionId}`,
        { messageId: request.messageId },
    );
}

function isToolCallBlock(block: unknown): boolean {
    return isRecord(block) && block["type"] === "tool-call";
}

/**
 * Copy the log through the target assistant message. Tool-call blocks on that
 * message are removed: their results are logged after the message, and keeping
 * the calls without those results would be an illegal transcript. Earlier tool
 * calls and results stay. The source array is not modified.
 */
export function inclusiveHistoryPrefix<T extends ForkLogEvent>(events: readonly T[], index: number): T[] {
    const prefix = events.slice(0, index + 1);
    const target = prefix[index];
    if (target === undefined || target.type !== "assistant/message" || !isRecord(target.data)) return prefix.slice();
    const message = target.data["message"];
    if (!isRecord(message) || !Array.isArray(message["content"])) return prefix.slice();
    if (!message["content"].some((block) => isToolCallBlock(block))) return prefix.slice();

    const cloned = structuredClone(target);
    const clonedData = cloned.data as Record<string, unknown>;
    const clonedMessage = clonedData["message"] as Record<string, unknown>;
    clonedMessage["content"] = (message["content"] as unknown[]).filter((block) => !isToolCallBlock(block));
    const copy = prefix.slice();
    copy[index] = cloned;
    return copy;
}
