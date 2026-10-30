/**
 * `scripts/update-dsh.mjs` coverage: the release script's manifest update
 * runs with injected seams for every branch, and once end-to-end as a
 * direct module invocation (argv[1] match) against a tmpdir package tree.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { updateDshManifests } from "../scripts/update-dsh.mjs";

const VERSIONS = ["0.0.9", "0.1.7-rc.2", "0.2.0-rc.1", "0.2.0-rc.2"];
const LATEST = "0.2.0-rc.2";

function manifest(overrides = {}) {
    return {
        dshAcp: { standaloneDsh: "0.1.7-rc.2" },
        peerDependencies: { "@deepseek-ai/dsh": "*" },
        devDependencies: {
            "@deepseek-ai/dsh": "0.1.7-rc.2",
            "@deepseek-ai/dsh-agent": "0.1.7-rc.2",
            other: "1.0.0",
        },
        ...overrides,
    };
}

const COMPAT_SOURCE = 'export const TESTED_DSH_THROUGH = "0.1.7-rc.2";\n';

function fakeSeams({ latest = LATEST, versions = VERSIONS, packageVersions = {}, manifestValue = manifest(), runtime = { dependencies: {} }, compat = COMPAT_SOURCE } = {}) {
    const npm = vi.fn((args) => {
        if (args.includes("dist-tags.latest")) return latest;
        if (args.includes("versions")) {
            const name = args[1];
            if (name === "@deepseek-ai/dsh") return versions;
            if (packageVersions[name] !== undefined) return packageVersions[name];
            // Default: every other @deepseek-ai/dsh-* package publishes `latest`.
            return versions;
        }
        return versions;
    });
    const writes = [];
    const appended = [];
    const log = vi.fn();
    const fs = {
        readJson: (path) => (path === "package.json" ? manifestValue : runtime),
        readText: () => compat,
        writeJson: (path, value) => writes.push([path, value]),
        writeText: (path, text) => writes.push([path, text]),
        append: (path, text) => appended.push([path, text]),
    };
    return { npm, fs, env: {}, log, writes, appended };
}

describe("updateDshManifests", () => {
    it("refuses a non-release dist-tag", () => {
        const seams = fakeSeams({ latest: "0.3.0-beta.1" });
        expect(() => updateDshManifests(seams)).toThrow("Refusing non-release dsh dist-tag: 0.3.0-beta.1");
    });

    it("exits clean when the bundled dsh is already latest", () => {
        const seams = fakeSeams({ latest: "0.1.7-rc.2" });
        expect(updateDshManifests(seams)).toEqual({ changed: false });
        expect(seams.writes).toEqual([]);
    });

    it("exits clean rather than downgrading a newer bundled dsh", () => {
        const seams = fakeSeams({
            manifestValue: manifest({ dshAcp: { standaloneDsh: "9.9.9" } }),
            versions: [...VERSIONS, "9.9.9"],
        });
        expect(updateDshManifests(seams)).toEqual({ changed: false });
        expect(seams.writes).toEqual([]);
    });

    it("fails when the latest tag is absent from published versions", () => {
        const seams = fakeSeams({ latest: "9.9.9", versions: VERSIONS });
        expect(() => updateDshManifests(seams)).toThrow("Latest dist-tag is absent from published versions");
    });

    it("fails when fewer than three supported releases precede latest", () => {
        const seams = fakeSeams({ versions: ["0.0.9", "0.2.0-rc.2"] });
        expect(() => updateDshManifests(seams)).toThrow("Need three published release/RC versions");
    });

    it("writes the bumped manifest, runtime, compatibility matrix and peer range", () => {
        const seams = fakeSeams();
        expect(updateDshManifests(seams)).toEqual({
            changed: true,
            latest: LATEST,
            previous: "0.1.7-rc.2",
            matrix: ["0.1.7-rc.2", "0.2.0-rc.1", "0.2.0-rc.2"],
        });
        const written = Object.fromEntries(seams.writes);
        const next = written["package.json"];
        expect(next.dshAcp.standaloneDsh).toBe(LATEST);
        expect(next.peerDependencies["@deepseek-ai/dsh"]).toBe("*"); // the floor is maintainer-owned, never rewritten
        expect(next.devDependencies["@deepseek-ai/dsh"]).toBe(LATEST);
        expect(next.devDependencies["@deepseek-ai/dsh-agent"]).toBe(LATEST);
        expect(next.devDependencies["other"]).toBe("1.0.0");
        expect(written["runtime/package.json"].dependencies["@deepseek-ai/dsh"]).toBe(LATEST);
        expect(written["runtime/compatibility.json"]).toBe(JSON.stringify(["0.1.7-rc.2", "0.2.0-rc.1", "0.2.0-rc.2"]) + "\n");
        expect(written["src/compat.ts"]).toBe(`export const TESTED_DSH_THROUGH = "${LATEST}";\n`);
        expect(seams.appended).toEqual([]);
    });

    it("fails when src/compat.ts lost its TESTED_DSH_THROUGH constant", () => {
        const seams = fakeSeams({ compat: "export {};\n" });
        expect(() => updateDshManifests(seams)).toThrow("src/compat.ts has no TESTED_DSH_THROUGH constant");
    });

    it("keeps dsh-* pins that do not publish the new version", () => {
        const seams = fakeSeams({
            manifestValue: manifest({
                devDependencies: {
                    "@deepseek-ai/dsh": "0.1.7-rc.2",
                    "@deepseek-ai/dsh-agent": "0.1.7-rc.2",
                    "@deepseek-ai/dsh-invariants": "0.1.7-rc.2",
                    other: "1.0.0",
                },
            }),
            packageVersions: {
                "@deepseek-ai/dsh-agent": VERSIONS,
                "@deepseek-ai/dsh-invariants": ["0.1.7-rc.2"], // no LATEST
            },
        });
        expect(updateDshManifests(seams)).toMatchObject({ changed: true });
        const next = Object.fromEntries(seams.writes)["package.json"];
        expect(next.devDependencies["@deepseek-ai/dsh"]).toBe(LATEST);
        expect(next.devDependencies["@deepseek-ai/dsh-agent"]).toBe(LATEST);
        expect(next.devDependencies["@deepseek-ai/dsh-invariants"]).toBe("0.1.7-rc.2");
        expect(seams.log).toHaveBeenCalledWith(
            `Keeping @deepseek-ai/dsh-invariants@0.1.7-rc.2 (no ${LATEST} on npm)`,
        );
    });

    it("appends the changed marker to GITHUB_OUTPUT when set", () => {
        const seams = fakeSeams();
        seams.env["GITHUB_OUTPUT"] = "/tmp/out";
        expect(updateDshManifests(seams)).toMatchObject({ changed: true });
        expect(seams.appended).toEqual([["/tmp/out", `changed=true\nversion=${LATEST}\nprevious=0.1.7-rc.2\n`]]);
    });
});

describe("direct CLI invocation", () => {
    const cwd = process.cwd();
    afterEach(() => {
        process.chdir(cwd);
        process.argv = ["node", "vitest"];
        vi.unstubAllEnvs();
    });

    it("runs the real seams against the working tree when invoked directly", async () => {
        const dir = mkdtempSync(join(tmpdir(), "dsh-acp-update-"));
        const script = resolve("scripts/update-dsh.mjs");
        try {
            mkdirSync(join(dir, "runtime"), { recursive: true });
            mkdirSync(join(dir, "src"), { recursive: true });
            writeFileSync(join(dir, "src", "compat.ts"), COMPAT_SOURCE);
            writeFileSync(join(dir, "package.json"), JSON.stringify(manifest()));
            writeFileSync(join(dir, "runtime", "package.json"), JSON.stringify({ dependencies: {} }));
            const output = join(dir, "github-output");
            vi.stubEnv("GITHUB_OUTPUT", output);
            vi.doMock("node:child_process", () => ({
                execFileSync: vi.fn((_cmd, args) =>
                    JSON.stringify(args?.includes("dist-tags.latest") ? LATEST : VERSIONS)),
            }));
            vi.resetModules();
            process.chdir(dir);
            process.argv = ["node", script];

            await import("../scripts/update-dsh.mjs");

            const next = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
            expect(next.dshAcp.standaloneDsh).toBe(LATEST);
            expect(next.peerDependencies["@deepseek-ai/dsh"]).toBe("*"); // the floor is maintainer-owned, never rewritten
            expect(JSON.parse(readFileSync(join(dir, "runtime", "compatibility.json"), "utf8"))).toEqual(
                ["0.1.7-rc.2", "0.2.0-rc.1", "0.2.0-rc.2"],
            );
            expect(readFileSync(join(dir, "src", "compat.ts"), "utf8")).toBe(`export const TESTED_DSH_THROUGH = "${LATEST}";\n`);
            expect(readFileSync(output, "utf8")).toBe(`changed=true\nversion=${LATEST}\nprevious=0.1.7-rc.2\n`);
        } finally {
            process.chdir(cwd);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
