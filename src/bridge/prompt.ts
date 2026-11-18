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
 * decoded, batch-validated, and committed with `saveImage`. A model-capable
 * route receives harness `{ type: "image", attachment }` blocks. A text-only
 * route may instead provide the explicit ACP image-consumer contract below;
 * that consumer receives the durable reference and returns text, so the image
 * is never silently omitted or sent as an image block to a text model.
 * Binary `resource` payloads and audio are still rejected — silently dropping
 * them would be worse than refusing.
 */

import type { ContentBlock as AcpContentBlock } from "@agentclientprotocol/sdk/unstable";
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

/** The exact route selected for the prompt being admitted. */
export interface ImagePromptRoute {
    provider?: string;
    model?: string;
}

/**
 * Public host contract for a text-route image consumer.
 *
 * The bridge never infers this capability from a tool name or description.
 * A host pipeline/tool must publish this versioned object under the
 * `acpImageConsumer` context service, or as a tool definition's
 * `acpImageConsumer` property. Its function is the consumption path: it gets
 * the saved attachment reference and must return the text that the current
 * text-only route can use. Implementations may call a tool, enqueue a vision
 * subagent, or perform another host-owned read, but they own that routing.
 */
export interface AcpImageConsumer {
    readonly protocol: "dsh-acp.image-consumer";
    readonly version: 1;
    consumeImage(input: { attachment: HarnessImageAttachment; route: ImagePromptRoute }): Promise<string>;
}

/** Exact image path selected for one prompt. */
export type ImageConsumption =
    | { kind: "model" }
    | { kind: "consumer"; consumer: AcpImageConsumer; route: ImagePromptRoute };

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

/** Duck-typed `ctx.llm` lookup used to verify the pinned route accepts images. */
export interface ModelInfoResolver {
    resolveModelInfo(
        provider: string,
        model: string,
        signal?: AbortSignal,
    ): Promise<{ inputModalities?: readonly string[] | undefined } | undefined>;
}

/** A live tool registry surface used only for capability inspection. */
export interface ToolDefinitions {
    definitions(scope?: unknown): readonly unknown[];
}

/**
 * Validate the explicit image-consumer contract. Unknown values fail closed;
 * in particular, names such as `vision` or `image` are never sufficient.
 */
export function imageConsumerOf(value: unknown): AcpImageConsumer | undefined {
    if (value === null || typeof value !== "object") return undefined;
    const candidate = value as Partial<AcpImageConsumer>;
    if (
        candidate.protocol !== "dsh-acp.image-consumer" ||
        candidate.version !== 1 ||
        typeof candidate.consumeImage !== "function"
    ) {
        return undefined;
    }
    return candidate as AcpImageConsumer;
}

/**
 * Find a consumer published by a host service or by a currently visible tool.
 * The registry is read on every call so session-scoped tools can appear or
 * disappear without changing the connection-level initialize response.
 */
export function imageConsumerFromHost(
    service: unknown,
    tools?: ToolDefinitions,
    scope?: unknown,
): AcpImageConsumer | undefined {
    const direct = imageConsumerOf(service);
    if (direct !== undefined) return direct;
    if (tools === undefined || typeof tools.definitions !== "function") return undefined;
    let definitions: readonly unknown[];
    try {
        definitions = tools.definitions(scope);
    } catch {
        return undefined;
    }
    for (const definition of definitions) {
        if (definition === null || typeof definition !== "object") continue;
        const consumer = imageConsumerOf((definition as { acpImageConsumer?: unknown }).acpImageConsumer);
        if (consumer !== undefined) return consumer;
    }
    return undefined;
}

/**
 * Resolve the live route's image consumption path. A declared model modality
 * wins. If that route is text-only or cannot be verified, an explicit host
 * consumer may handle the saved attachment; otherwise this returns undefined.
 */
export async function imageConsumptionFor(
    llm: ModelInfoResolver | undefined,
    route: ImagePromptRoute,
    consumer?: AcpImageConsumer,
): Promise<ImageConsumption | undefined> {
    if (route.provider !== undefined && route.model !== undefined && llm !== undefined) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_000);
        try {
            const info = await llm.resolveModelInfo(route.provider, route.model, controller.signal);
            if (info?.inputModalities?.includes("image") === true) return { kind: "model" };
        } catch {
            // A consumer path can still be authoritative when the model path
            // is unavailable; without one, the caller fails closed.
        } finally {
            clearTimeout(timeout);
        }
    }
    return consumer === undefined ? undefined : { kind: "consumer", consumer, route };
}

/**
 * Compute the one-shot initialize advertisement. Ingest alone is never a
 * capability: without a verified route or host consumer, the answer is false.
 */
export async function advertisesImageCapability(
    attachmentsMounted: boolean,
    llm: ModelInfoResolver | undefined,
    route: ImagePromptRoute,
    consumer?: AcpImageConsumer,
): Promise<boolean> {
    if (!attachmentsMounted) return false;
    return (await imageConsumptionFor(llm, route, consumer)) !== undefined;
}

/** Whether any ACP prompt block carries an inline image. */
export function promptHasImages(prompt: readonly AcpContentBlock[]): boolean {
    return prompt.some((block) => block.type === "image");
}

/**
 * Refuse inline images when the pinned route's model does not declare image
 * input. Callers that also have a verified {@link AcpImageConsumer} should use
 * {@link imageConsumptionFor} instead, so a text route can consume the saved
 * attachment without receiving a harness image block.
 *
 * @param llm - live model-info service, absent only outside a harness host
 * @param provider - pinned provider route for the session
 * @param model - pinned model id for the session
 * @throws PromptImageError when the route is unknown or the model is text-only
 */
export async function assertImageInputSupported(
    llm: ModelInfoResolver | undefined,
    provider: string | undefined,
    model: string | undefined,
): Promise<void> {
    if (provider === undefined || model === undefined) {
        throw new PromptImageError("the current model route could not be resolved for image input");
    }
    if (llm === undefined) {
        throw new PromptImageError("the current model route could not be verified for image input");
    }
    let info: { inputModalities?: readonly string[] | undefined } | undefined;
    try {
        info = await llm.resolveModelInfo(provider, model);
    } catch (error: unknown) {
        throw new PromptImageError("the current model route could not be verified for image input", {
            cause: error,
        });
    }
    if (info?.inputModalities === undefined || !info.inputModalities.includes("image")) {
        throw new PromptImageError(`model "${model}" does not declare image input`);
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
    consumption: ImageConsumption = { kind: "model" },
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
                let attachment: HarnessImageAttachment;
                try {
                    attachment = await attachments.saveImage(saveInput(prepared));
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new PromptImageError(message, { cause: error });
                }
                if (consumption.kind === "consumer") {
                    let text: string;
                    try {
                        text = await consumption.consumer.consumeImage({ attachment, route: consumption.route });
                    } catch (error: unknown) {
                        const message = error instanceof Error ? error.message : String(error);
                        throw new PromptImageError(`image consumer failed: ${message}`, { cause: error });
                    }
                    if (typeof text !== "string" || text.trim().length === 0) {
                        throw new PromptImageError("image consumer returned no text");
                    }
                    parts.push(text);
                } else {
                    flushText(parts, blocks);
                    blocks.push({ type: "image", attachment });
                }
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
