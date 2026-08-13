/**
 * ACP prompt content → harness user-message content blocks.
 *
 * The harness accepts `ContentBlock[]` (`text`, `image`, …) on
 * `createUserMessage`. The ACP baseline requires `text` and `resource_link`;
 * this adapter additionally advertises `embeddedContext`, rendering embedded
 * text resources as fenced context blocks the way editors expect (Zed sends
 * file mentions this way). Binary payloads (image/audio/blob) are rejected —
 * the bundled harness composition has no attachment ingestion path on this
 * wire, and silently dropping context would be worse than refusing it.
 */

import type { ContentBlock as AcpContentBlock } from "@agentclientprotocol/sdk";

/** Harness text content block (structural subset of dsh-llm's ContentBlock). */
export interface HarnessTextBlock {
    type: "text";
    text: string;
}

export interface ConvertedPrompt {
    /** Harness user-message content blocks, in wire order. */
    blocks: HarnessTextBlock[];
    /** Human-readable text used for titles, transcripts, and command parsing. */
    displayText: string;
}

/** Error thrown for prompt content this adapter does not advertise. */
export class UnsupportedPromptContentError extends Error {
    constructor(public readonly contentType: string) {
        super(`unsupported prompt content type: ${contentType}`);
    }
}

function contextBlock(uri: string, text: string): string {
    // Fenced, attribution-carrying context representation; models treat the
    // tag as provenance rather than instructions.
    return `<context ref=${JSON.stringify(uri)}>\n${text}\n</context>`;
}

/**
 * Convert ACP prompt blocks into harness content blocks.
 *
 * @throws UnsupportedPromptContentError for image/audio/binary blocks.
 */
export function convertPrompt(prompt: AcpContentBlock[]): ConvertedPrompt {
    const parts: string[] = [];
    const display: string[] = [];
    for (const block of prompt) {
        switch (block.type) {
            case "text":
                parts.push(block.text);
                display.push(block.text);
                break;
            case "resource_link":
                // Mirror @deepseek-ai/dsh-acp's textual reference so baseline
                // clients can point at files without the bridge dropping them.
                parts.push(`\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`);
                display.push(`@${block.name}`);
                break;
            case "resource": {
                const resource = block.resource;
                if ("text" in resource && typeof resource.text === "string") {
                    parts.push(`\n${contextBlock(resource.uri, resource.text)}\n`);
                    display.push(`@${resource.uri}`);
                    break;
                }
                throw new UnsupportedPromptContentError("resource (binary)");
            }
            default:
                throw new UnsupportedPromptContentError(block.type);
        }
    }
    const text = parts.join("");
    return {
        blocks: text.length > 0 ? [{ type: "text", text }] : [],
        displayText: display.join(" ").trim(),
    };
}
