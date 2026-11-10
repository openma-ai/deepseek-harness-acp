import { readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { describe, expect, it } from "vitest";

import { externalPackageRecords, runtimePackageManifest } from "../scripts/runtime-package.mjs";

const root = join(import.meta.dirname, "..");
const shell = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    optionalDependencies?: Record<string, string>;
    exports?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
    bin?: Record<string, string>;
    engines?: Record<string, string>;
    dshAcp?: {
        standaloneDsh?: string;
        runtimePackage?: string;
        hostCompatibility?: { cordisProtocol?: number; policy?: string };
    };
};

describe("ACP package manifest", () => {
    it("keeps Host dsh out of npm resolution while publishing a locked standalone runtime", () => {
        expect(shell.dependencies).toEqual({
            "@agentclientprotocol/sdk": "2.0.2",
            semver: "^7.8.5",
            tar: "7.5.22",
            yaml: "^2.9.1",
            zod: "4.4.3",
        });
        expect(shell.dependencies).not.toHaveProperty("@deepseek-ai/dsh");
        // The declared compatibility range is a real semver union of the tested
        // profile matrix (runtime/compatibility.json), enforced at resolution
        // time by src/harness.ts and at mount time by src/plugin.ts.
        const compatibility = JSON.parse(
            readFileSync(join(root, "runtime/compatibility.json"), "utf8"),
        ) as string[];
        // A minimum-version floor, mirrored in engines.dsh (what dsh's own
        // plugin loader reads), never an exact-version allow-list.
        const floor = shell.engines?.["dsh"];
        expect(floor).toMatch(/^>=\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
        for (const version of compatibility) expect(semver.satisfies(version, floor!, { includePrerelease: true })).toBe(true);
        // No @deepseek-ai/dsh peer: npm/pnpm evaluate peers without
        // prereleases, so a peer floor would reject every dsh prerelease.
        expect(shell.peerDependencies?.["@deepseek-ai/dsh"]).toBeUndefined();
        expect(shell.peerDependenciesMeta?.["@deepseek-ai/dsh"]).toBeUndefined();
        expect(shell.exports?.["./plugin"]).toBe("./dist/plugin.js");
        expect(shell.bin?.["dsh-acp"]).toBe("dist/bin.js");
        expect(shell.dshAcp?.standaloneDsh).toMatch(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
        expect(shell.dshAcp?.hostCompatibility).toEqual({ cordisProtocol: 0, policy: "capability-negotiated" });

        // Most @deepseek-ai/dsh* pins track standaloneDsh. Some packages lag the
        // CLI release when npm never published that version (e.g. dsh-invariants
        // stopped at 0.2.0-rc.2) — scripts/update-dsh.mjs keeps those older pins.
        const standalone = shell.dshAcp?.standaloneDsh;
        const dshDevelopmentPins = Object.entries(shell.devDependencies ?? {})
            .filter(([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"));
        expect(dshDevelopmentPins.some(([, range]) => range === standalone)).toBe(true);
        for (const [name, range] of dshDevelopmentPins) {
            if (range === standalone) continue;
            expect(semver.valid(range), `${name} pin ${range} must be an exact version`).toBeTruthy();
            // lt/compare ignore includePrerelease (RangeOptions only); prerelease
            // ordering is already part of the SemVer compare algorithm.
            expect(
                semver.lt(range, standalone!),
                `${name}@${range} must be older than standaloneDsh ${standalone}`,
            ).toBe(true);
        }

        const runtime = JSON.parse(readFileSync(join(root, "runtime/package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
        };
        expect(runtime.dependencies?.["@deepseek-ai/dsh"]).toBe(shell.dshAcp?.standaloneDsh);
    });

    it("ships a slim shell: the runtime archive is never in the published tarball", () => {
        // The pinned manifest travels with the shell; the archive does not.
        expect(shell.files).toEqual(expect.arrayContaining(["vendor/*.json"]));
        expect(shell.files).not.toContain("vendor/*.tgz");
        expect(shell.files?.some((entry) => entry.endsWith(".tgz"))).toBe(false);
        // prepack may still build the runtime artifact, but the shell tarball
        // must not embed it.
        expect(shell.scripts?.["prepack"]).toContain("runtime:pack");
    });

    it("keeps the heavy runtime and its native packages out of the shell's dependencies", () => {
        // npm and pnpm install optional dependencies by default: a plugin
        // install would still download the native binaries.
        expect(shell.optionalDependencies).toBeUndefined();
        expect(shell.dependencies).not.toHaveProperty("@openma/deepseek-harness-acp-runtime");
        expect(shell.dependencies).not.toHaveProperty("@deepseek-ai/libreoffice-kit-wasm");
        for (const name of Object.keys(shell.dependencies ?? {})) {
            expect(name.startsWith("@deepseek-ai/"), `${name} must not be a runtime dependency`);
        }
    });

    it("installs no lifecycle script: dsh plugin add installs with pnpm", () => {
        for (const name of ["preinstall", "install", "postinstall"]) {
            expect(shell.scripts?.[name]).toBeUndefined();
        }
    });

    it("pairs the runtime package with the shell by version", () => {
        expect(shell.dshAcp?.runtimePackage).toBe("@openma/deepseek-harness-acp-runtime");
        const manifest = runtimePackageManifest(shell.version!);
        expect(manifest.name).toBe("@openma/deepseek-harness-acp-runtime");
        expect(manifest.version).toBe(shell.version);
        expect(manifest.files).toEqual(["dsh-runtime.tgz", "runtime.json"]);
        // The runtime package carries the archive, not a live npm install,
        // and installs no lifecycle script.
        const published = manifest as unknown as Record<string, unknown>;
        expect(published["scripts"]).toBeUndefined();
        expect(published["dependencies"]).toBeUndefined();
    });

    it("records the pruned native packages with their locked integrity", () => {
        const runtimeLock = JSON.parse(
            readFileSync(join(root, "runtime/package-lock.json"), "utf8"),
        ) as { packages?: Record<string, { optional?: boolean; version?: string; integrity?: string }> };
        const external = externalPackageRecords(runtimeLock);
        expect(Object.keys(external).length).toBeGreaterThan(0);
        for (const [name, record] of Object.entries(external)) {
            expect(name).toMatch(/^(?:@deepseek-ai\/libreoffice-kit-|sherpa-onnx-)/);
            expect(record.version).toMatch(/^\d+\.\d+\.\d+$/);
            // The standalone launcher fetches these itself: the lockfile
            // integrity is what makes that fetch safe.
            expect(record.integrity).toMatch(/^sha(512|384|256)-/);
        }
        expect(external["@deepseek-ai/libreoffice-kit-wasm"]).toBeDefined();
        expect(external["sherpa-onnx-linux-x64"]).toBeDefined();
        // The shell must not carry them: they are resolved on the standalone
        // runtime acquisition path instead.
        for (const name of Object.keys(external)) {
            expect(shell.optionalDependencies?.[name]).toBeUndefined();
        }
    });
});
