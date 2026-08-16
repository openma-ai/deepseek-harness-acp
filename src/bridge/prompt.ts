/**
 * ACP prompt content → harness user-message content blocks.
 *
 * The harness accepts `ContentBlock[]` (`text`, `image`, …) on
 * `createUserMessage`. The ACP baseline requires `text` and `resource_link`;
 * this adapter additionally advertises `embeddedContext`, rendering embedded
 * text resources as fenced context blocks the way editors expect (Zed sends
 * file mentions this way).
 *
 * When the composition provides `ctx.attachments`, ACP `image` blocks are
 * decoded, batch-validated, and committed with `saveImage` into harness
 * `{ type: "image", attachment }` blocks. Block order is preserved: adjacent
 * text / resource_link / embedded text stay one text block; an image flushes
 * the text stream so 图文交替 survives. Binary `resource` payloads and audio
 * are still rejected — silently dropping them would be worse than refusing.
 */

import type { ContentBlock as AcpContentBlock } from "@agentclientprotocol/sdk";
import type {
    ImageAttachmentRef,
    ImageMediaType as DshImageMediaType,
} from "@deepseek-ai/dsh-attachment";

/** Raster types the harness attachment seam admits. */
export type ImageMediaType = DshImageMediaType;

/** Duck-typed `ctx.attachments` used at convert time (no runtime package dep). */
export interface AttachmentIngest {
    imageLimits: {
        maxImageBytes: number;
        maxImagesPerMessage: number;
        maxMessageImageBytes: number;
        mediaTypes?: readonly string[];
    };
    validateImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<void>;
    saveImage(input: {
        data: Uint8Array;
        mediaType: ImageMediaType;
        name?: string;
    }): Promise<HarnessImageAttachment>;
}

/** Durable image reference stored on a harness `ImageBlock`. */
export type HarnessImageAttachment = ImageAttachmentRef;

/** Harness text content block (structural subset of dsh-llm's ContentBlock). */
export interface HarnessTextBlock {
    type: "text";
    text: string;
}

/** Harness image content block after `saveImage`. */
export interface HarnessImageBlock {
    type: "image";
    attachment: HarnessImageAttachment;
}

export type HarnessContentBlock = HarnessTextBlock | HarnessImageBlock;

export interface ConvertedPrompt {
    /** Harness user-message content blocks, in wire order. */
    blocks: HarnessContentBlock[];
    /** Human-readable text used for titles, transcripts, and command parsing. */
    displayText: string;
}

export interface PromptDeliveryTarget<T> {
    followup(message: T): void;
    steer(message: T): void;
}

/** Deliver the first prompt as a next turn and concurrent prompts as steer. */
export function deliverPrompt<T>(
    target: PromptDeliveryTarget<T>,
    message: T,
    running: boolean,
): "followup" | "steer" {
    if (running) {
        target.steer(message);
        return "steer";
    }
    target.followup(message);
    return "followup";
}

/** Error thrown for prompt content this adapter does not advertise. */
export class UnsupportedPromptContentError extends Error {
    constructor(public readonly contentType: string) {
        super(`unsupported prompt content type: ${contentType}`);
        this.name = "UnsupportedPromptContentError";
    }
}

/** Error thrown when an advertised image cannot be ingested. */
export class PromptImageError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "PromptImageError";
    }
}

function contextBlock(uri: string, text: string): string {
    // Fenced, attribution-carrying context representation; models treat the
    // tag as provenance rather than instructions.
    return `<context ref=${JSON.stringify(uri)}>\n${text}\n</context>`;
}

const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Canonicalize an ACP image MIME type.
 *
 * @returns a harness media type, or `undefined` when the value is not a raster we ingest.
 */
export function canonicalImageMediaType(mimeType: string): ImageMediaType | undefined {
    const lower = mimeType.trim().toLowerCase();
    const mapped = lower === "image/jpg" ? "image/jpeg" : lower;
    return IMAGE_MEDIA_TYPES.has(mapped as ImageMediaType) ? (mapped as ImageMediaType) : undefined;
}

/**
 * Narrow an unknown `ctx.attachments` value to the ingest used by {@link convertPrompt}.
 *
 * @returns the ingest, or `undefined` when the composition has no attachment store.
 */
export function attachmentIngestOf(value: unknown): AttachmentIngest | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const candidate = value as Partial<AttachmentIngest>;
    if (typeof candidate.validateImage !== "function" || typeof candidate.saveImage !== "function") {
        return undefined;
    }
    const limits = candidate.imageLimits;
    if (
        limits === undefined ||
        typeof limits.maxImagesPerMessage !== "number" ||
        typeof limits.maxMessageImageBytes !== "number" ||
        typeof limits.maxImageBytes !== "number"
    ) {
        return undefined;
    }
    return candidate as AttachmentIngest;
}

