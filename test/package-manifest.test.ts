import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("ACP package manifest", () => {
    it("keeps Host dsh out of npm resolution while publishing a locked standalone runtime", () => {
        const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
            peerDependencies?: Record<string, string>;
            peerDependenciesMeta?: Record<string, { optional?: boolean }>;
            exports?: Record<string, string>;
            files?: string[];
            scripts?: Record<string, string>;
            bin?: Record<string, string>;
            dshAcp?: {
                standaloneDsh?: string;
                hostCompatibility?: { cordisProtocol?: number; policy?: string };
            };
        };
        expect(manifest.dependencies).toEqual({
            "@agentclientprotocol/sdk": "1.4.0",
            tar: "7.4.3",
            zod: "4.4.3",
        });
        expect(manifest.dependencies).not.toHaveProperty("@deepseek-ai/dsh");
        expect(manifest.peerDependencies).toEqual({ "@deepseek-ai/dsh": "*" });
        expect(manifest.peerDependenciesMeta).toEqual({
            "@deepseek-ai/dsh": { optional: true },
        });
        expect(manifest.exports?.["./plugin"]).toBe("./dist/plugin.js");
        expect(manifest.bin?.["dsh-acp"]).toBe("dist/bin.js");
        expect(manifest.files).toEqual(expect.arrayContaining(["vendor/*.json", "vendor/*.tgz"]));
        expect(manifest.scripts?.["prepack"]).toContain("runtime:pack");
        expect(manifest.dshAcp).toEqual({
            standaloneDsh: "0.1.1-rc.2",
            hostCompatibility: { cordisProtocol: 0, policy: "capability-negotiated" },
        });

        const dshDevelopmentRanges = Object.entries(manifest.devDependencies ?? {})
            .filter(([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"))
            .map(([, range]) => range);
        expect(new Set(dshDevelopmentRanges)).toEqual(new Set([manifest.dshAcp?.standaloneDsh]));

        const runtime = JSON.parse(readFileSync(join(import.meta.dirname, "../runtime/package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
        };
        expect(runtime.dependencies?.["@deepseek-ai/dsh"]).toBe(manifest.dshAcp?.standaloneDsh);
    });
});
