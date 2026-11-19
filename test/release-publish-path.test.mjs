import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReleaseArtifact } from "../scripts/resolve-release-artifact.mjs";
import { waitForRuntimeRegistry } from "../scripts/wait-for-runtime-registry.mjs";

function tarEntry(name, contents) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(contents.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.fill(32, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
    return Buffer.concat([header, contents, padding]);
}

function runtimeTarball(root, version = "0.4.42") {
    const packageJson = Buffer.from(JSON.stringify({ name: "@openma/deepseek-harness-acp-runtime", version }));
    const tar = Buffer.concat([tarEntry("package/package.json", packageJson), Buffer.alloc(1024)]);
    const file = join(root, "runtime.tgz");
    writeFileSync(file, gzipSync(tar));
    return file;
}

function response(status, body, bytes) {
    return { status, ok: status >= 200 && status < 300, json: async () => body, arrayBuffer: async () => { const value = bytes ?? Buffer.from(JSON.stringify(body)); return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); } };
}

describe("release publish artifact paths", () => {
    it.each(["runtime", "shell"])("turns a %s-relative tarball path into an absolute local file", (directory) => {
        const root = join(tmpdir(), `dsh-acp-release-path-${process.pid}-${Date.now()}`);
        const relative = join(directory, "openma-deepseek-harness-acp-0.4.42-beta.2.tgz");
        try {
            mkdirSync(join(root, directory), { recursive: true });
            writeFileSync(join(root, relative), "test artifact");

            const result = resolveReleaseArtifact(relative, { cwd: root });

            expect(result).toBe(resolve(root, relative));
            expect(isAbsolute(result)).toBe(true);
            expect(result).not.toBe(relative);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("makes the workflow resolve both publish arguments before npm publish", () => {
        const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");

        expect(workflow).toContain('SHELL_TARBALL=$(node scripts/resolve-release-artifact.mjs "$SHELL_TARBALL")');
        expect(workflow).toContain('RUNTIME_TARBALL=$(node scripts/resolve-release-artifact.mjs "$RUNTIME_TARBALL")');

        const publishArgs = [...workflow.matchAll(/npm publish "([^"]+)"/g)].map((match) => match[1]);
        expect(publishArgs).toEqual(["$RUNTIME_TARBALL", "$SHELL_TARBALL"]);
        for (const arg of publishArgs) expect(arg).not.toMatch(/^(?:runtime|shell)\/.*\.tgz$/);
        const firstPublish = workflow.indexOf("          npm publish");
        for (const resolution of [
            'SHELL_TARBALL=$(node scripts/resolve-release-artifact.mjs "$SHELL_TARBALL")',
            'RUNTIME_TARBALL=$(node scripts/resolve-release-artifact.mjs "$RUNTIME_TARBALL")',
        ]) {
            expect(workflow.indexOf(resolution)).toBeGreaterThanOrEqual(0);
            expect(workflow.indexOf(resolution)).toBeLessThan(firstPublish);
        }
        expect(workflow.indexOf('npm publish "$RUNTIME_TARBALL"')).toBeLessThan(workflow.indexOf("wait-for-runtime-registry.mjs"));
        expect(workflow.indexOf("wait-for-runtime-registry.mjs")).toBeLessThan(workflow.indexOf('npm publish "$SHELL_TARBALL"'));
    });

    it("waits through a public 404, then verifies the exact runtime tarball", async () => {
        const root = join(tmpdir(), `dsh-acp-registry-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            const bytes = readFileSync(runtime);
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const sha1 = createHash("sha1").update(bytes).digest("hex");
            const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
            let calls = 0;
            let clock = 0;
            const fetchImpl = async (url) => {
                calls++;
                if (calls === 1) return response(404, {});
                if (calls === 2) return response(200, { version: "0.4.42", dist: { tarball: "https://registry.npmjs.org/runtime.tgz", shasum: sha1, integrity } });
                return response(200, {}, bytes);
            };
            const result = await waitForRuntimeRegistry({ runtimeTarball: runtime, timeoutMs: 100, intervalMs: 10, fetchImpl, sleepImpl: async (ms) => { clock += ms; }, nowImpl: () => clock });
            expect(result.sha256).toBe(sha256);
            expect(calls).toBe(3);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("fails closed when the registry stays missing until timeout", async () => {
        const root = join(tmpdir(), `dsh-acp-registry-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            let clock = 0;
            await expect(waitForRuntimeRegistry({ runtimeTarball: runtime, timeoutMs: 20, intervalMs: 10, fetchImpl: async () => response(404, {}), sleepImpl: async (ms) => { clock += ms; }, nowImpl: () => clock })).rejects.toThrow(/timed out/);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("fails immediately on a wrong published digest", async () => {
        const root = join(tmpdir(), `dsh-acp-registry-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            await expect(waitForRuntimeRegistry({ runtimeTarball: runtime, fetchImpl: async () => response(200, { version: "0.4.42", dist: { tarball: "runtime.tgz", integrity: "sha512-wrong" } }) })).rejects.toThrow(/integrity mismatch/);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
