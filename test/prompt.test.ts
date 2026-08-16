import { describe, expect, it, vi } from "vitest";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import {
    attachmentIngestOf,
    convertPrompt,
    deliverPrompt,
    PromptImageError,
    UnsupportedPromptContentError,
    type AttachmentIngest,
    type ImageMediaType,
} from "../src/bridge/prompt.ts";

describe("deliverPrompt", () => {
    it("uses steer for a prompt delivered during an active turn", () => {
        const deliveries: string[] = [];
        const target = {
            followup: (message: string) => deliveries.push(`followup:${message}`),
            steer: (message: string) => deliveries.push(`steer:${message}`),
        };

        expect(deliverPrompt(target, "change course", true)).toBe("steer");
        expect(deliveries).toEqual(["steer:change course"]);
    });

    it("uses followup for the prompt that starts a turn", () => {
        const deliveries: string[] = [];
        const target = {
            followup: (message: string) => deliveries.push(`followup:${message}`),
            steer: (message: string) => deliveries.push(`steer:${message}`),
        };

        expect(deliverPrompt(target, "start", false)).toBe("followup");
        expect(deliveries).toEqual(["followup:start"]);
    });
});

function mockIngest(overrides?: Partial<AttachmentIngest>): AttachmentIngest {
    return {
        imageLimits: {
            maxImageBytes: 1024,
            maxImagesPerMessage: 4,
            maxMessageImageBytes: 4096,
        },
        validateImage: async () => {},
        saveImage: async (input) => ({
            attachmentId: AttachmentId(`sha256:mock-${input.data.byteLength}`),
            mediaType: input.mediaType,
            bytes: input.data.byteLength,
            width: 1,
            height: 1,
            ...(input.name !== undefined ? { name: input.name } : {}),
        }),
        ...overrides,
    };
}

