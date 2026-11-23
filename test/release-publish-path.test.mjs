import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveReleaseArtifact } from "../scripts/resolve-release-artifact.mjs";
import { isAlreadyPublishedConflict, publishReleaseArtifact } from "../scripts/publish-release-artifact.mjs";
import { isExecutedAsCli } from "../scripts/is-executed-as-cli.mjs";
import { verifyPublishedArtifact, waitForRuntimeRegistry } from "../scripts/wait-for-runtime-registry.mjs";

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

const NPM_EXECPATH_ENV = "npm_execpath";
const PUBLISH_STUB_MARKER_ENV = "PUBLISH_STUB_MARKER";
const NPM_REGISTRY_ENV = "npm_config_registry";
// Environment keys the isolated publish harness owns. Windows treats
// environment variables case-insensitively, so every spelling of these keys is
// dropped from the inherited environment before the harness installs its own.
const OWNED_ENV_KEYS = new Set([
    NPM_EXECPATH_ENV.toLowerCase(),
    PUBLISH_STUB_MARKER_ENV.toLowerCase(),
    NPM_REGISTRY_ENV.toLowerCase(),
]);

const PUBLISH_STUB_SOURCE = "require('node:fs').writeFileSync(process.env.PUBLISH_STUB_MARKER, 'invoked\\n'); process.stderr.write('npm error 403 You cannot publish over the previously published versions: 0.4.42\\n'); process.exit(1);\n";

/**
 * The same publish stub, but the immutable-version conflict only surfaces
 * after `delayMs`. It models a slow publish attempt: the time spent before
 * the resume verification starts must not be charged against the
 * verification deadline.
 */
function delayedPublishStubSource(delayMs) {
    return `setTimeout(() => {${PUBLISH_STUB_SOURCE}}, ${delayMs});\n`;
}

function findEnvKey(env, key) {
    const lower = key.toLowerCase();
    return Object.keys(env).find((candidate) => candidate.toLowerCase() === lower);
}

/**
 * Builds the environment for a publish CLI child that must never reach the
 * real npm client.
 *
 * Node's `lib/child_process.js` sorts environment keys on Windows and drops
 * case-insensitive duplicates, keeping the first one. Uppercase spellings sort
 * before lowercase ones, so an inherited `NPM_EXECPATH` (the real client the
 * parent npm process exports) used to beat the injected `npm_execpath` stub
 * and the child published to the public registry. Every case variant of the
 * keys this harness owns is therefore removed before the stub is installed.
 */
export function buildIsolatedPublishEnv({ baseEnv = process.env, npmExecPath, marker, registry, pathPrefix }) {
    const env = {};
    const pathKey = findEnvKey(baseEnv, "path") ?? "PATH";
    const inheritedPath = baseEnv[pathKey];
    for (const [key, value] of Object.entries(baseEnv)) {
        if (value === undefined) continue;
        const lower = key.toLowerCase();
        if (OWNED_ENV_KEYS.has(lower) || lower === "path") continue;
        env[key] = value;
    }
    env[NPM_EXECPATH_ENV] = npmExecPath;
    env[PUBLISH_STUB_MARKER_ENV] = marker;
    if (registry) env[NPM_REGISTRY_ENV] = registry;
    const pathValue = [pathPrefix, inheritedPath].filter(Boolean).join(delimiter);
    if (pathValue) env[pathKey] = pathValue;
    return env;
}

/**
 * Mirrors Node's Windows environment handling: keys are sorted and
 * case-insensitive duplicates are dropped, keeping the first spelling.
 */
export function windowsEnvKeys(keys) {
    const seen = new Set();
    return [...keys].sort().filter((key) => {
        const upper = key.toUpperCase();
        if (seen.has(upper)) return false;
        seen.add(upper);
        return true;
    });
}

function posixNpmShim(nodePath, stubPath) {
    return `#!/bin/sh\nexec "${nodePath}" "${stubPath}" "$@"\n`;
}

function windowsNpmShim(nodePath, stubPath) {
    return `@echo off\r\n"${nodePath}" "${stubPath}" %*\r\n`;
}

function windowsNpmPowerShellShim(nodePath, stubPath) {
    return `& "${nodePath}" "${stubPath}" @args\nexit $LASTEXITCODE\n`;
}

