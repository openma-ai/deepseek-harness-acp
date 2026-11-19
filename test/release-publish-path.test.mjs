import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveReleaseArtifact } from "../scripts/resolve-release-artifact.mjs";
import { isAlreadyPublishedConflict, publishReleaseArtifact } from "../scripts/publish-release-artifact.mjs";
import { waitForRuntimeRegistry } from "../scripts/wait-for-runtime-registry.mjs";

const execFileAsync = promisify(execFile);

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

function packageTarball(root, name, version = "0.4.42", filename = "runtime.tgz") {
    const packageJson = Buffer.from(JSON.stringify({ name, version }));
    const tar = Buffer.concat([tarEntry("package/package.json", packageJson), Buffer.alloc(1024)]);
    const file = join(root, filename);
    writeFileSync(file, gzipSync(tar));
    return file;
}

function runtimeTarball(root, version = "0.4.42") { return packageTarball(root, "@openma/deepseek-harness-acp-runtime", version); }
function shellTarball(root, version = "0.4.42") { return packageTarball(root, "@openma/deepseek-harness-acp", version, "shell.tgz"); }

async function runPublishCli({ tarball, registry, allowPending = false, timeoutMs = 5000 }) {
    const root = resolve(tarball, "..");
    const npmExecPath = join(root, "npm-stub.cjs");
    const marker = join(root, "npm-stub-invoked");
    if (existsSync(marker)) unlinkSync(marker);
    writeFileSync(npmExecPath, "require('node:fs').writeFileSync(process.env.PUBLISH_STUB_MARKER, 'invoked\\n'); process.stderr.write('npm error 403 You cannot publish over the previously published versions: 0.4.42\\n'); process.exit(1);\n");
    const args = [resolve(import.meta.dirname, "../scripts/publish-release-artifact.mjs"), "--tarball", tarball, "--tag", "latest", "--registry", registry, "--verification-timeout-ms", String(timeoutMs)];
    if (allowPending) args.push("--allow-pending-visibility");
    try {
        await execFileAsync(process.execPath, args, { env: { ...process.env, npm_execpath: npmExecPath, PUBLISH_STUB_MARKER: marker } });
        return { status: 0, invoked: existsSync(marker) };
    } catch (error) { return { status: error.code, invoked: existsSync(marker), stdout: error.stdout, stderr: error.stderr }; }
}

async function runWithServer(requestHandler, action) {
    const server = createServer(requestHandler);
    await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try { return await action(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise((resolvePromise) => server.close(resolvePromise)); }
}

function response(status, body, bytes) {
    return { status, ok: status >= 200 && status < 300, json: async () => body, arrayBuffer: async () => { const value = bytes ?? Buffer.from(JSON.stringify(body)); return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); } };
}

