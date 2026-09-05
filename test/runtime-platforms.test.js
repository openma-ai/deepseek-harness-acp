import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { completePlatformPackages, platformPackages, verifyIntegrity } from "../scripts/runtime-platforms.mjs";

describe("bundled platform packages", () => {
    it("includes foreign supported architectures without including unrelated targets", () => {
        const lock = { packages: {
            "node_modules/mac": { optional: true, os: ["darwin"], cpu: ["arm64"] },
            "node_modules/linux": { optional: true, os: ["linux"], cpu: ["x64"] },
            "node_modules/windows": { optional: true, os: ["win32"], cpu: ["arm64"] },
            "node_modules/android": { optional: true, os: ["android"], cpu: ["arm64"] },
            "node_modules/shared": {},
        } };
        expect(platformPackages(lock).map(([path]) => path)).toEqual([
            "node_modules/mac", "node_modules/linux", "node_modules/windows",
        ]);
    });
    it("rejects corrupt downloads and missing integrity", () => {
        expect(() => verifyIntegrity(Buffer.from("bad"), "sha512-invalid")).toThrow();
        expect(() => verifyIntegrity(Buffer.from("bad"), undefined)).toThrow();
    });
    it("accepts an exact locked digest", () => {
        const bytes = Buffer.from("platform tarball");
        const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        expect(() => verifyIntegrity(bytes, integrity)).not.toThrow();
    });
    it("restores a missing foreign package from its verified archive", async () => {
        const root = mkdtempSync(join(tmpdir(), "platform-package-test-"));
        try {
            mkdirSync(join(root, "package"));
            writeFileSync(join(root, "package/package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
            writeFileSync(join(root, "package/native.node"), "fixture native bytes");
            await tar.c({ cwd: root, file: join(root, "fixture.tgz"), gzip: true }, ["package"]);
            const bytes = readFileSync(join(root, "fixture.tgz"));
            writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
                "node_modules/fixture": {
                    optional: true, os: ["win32"], cpu: ["arm64"], version: "1.0.0",
                    resolved: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
                    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                },
            } }));
            const download = vi.fn(async () => new Response(bytes));
            vi.stubGlobal("fetch", download);
            await completePlatformPackages(root);
            expect(readFileSync(join(root, "node_modules/fixture/native.node"), "utf8")).toBe("fixture native bytes");
            await completePlatformPackages(root);
            expect(download).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllGlobals();
            rmSync(root, { recursive: true, force: true });
        }
    });
});