async function runPublishCli({ tarball, registry, allowPending = false, timeoutMs = 5000, baseEnv = process.env, stubDelayMs = 0 }) {
    const root = resolve(tarball, "..");
    const npmExecPath = join(root, "npm-stub.cjs");
    const stubBin = join(root, "npm-stub-bin");
    const marker = join(root, "npm-stub-invoked");
    if (existsSync(marker)) unlinkSync(marker);
    writeFileSync(npmExecPath, stubDelayMs > 0 ? delayedPublishStubSource(stubDelayMs) : PUBLISH_STUB_SOURCE);
    // A stub npm earlier on PATH keeps the "npm" fallback of the publish
    // script away from the real client as well.
    mkdirSync(stubBin, { recursive: true });
    writeFileSync(join(stubBin, "npm"), posixNpmShim(process.execPath, npmExecPath));
    chmodSync(join(stubBin, "npm"), 0o755);
    writeFileSync(join(stubBin, "npm.cmd"), windowsNpmShim(process.execPath, npmExecPath));
    writeFileSync(join(stubBin, "npm.ps1"), windowsNpmPowerShellShim(process.execPath, npmExecPath));
    const args = [resolve(import.meta.dirname, "../scripts/publish-release-artifact.mjs"), "--tarball", tarball, "--tag", "latest", "--registry", registry, "--verification-timeout-ms", String(timeoutMs)];
    if (allowPending) args.push("--allow-pending-visibility");
    const env = buildIsolatedPublishEnv({ baseEnv, npmExecPath, marker, registry, pathPrefix: stubBin });
    // `elapsedMs` covers the child process only. Process launch and runner
    // scheduling are harness cost, never the product's verification deadline.
    const started = Date.now();
    try {
        const result = await execFileAsync(process.execPath, args, { env, encoding: "utf8" });
        return { status: 0, invoked: existsSync(marker), stdout: result.stdout, stderr: result.stderr, elapsedMs: Date.now() - started };
    } catch (error) { return { status: error.code, invoked: existsSync(marker), stdout: error.stdout, stderr: error.stderr, elapsedMs: Date.now() - started }; }
}

async function runWithServer(requestHandler, action) {
    const server = createServer(requestHandler);
    await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try { return await action(`http://127.0.0.1:${server.address().port}`); }
    finally {
        // A fixture that never ends its response keeps the socket open, and
        // `close()` alone waits for it. Dropping the connections first keeps
        // the teardown (and the tests after it) off the fixture's clock.
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        await new Promise((resolvePromise) => server.close(resolvePromise));
    }
}

function response(status, body, bytes) {
    return { status, ok: status >= 200 && status < 300, json: async () => body, arrayBuffer: async () => { const value = bytes ?? Buffer.from(JSON.stringify(body)); return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); } };
}

function expectStubInvoked(result) {
    expect(result.invoked, `publish stub was not invoked (status=${result.status}, stdout=${result.stdout ?? ""}, stderr=${result.stderr ?? ""})`).toBe(true);
    // The stub is the only npm client the CLI boundary may reach: the real one
    // reports the tarball and talks to the public registry.
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(output, `the real npm client ran instead of the publish stub (status=${result.status})`).not.toMatch(/npm notice|ENEEDAUTH|registry\.npmjs\.org/);
}