describe("release publish artifact paths", () => {
    it("recognizes npm's captured immutable-version error but rejects generic auth errors", () => {
        expect(isAlreadyPublishedConflict({ code: "E403", stderr: "npm error 403 You cannot publish over the previously published versions: 0.4.42" })).toBe(true);
        expect(isAlreadyPublishedConflict({ status: 403, stderr: "npm error 403 Forbidden" })).toBe(false);
        expect(isAlreadyPublishedConflict({ status: 401, stderr: "npm error unauthorized" })).toBe(false);
    });

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

        const publishArgs = [...workflow.matchAll(/publish-release-artifact\.mjs --tarball "([^"]+)"/g)].map((match) => match[1]);
        expect(publishArgs).toEqual(["$RUNTIME_TARBALL", "$SHELL_TARBALL"]);
        const firstPublish = workflow.indexOf("publish-release-artifact.mjs");
        for (const resolution of [
            'SHELL_TARBALL=$(node scripts/resolve-release-artifact.mjs "$SHELL_TARBALL")',
            'RUNTIME_TARBALL=$(node scripts/resolve-release-artifact.mjs "$RUNTIME_TARBALL")',
        ]) {
            expect(workflow.indexOf(resolution)).toBeGreaterThanOrEqual(0);
            expect(workflow.indexOf(resolution)).toBeLessThan(firstPublish);
        }
        expect(workflow.indexOf('publish-release-artifact.mjs --tarball "$RUNTIME_TARBALL"')).toBeLessThan(workflow.indexOf("wait-for-runtime-registry.mjs"));
        expect(workflow.indexOf("wait-for-runtime-registry.mjs")).toBeLessThan(workflow.indexOf('publish-release-artifact.mjs --tarball "$SHELL_TARBALL"'));
        expect(workflow).toContain('publish-release-artifact.mjs --tarball "$RUNTIME_TARBALL" --tag "$DIST_TAG" --allow-pending-visibility');
        expect(workflow).not.toContain('publish-release-artifact.mjs --tarball "$SHELL_TARBALL" --tag "$DIST_TAG" --allow-pending-visibility');
        expect(workflow.indexOf('verify-release-artifacts.mjs --shell "$SHELL_TARBALL" --runtime "$RUNTIME_TARBALL"', firstPublish)).toBeGreaterThan(workflow.indexOf("wait-for-runtime-registry.mjs"));
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

    it("keeps the registry deadline armed while reading a delayed tarball body", async () => {
        const root = join(tmpdir(), `dsh-acp-registry-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            const bytes = readFileSync(runtime);
            const delayed = (value, ms) => new Promise((resolveValue) => setTimeout(() => resolveValue(value), ms));
            let calls = 0;
            const fetchImpl = async () => {
                calls++;
                if (calls === 1) return response(200, { version: "0.4.42", dist: { tarball: "runtime.tgz" } });
                return { status: 200, ok: true, json: async () => ({}), arrayBuffer: async () => delayed(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 30) };
            };
            await expect(waitForRuntimeRegistry({ runtimeTarball: runtime, timeoutMs: 10, intervalMs: 1, fetchImpl, sleepImpl: async () => {} })).rejects.toThrow(/deadline|timed out/);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it.each([401, 403])("fails immediately on metadata HTTP %s", async (status) => {
        const root = join(tmpdir(), `dsh-acp-registry-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            let calls = 0;
            await expect(waitForRuntimeRegistry({ runtimeTarball: runtime, timeoutMs: 1000, fetchImpl: async () => { calls++; return response(status, {}); }, sleepImpl: async () => { throw new Error("must not sleep"); } })).rejects.toThrow(new RegExp(`HTTP ${status}`));
            expect(calls).toBe(1);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("fails immediately on a tarball HTTP 401 or 403", async () => {
        const root = join(tmpdir(), `dsh-acp-registry-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            for (const status of [401, 403]) {
                let calls = 0;
                await expect(waitForRuntimeRegistry({ runtimeTarball: runtime, timeoutMs: 1000, fetchImpl: async () => { calls++; return calls === 1 ? response(200, { version: "0.4.42", dist: { tarball: "runtime.tgz" } }) : response(status, {}); }, sleepImpl: async () => { throw new Error("must not sleep"); } })).rejects.toThrow(new RegExp(`HTTP ${status}`));
                expect(calls).toBe(2);
            }
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("publishes runtime, waits, then attempts shell, and safely resumes immutable retries", async () => {
        const root = join(tmpdir(), `dsh-acp-publish-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            const shell = shellTarball(root);
            const events = [];
            const publish = async (file) => { events.push(`publish:${file}`); };
            await publishReleaseArtifact({ tarball: runtime, tag: "latest", publishImpl: publish });
            events.push("wait");
            await publishReleaseArtifact({ tarball: shell, tag: "latest", publishImpl: publish });
            expect(events).toEqual([`publish:${resolve(runtime)}`, "wait", `publish:${resolve(shell)}`]);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it.each([
        ["runtime", "runtime"],
        ["shell", "shell"],
    ])("continues an already-published %s only after matching digest verification", async (_label, kind) => {
        const root = join(tmpdir(), `dsh-acp-publish-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const tarball = kind === "runtime" ? runtimeTarball(root) : shellTarball(root);
            const bytes = readFileSync(tarball);
            const sha1 = createHash("sha1").update(bytes).digest("hex");
            const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
            const fetchImpl = async (url) => String(url).endsWith("runtime.tgz") || String(url).endsWith("shell.tgz")
                ? response(200, {}, bytes)
                : response(200, { version: "0.4.42", dist: { tarball: `${kind}.tgz`, sha1, shasum: sha1, integrity } });
            const result = await publishReleaseArtifact({ tarball, tag: "latest", publishImpl: async () => { throw new Error("E403 cannot publish over the previously published versions"); }, fetchImpl, registryBaseUrl: "https://registry.npmjs.org" });
            expect(result).toEqual({ published: false, verifiedExisting: true, pendingVisibility: false });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("continues an immutable retry while registry metadata is still 404 so the wait gate can retry", async () => {
        const root = join(tmpdir(), `dsh-acp-publish-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            const result = await publishReleaseArtifact({
                tarball: runtime,
                tag: "latest",
                allowPendingVisibility: true,
                publishImpl: async () => { throw new Error("E403 You cannot publish over the previously published versions: 0.4.42"); },
                fetchImpl: async () => response(404, {}),
            });
            expect(result).toEqual({ published: false, verifiedExisting: false, pendingVisibility: true });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("enforces the pending flag at the actual CLI boundary", async () => {
        const root = join(tmpdir(), `dsh-acp-cli-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            const shell = shellTarball(root);
            await runWithServer((_request, responseValue) => { responseValue.statusCode = 404; responseValue.end(); }, async (registry) => {
                const shellResult = await runPublishCli({ tarball: shell, registry });
                expect(shellResult.invoked).toBe(true);
                expect(shellResult.status).not.toBe(0);
                const runtimeWithoutFlag = await runPublishCli({ tarball: runtime, registry });
                expect(runtimeWithoutFlag.invoked).toBe(true);
                expect(runtimeWithoutFlag.status).not.toBe(0);
                const runtimeResult = await runPublishCli({ tarball: runtime, registry, allowPending: true });
                expect(runtimeResult.invoked).toBe(true);
                expect(runtimeResult.status).toBe(0);
            });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("bounds actual CLI resume verification when metadata never finishes", async () => {
        const root = join(tmpdir(), `dsh-acp-cli-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            const started = Date.now();
            await runWithServer((_request, responseValue) => { responseValue.writeHead(200, { "content-type": "application/json" }); responseValue.write('{"version":"0.4.42"'); }, async (registry) => {
                const result = await runPublishCli({ tarball: runtime, registry, allowPending: true, timeoutMs: 150 });
                expect(result.invoked).toBe(true);
                expect(result.status).not.toBe(0);
            });
            expect(Date.now() - started).toBeLessThan(2000);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it.each(["runtime", "shell"])("rejects an immutable %s retry when the registry digest differs", async (kind) => {
        const root = join(tmpdir(), `dsh-acp-publish-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const tarball = kind === "runtime" ? runtimeTarball(root) : shellTarball(root);
            await expect(publishReleaseArtifact({ tarball, tag: "latest", publishImpl: async () => { throw new Error("E409 cannot publish over the previously published versions"); }, fetchImpl: async () => response(200, { version: "0.4.42", dist: { tarball: `${kind}.tgz`, integrity: "sha512-wrong" } }) })).rejects.toThrow(/integrity mismatch/);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("does not continue a non-conflict publish error", async () => {
        const root = join(tmpdir(), `dsh-acp-publish-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            await expect(publishReleaseArtifact({ tarball: runtime, tag: "latest", publishImpl: async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); }, fetchImpl: async () => { throw new Error("must not fetch"); } })).rejects.toThrow("unauthorized");
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
