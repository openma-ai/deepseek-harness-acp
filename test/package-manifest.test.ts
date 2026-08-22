import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("ACP package manifest", () => {
    it("publishes the ACP SDK with its runtime validator plus one complete dsh host peer", () => {
        const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
            peerDependencies?: Record<string, string>;
        };
        expect(manifest.dependencies).toEqual({
            "@agentclientprotocol/sdk": "^1.3.0",
            zod: "^4.4.3",
        });
    expect(manifest.peerDependencies).toEqual({
      "@deepseek-ai/dsh": "0.1.1-rc.2",
    });

        const dshDevelopmentRanges = Object.entries(manifest.devDependencies ?? {})
            .filter(([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"))
            .map(([, range]) => range);
        expect(new Set(dshDevelopmentRanges)).toEqual(new Set(["^0.1.1-rc.1"]));
    });
});