describe("release publish artifact paths", () => {
    it("treats Windows drive-letter case as the same CLI invocation", () => {
        const lower = "file:///d:/a/deepseek-harness-acp/deepseek-harness-acp/scripts/publish-release-artifact.mjs";
        const argv = "D:\\a\\deepseek-harness-acp\\deepseek-harness-acp\\scripts\\publish-release-artifact.mjs";
        expect(isExecutedAsCli(lower, argv, "win32")).toBe(true);
        expect(isExecutedAsCli(lower, "file:///D:/a/deepseek-harness-acp/deepseek-harness-acp/scripts/publish-release-artifact.mjs", "win32")).toBe(true);
        expect(isExecutedAsCli(lower, "D:\\a\\deepseek-harness-acp\\deepseek-harness-acp\\scripts\\other.mjs", "win32")).toBe(false);
    });

    it("recognizes this module as the CLI entry on the current platform", () => {
        const script = resolve(import.meta.dirname, "../scripts/publish-release-artifact.mjs");
        expect(isExecutedAsCli(pathToFileURL(script).href, script)).toBe(true);
        expect(isExecutedAsCli(pathToFileURL(script).href, resolve(import.meta.dirname, "../scripts/wait-for-runtime-registry.mjs"))).toBe(false);
    });

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

    it("keeps a single npm_execpath spelling so Windows cannot select the real npm client", () => {
        const baseEnv = {
            NPM_EXECPATH: "C:\\hostedtoolcache\\node\\npm\\bin\\npm-cli.js",
            npm_execpath: "C:\\hostedtoolcache\\node\\npm\\bin\\npm-cli.js",
            Path: "C:\\Windows\\system32",
            // Mixed-case leftovers must be stripped too: OWNED_ENV_KEYS is
            // compared case-insensitively, not against the install spelling.
            publish_stub_marker: "C:\\stale-marker",
            NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
        };
        const env = buildIsolatedPublishEnv({
            baseEnv,
            npmExecPath: "C:\\tmp\\npm-stub.cjs",
            marker: "C:\\tmp\\npm-stub-invoked",
            registry: "http://127.0.0.1:8080",
            pathPrefix: "C:\\tmp\\npm-stub-bin",
        });

        expect(Object.keys(env).filter((key) => key.toLowerCase() === NPM_EXECPATH_ENV)).toEqual([NPM_EXECPATH_ENV]);
        expect(Object.keys(env).filter((key) => key.toLowerCase() === PUBLISH_STUB_MARKER_ENV.toLowerCase())).toEqual([PUBLISH_STUB_MARKER_ENV]);
        expect(Object.keys(env).filter((key) => key.toLowerCase() === NPM_REGISTRY_ENV)).toEqual([NPM_REGISTRY_ENV]);
        expect(env[NPM_EXECPATH_ENV]).toBe("C:\\tmp\\npm-stub.cjs");
        expect(env[PUBLISH_STUB_MARKER_ENV]).toBe("C:\\tmp\\npm-stub-invoked");
        expect(env[NPM_REGISTRY_ENV]).toBe("http://127.0.0.1:8080");
        expect(env.Path).toBe(`C:\\tmp\\npm-stub-bin${delimiter}C:\\Windows\\system32`);
        // Node keeps the first spelling after sorting, so the stub has to be
        // the only survivor of the Windows deduplication.
        const surviving = windowsEnvKeys(Object.keys(env));
        expect(surviving.filter((key) => key.toLowerCase() === NPM_EXECPATH_ENV)).toEqual([NPM_EXECPATH_ENV]);
        expect(surviving.filter((key) => key.toLowerCase() === PUBLISH_STUB_MARKER_ENV.toLowerCase())).toEqual([PUBLISH_STUB_MARKER_ENV]);
        expect(surviving.filter((key) => key.toLowerCase() === NPM_REGISTRY_ENV)).toEqual([NPM_REGISTRY_ENV]);
    });

    it("lets the inherited uppercase npm client win the Windows environment deduplication", () => {
        // This is the hazard that leaked the real npm client into the publish
        // CLI: Node sorts the environment keys and drops case-insensitive
        // duplicates keeping the first, and uppercase sorts before lowercase.
        const leaked = { NPM_EXECPATH: "C:\\npm\\bin\\npm-cli.js", npm_execpath: "C:\\tmp\\npm-stub.cjs" };
        const survivors = windowsEnvKeys(Object.keys(leaked));

        expect(survivors).toEqual(["NPM_EXECPATH"]);
        expect(leaked[survivors[0]]).toBe("C:\\npm\\bin\\npm-cli.js");
    });

    it("invokes the publish stub even when the parent environment carries the real client under another spelling", async () => {
        const root = join(tmpdir(), `dsh-acp-cli-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            const realClient = process.env.npm_execpath || process.env.NPM_EXECPATH || "C:\\hostedtoolcache\\windows\\node\\22.23.5\\x64\\node_modules\\npm\\bin\\npm-cli.js";
            const poisoned = { ...process.env, NPM_EXECPATH: realClient };
            await runWithServer((_request, responseValue) => { responseValue.statusCode = 404; responseValue.end(); }, async (registry) => {
                const result = await runPublishCli({ tarball: runtime, registry, allowPending: true, baseEnv: poisoned });
                expectStubInvoked(result);
                expect(result.status).toBe(0);
            });
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
                expectStubInvoked(shellResult);
                expect(shellResult.status).not.toBe(0);
                const runtimeWithoutFlag = await runPublishCli({ tarball: runtime, registry });
                expectStubInvoked(runtimeWithoutFlag);
                expect(runtimeWithoutFlag.status).not.toBe(0);
                const runtimeResult = await runPublishCli({ tarball: runtime, registry, allowPending: true });
                expectStubInvoked(runtimeResult);
                expect(runtimeResult.status).toBe(0);
            });
        } finally { rmSync(root, { recursive: true, force: true }); }
        // Three sequential CLI launches are harness cost, not product work: the
        // vitest budget only has to be wide enough for a slow runner to spawn
        // the processes. The product deadline and the pending-flag semantics
        // are unchanged.
    }, 30_000);

    it("bounds the product verification deadline when registry metadata never finishes", async () => {
        const root = join(tmpdir(), `dsh-acp-cli-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            await runWithServer((_request, responseValue) => {
                // The metadata body never finishes: headers and a partial
                // payload are written, the response is never ended.
                responseValue.writeHead(200, { "content-type": "application/json" });
                responseValue.write('{"version":"0.4.42"');
            }, async (registry) => {
                const timeoutMs = 150;
                // The clock covers the verification request only. Server
                // startup, process launch and fixture teardown are excluded,
                // so this measures the product deadline and nothing else.
                const started = Date.now();
                await expect(verifyPublishedArtifact({ tarball: runtime, registryBaseUrl: registry, timeoutMs })).rejects.toThrow(/deadline|timed out/);
                const elapsed = Date.now() - started;
                // The deadline is armed: the request stayed in flight until
                // the product gave up on it.
                expect(elapsed).toBeGreaterThanOrEqual(100);
                // ... and it gave up on it instead of running to a 5s or
                // unbounded timeout.
                expect(elapsed).toBeLessThanOrEqual(timeoutMs + 1000);
            });
        } finally { rmSync(root, { recursive: true, force: true }); }
        // The outer timeout is only a kill switch for an unbounded
        // implementation; the tight bound above is the real assertion.
    }, 10_000);

    it("fails the actual CLI resume verification on the product deadline when metadata never finishes", async () => {
        const root = join(tmpdir(), `dsh-acp-cli-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            await runWithServer((_request, responseValue) => {
                responseValue.writeHead(200, { "content-type": "application/json" });
                responseValue.write('{"version":"0.4.42"');
            }, async (registry) => {
                const result = await runPublishCli({ tarball: runtime, registry, allowPending: true, timeoutMs: 150 });
                expectStubInvoked(result);
                expect(result.status).not.toBe(0);
                // The CLI has to report the product's deadline failure, so a
                // harness kill can never pass this test unnoticed.
                expect(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).toMatch(/deadline|timed out/);
                // Only the child process is bounded, and only generously:
                // process launch and runner scheduling are not the
                // verification deadline.
                expect(result.elapsedMs).toBeLessThan(15_000);
            });
        } finally { rmSync(root, { recursive: true, force: true }); }
        // Last-resort kill for an unbounded implementation; the in-process
        // bound above is what actually pins the product deadline.
    }, 20_000);

    it("does not charge a slow publish attempt against the resume verification deadline", async () => {
        const root = join(tmpdir(), `dsh-acp-cli-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: true });
        try {
            const runtime = runtimeTarball(root);
            const bytes = readFileSync(runtime);
            const sha1 = createHash("sha1").update(bytes).digest("hex");
            const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
            const publishDelayMs = 3000;
            const verificationTimeoutMs = 2000;
            await runWithServer((request, responseValue) => {
                if (request.url.endsWith(".tgz")) { responseValue.statusCode = 200; responseValue.end(bytes); return; }
                responseValue.statusCode = 200;
                responseValue.end(JSON.stringify({ version: "0.4.42", dist: { tarball: "runtime.tgz", shasum: sha1, integrity } }));
            }, async (registry) => {
                const result = await runPublishCli({ tarball: runtime, registry, timeoutMs: verificationTimeoutMs, stubDelayMs: publishDelayMs });
                expectStubInvoked(result);
                // The publish attempt alone outlasts the verification timeout.
                // The verification deadline still starts when the verification
                // starts, so the digest check succeeds instead of being
                // reported as a deadline failure.
                expect(result.elapsedMs).toBeGreaterThanOrEqual(publishDelayMs);
                expect(result.status).toBe(0);
                expect(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).not.toMatch(/deadline|timed out/);
            });
        } finally { rmSync(root, { recursive: true, force: true }); }
    }, 20_000);

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