function decodeImageData(data: string): Uint8Array {
    if (data.length === 0) throw new PromptImageError("image data is empty");
    const decoded = Buffer.from(data, "base64");
    if (decoded.byteLength === 0) throw new PromptImageError("image data is empty");
    return new Uint8Array(decoded);
}

function imageName(uri: string | null | undefined): string | undefined {
    if (typeof uri !== "string" || uri.length === 0) return undefined;
    let leaf: string | undefined;
    try {
        leaf = new URL(uri).pathname.split("/").filter(Boolean).at(-1);
    } catch {
        leaf = uri.split(/[/\\]/).filter(Boolean).at(-1);
    }
    if (leaf === undefined || leaf.length === 0) return undefined;
    try {
        return decodeURIComponent(leaf);
    } catch {
        return leaf;
    }
}

interface PreparedImage {
    data: Uint8Array;
    mediaType: ImageMediaType;
    name?: string;
}

function prepareImage(block: Extract<AcpContentBlock, { type: "image" }>): PreparedImage {
    const mediaType = canonicalImageMediaType(block.mimeType);
    if (mediaType === undefined) {
        throw new PromptImageError(`unsupported image media type: ${block.mimeType}`);
    }
    const data = decodeImageData(block.data);
    const name = imageName(block.uri);
    return name === undefined ? { data, mediaType } : { data, mediaType, name };
}

function saveInput(image: PreparedImage): { data: Uint8Array; mediaType: ImageMediaType; name?: string } {
    return image.name === undefined
        ? { data: image.data, mediaType: image.mediaType }
        : { data: image.data, mediaType: image.mediaType, name: image.name };
}

function flushText(parts: string[], blocks: HarnessContentBlock[]): void {
    const text = parts.join("");
    parts.length = 0;
    if (text.length > 0) blocks.push({ type: "text", text });
}

/**
 * Convert ACP prompt blocks into harness content blocks.
 *
 * @param prompt - ACP `session/prompt` content, in wire order.
 * @param attachments - `ctx.attachments` when the composition mounted one; omit to refuse images.
 * @throws UnsupportedPromptContentError for audio/binary blocks, or images when no ingest is present.
 * @throws PromptImageError when advertised image bytes fail admission.
 */
export async function convertPrompt(
    prompt: AcpContentBlock[],
    attachments?: AttachmentIngest,
): Promise<ConvertedPrompt> {
    const preparedImages: PreparedImage[] = [];
    for (const block of prompt) {
        if (block.type !== "image") continue;
        if (attachments === undefined) throw new UnsupportedPromptContentError("image");
        preparedImages.push(prepareImage(block));
    }

    if (preparedImages.length > 0 && attachments !== undefined) {
        const { maxImagesPerMessage, maxMessageImageBytes, maxImageBytes } = attachments.imageLimits;
        if (preparedImages.length > maxImagesPerMessage) {
            throw new PromptImageError("prompt exceeds the configured image-count limit");
        }
        const totalBytes = preparedImages.reduce((sum, image) => sum + image.data.byteLength, 0);
        if (totalBytes > maxMessageImageBytes) {
            throw new PromptImageError("prompt exceeds the configured aggregate image-byte limit");
        }
        for (const image of preparedImages) {
            if (image.data.byteLength > maxImageBytes) {
                throw new PromptImageError("image exceeds the configured encoded-byte limit");
            }
            try {
                await attachments.validateImage(saveInput(image));
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                throw new PromptImageError(message, { cause: error });
            }
        }
    }

    const parts: string[] = [];
    const display: string[] = [];
    const blocks: HarnessContentBlock[] = [];
    let imageIndex = 0;
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
            case "image": {
                if (attachments === undefined) throw new UnsupportedPromptContentError("image");
                const prepared = preparedImages[imageIndex];
                imageIndex += 1;
                if (prepared === undefined) throw new PromptImageError("image block was not prepared");
                flushText(parts, blocks);
                let attachment: HarnessImageAttachment;
                try {
                    attachment = await attachments.saveImage(saveInput(prepared));
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new PromptImageError(message, { cause: error });
                }
                blocks.push({ type: "image", attachment });
                break;
            }
            default:
                throw new UnsupportedPromptContentError(block.type);
        }
    }
    flushText(parts, blocks);
    return {
        blocks,
        displayText: display.join(" ").trim(),
    };
}