describe("convertPrompt", () => {
    it("passes text through and joins blocks in wire order", async () => {
        const { blocks, displayText } = await convertPrompt([
            { type: "text", text: "fix " },
            { type: "text", text: "this" },
        ]);
        expect(blocks).toEqual([{ type: "text", text: "fix this" }]);
        expect(displayText).toBe("fix  this");
    });

    it("renders resource links as textual references", async () => {
        const { blocks } = await convertPrompt([
            { type: "text", text: "see" },
            { type: "resource_link", name: "a.ts", uri: "file:///w/a.ts" },
        ]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({ type: "text" });
        if (blocks[0]?.type === "text") {
            expect(blocks[0].text).toContain('[resource_link name="a.ts" uri="file:///w/a.ts"]');
        }
    });

    it("renders embedded text resources as fenced context", async () => {
        const { blocks } = await convertPrompt([
            { type: "text", text: "explain" },
            {
                type: "resource",
                resource: { uri: "file:///w/a.ts", text: "export const x = 1;", mimeType: "text/plain" },
            },
        ]);
        expect(blocks[0]?.type).toBe("text");
        if (blocks[0]?.type === "text") {
            expect(blocks[0].text).toContain('<context ref="file:///w/a.ts">\nexport const x = 1;\n</context>');
        }
    });

    it("rejects images when no attachment ingest is present", async () => {
        await expect(convertPrompt([{ type: "image", data: "AQ==", mimeType: "image/png" }])).rejects.toBeInstanceOf(
            UnsupportedPromptContentError,
        );
    });

    it("rejects binary content it does not advertise", async () => {
        await expect(
            convertPrompt([{ type: "resource", resource: { uri: "file:///x", blob: "AAAA" } }]),
        ).rejects.toBeInstanceOf(UnsupportedPromptContentError);
    });

    it("rejects audio content it does not advertise", async () => {
        await expect(
            convertPrompt([{ type: "audio", data: "AAAA", mimeType: "audio/wav" }]),
        ).rejects.toBeInstanceOf(UnsupportedPromptContentError);
    });

    it("ingests interleaved text and images without collapsing order", async () => {
        const ingest = mockIngest();
        const { blocks, displayText } = await convertPrompt(
            [
                { type: "text", text: "see " },
                { type: "image", data: "AQ==", mimeType: "image/png", uri: "file:///tmp/first.png" },
                { type: "text", text: " then " },
                { type: "image", data: "Ag==", mimeType: "image/png" },
                { type: "text", text: "done" },
            ],
            ingest,
        );
        expect(blocks).toEqual([
            { type: "text", text: "see " },
            {
                type: "image",
                attachment: {
                    attachmentId: "sha256:mock-1",
                    mediaType: "image/png",
                    bytes: 1,
                    width: 1,
                    height: 1,
                    name: "first.png",
                },
            },
            { type: "text", text: " then " },
            {
                type: "image",
                attachment: {
                    attachmentId: "sha256:mock-1",
                    mediaType: "image/png",
                    bytes: 1,
                    width: 1,
                    height: 1,
                },
            },
            { type: "text", text: "done" },
        ]);
        expect(displayText).toBe("see   then  done");
    });

    it("keeps resource_link in the text stream across an image", async () => {
        const { blocks } = await convertPrompt(
            [
                { type: "text", text: "open" },
                { type: "resource_link", name: "a.ts", uri: "file:///w/a.ts" },
                { type: "image", data: "AQ==", mimeType: "image/png" },
                { type: "text", text: "after" },
            ],
            mockIngest(),
        );
        expect(blocks.map((block) => block.type)).toEqual(["text", "image", "text"]);
        if (blocks[0]?.type === "text") {
            expect(blocks[0].text).toContain('[resource_link name="a.ts" uri="file:///w/a.ts"]');
        }
    });

    it("accepts an image-only prompt", async () => {
        const { blocks, displayText } = await convertPrompt(
            [{ type: "image", data: "AQ==", mimeType: "image/png" }],
            mockIngest(),
        );
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe("image");
        expect(displayText).toBe("");
    });

    it("maps image/jpg to image/jpeg", async () => {
        const saveImage = vi.fn(async (input: { mediaType: ImageMediaType; data: Uint8Array }) => ({
            attachmentId: AttachmentId("sha256:jpg"),
            mediaType: input.mediaType,
            bytes: input.data.byteLength,
            width: 1,
            height: 1,
        }));
        await convertPrompt([{ type: "image", data: "AQ==", mimeType: "image/jpg" }], mockIngest({ saveImage }));
        expect(saveImage.mock.calls[0]?.[0].mediaType).toBe("image/jpeg");
    });

    it("validates every image before saving any", async () => {
        const validateImage = vi.fn(async (input: { data: Uint8Array }) => {
            if (input.data[0] === 2) throw new Error("second is bad");
        });
        const saveImage = vi.fn();
        await expect(
            convertPrompt(
                [
                    { type: "image", data: "AQ==", mimeType: "image/png" },
                    { type: "image", data: "Ag==", mimeType: "image/png" },
                ],
                mockIngest({ validateImage, saveImage }),
            ),
        ).rejects.toBeInstanceOf(PromptImageError);
        expect(validateImage).toHaveBeenCalledTimes(2);
        expect(saveImage).not.toHaveBeenCalled();
    });

    it("refuses a prompt that exceeds the image-count limit", async () => {
        const ingest = mockIngest({
            imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 4096 },
        });
        await expect(
            convertPrompt(
                [
                    { type: "image", data: "AQ==", mimeType: "image/png" },
                    { type: "image", data: "Ag==", mimeType: "image/png" },
                ],
                ingest,
            ),
        ).rejects.toBeInstanceOf(PromptImageError);
    });

    it("keeps slash displayText on the text blocks only", async () => {
        const { displayText } = await convertPrompt(
            [
                { type: "text", text: "/login" },
                { type: "image", data: "AQ==", mimeType: "image/png" },
            ],
            mockIngest(),
        );
        expect(displayText).toBe("/login");
    });

    it("maps saveImage failures onto PromptImageError", async () => {
        await expect(
            convertPrompt([{ type: "image", data: "AQ==", mimeType: "image/png" }], mockIngest({
                saveImage: async () => {
                    throw new Error("disk full");
                },
            })),
        ).rejects.toMatchObject({ name: "PromptImageError", message: "disk full" });
    });
});

describe("attachmentIngestOf", () => {
    it("accepts a duck-typed store and rejects incomplete objects", () => {
        expect(attachmentIngestOf(mockIngest())).toBeDefined();
        expect(attachmentIngestOf(undefined)).toBeUndefined();
        expect(attachmentIngestOf(null)).toBeUndefined();
        expect(attachmentIngestOf({})).toBeUndefined();
        expect(
            attachmentIngestOf({
                imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1 },
                validateImage: async () => {},
            }),
        ).toBeUndefined();
    });
});
