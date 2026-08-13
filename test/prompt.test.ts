import { describe, expect, it } from "vitest";
import { convertPrompt, UnsupportedPromptContentError } from "../src/bridge/prompt.ts";

describe("convertPrompt", () => {
    it("passes text through and joins blocks in wire order", () => {
        const { blocks, displayText } = convertPrompt([
            { type: "text", text: "fix " },
            { type: "text", text: "this" },
        ]);
        expect(blocks).toEqual([{ type: "text", text: "fix this" }]);
        expect(displayText).toBe("fix  this");
    });

    it("renders resource links as textual references", () => {
        const { blocks } = convertPrompt([
            { type: "text", text: "see" },
            { type: "resource_link", name: "a.ts", uri: "file:///w/a.ts" },
        ]);
        expect(blocks[0]?.text).toContain('[resource_link name="a.ts" uri="file:///w/a.ts"]');
    });

    it("renders embedded text resources as fenced context", () => {
        const { blocks } = convertPrompt([
            { type: "text", text: "explain" },
            {
                type: "resource",
                resource: { uri: "file:///w/a.ts", text: "export const x = 1;", mimeType: "text/plain" },
            },
        ]);
        expect(blocks[0]?.text).toContain('<context ref="file:///w/a.ts">\nexport const x = 1;\n</context>');
    });

    it("rejects binary content it does not advertise", () => {
        expect(() => convertPrompt([{ type: "image", data: "…", mimeType: "image/png" }])).toThrow(
            UnsupportedPromptContentError,
        );
        expect(() =>
            convertPrompt([{ type: "resource", resource: { uri: "file:///x", blob: "AAAA" } }]),
        ).toThrow(UnsupportedPromptContentError);
    });
});
