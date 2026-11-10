import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const INITIALIZE_TIMEOUT_MS = 900_000;
const REQUEST_TIMEOUT_MS = 600_000;

/**
 * The standalone smoke: install the *slim* shell tarball only, hand it the
 * runtime artifact through the environment (the runtime package is not on
 * the public registry yet), and prove that
 *
 *   1. the shell tarball carries no runtime archive,
 *   2. a cold start acquires the pinned runtime and answers `initialize`,
 *   3. a second start works with the network disabled, from the warm cache.
 *
 * Usage: node scripts/standalone-smoke.mjs <shell.tgz> [--runtime-tarball <archive>] [--runtime-pack <package>]
 */

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith("--"));
const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
};
const archive = resolve(positional[0]);
const runtimeTarball = flag("--runtime-tarball");
const runtimePack = flag("--runtime-pack");
assert(positional[0], "usage: node scripts/standalone-smoke.mjs <shell.tgz> [--runtime-tarball <archive>] [--runtime-pack <package>]");
assert(runtimeTarball !== undefined || runtimePack !== undefined, "the runtime artifact must be passed in (--runtime-tarball or --runtime-pack)");

const root = mkdtempSync(join(tmpdir(), "dsh-acp-standalone-"));
const workspace = join(root, "workspace");
const cache = join(root, "cache");
mkdirSync(workspace);
let child;
let failed = false;
let diagnosed = false;
let tearingDown = false;
let spawnedAt = Date.now();
const stderrChunks = [];
const childDiagnostics = () => {
    const elapsed = Date.now() - spawnedAt;
    return `pid=${child?.pid ?? "unknown"} exitCode=${child?.exitCode ?? "null"} `
        + `signalCode=${child?.signalCode ?? "null"} elapsedMs=${elapsed}`;
};
const dumpChild = (context) => {
    if (diagnosed) return;
    diagnosed = true;
    process.stderr.write(`[standalone-smoke] ${context} (${childDiagnostics()})\n`);
    const buffered = Buffer.concat(stderrChunks).toString("utf8");
    process.stderr.write(buffered.length === 0
        ? "[standalone-smoke] child stderr: <empty>\n"
        : `[standalone-smoke] child stderr (${buffered.length} bytes):\n${buffered}`
            + `${buffered.endsWith("\n") ? "" : "\n"}`);
};

/** The base environment: the ambient harness must never be visible. */
const baseEnv = () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(DSH_|DEEPSEEK_|NODE_|PATH$)/i.test(key)) delete env[key];
    }
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    Object.assign(env, {
        // Keep the ambient toolchain out, but Node's own directory must stay:
        // the child is launched with process.execPath and may need its sibling
        // DLLs/helpers. System32 stays for basic Windows utilities.
        PATH: process.platform === "win32"
            ? [dirname(process.execPath), join(systemRoot, "System32")].join(delimiter)
            : "/usr/bin:/bin",
        DSH_HOME: join(root, "home"), DSH_SESSION_ROOT: join(root, "sessions"),
        DSH_ACP_CACHE_DIR: cache, DSH_TELEMETRY_DISABLED: "1",
        DEEPSEEK_API_KEY: "sk-test-not-a-real-key", DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
    });
    return env;
};

/** Start the ACP server and run one session against it. */
async function serve(label, env, run) {
    stderrChunks.length = 0;
    diagnosed = false;
    spawnedAt = Date.now();
    child = spawn(process.execPath, [binary], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    process.stderr.write(`[standalone-smoke] ${label}: spawned pid=${child.pid}\n`);
    child.stderr.on("data", (chunk) => {
        stderrChunks.push(chunk);
        process.stderr.write(chunk);
    });
    const pending = new Map();
    let id = 0;
    const fail = (error) => {
        if (failed || tearingDown) return;
        failed = true;
        dumpChild(`${label}: ${error.message}`);
        for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
        pending.clear();
    };
    child.on("error", fail);
    child.on("exit", (code, signal) => fail(new Error(`${label}: standalone exited: code=${code} signal=${signal}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) {
            dumpChild(`${label}: ${waiter.method} request failed`);
            waiter.reject(new Error(JSON.stringify(message.error)));
        } else waiter.resolve(message.result);
    });
    const request = (method, params, timeoutMs = REQUEST_TIMEOUT_MS) => new Promise((res, rej) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
            pending.delete(requestId);
            dumpChild(`${label}: ${method} request timed out after ${timeoutMs}ms`);
            rej(new Error(`${label}: standalone timeout: ${method} (${childDiagnostics()})`));
        }, timeoutMs);
        pending.set(requestId, { resolve: res, reject: rej, timer, method });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    });
    try {
        await run(request);
    } finally {
        tearingDown = true;
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
        }
        tearingDown = false;
        child = undefined;
    }
}

let binary;
try {
    // The slim shell must not carry the runtime archive.
    // Use the system `tar` so this script can run in CI without `npm ci`
    // (the job only checks out the repo and downloads packed artifacts).
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
        .split(/\r?\n/).filter(Boolean);
    assert(!entries.some((path) => path.endsWith("dsh-runtime.tgz")), "the shell tarball must not contain the runtime archive");
    assert(entries.some((path) => path === "package/vendor/runtime.json"), "the shell tarball must carry the pinned runtime manifest");

    // `npm` is a .cmd shim on Windows, which otherwise forces `shell: true`
    // (DEP0190). Prefer the CLI entry shipped next to the running node.
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const useNodeCli = process.platform === "win32" && existsSync(npmCli);
    execFileSync(useNodeCli ? process.execPath : "npm", [
        ...(useNodeCli ? [npmCli] : []),
        "install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", archive,
    ], {
        stdio: "inherit", timeout: 180_000, shell: process.platform === "win32" && !useNodeCli,
    });
    binary = join(root, "node_modules/@openma/deepseek-harness-acp/dist/bin.js");
    const installed = join(root, "node_modules/@openma/deepseek-harness-acp");
    // A plugin-style install never downloads the runtime.
    assert(!existsSync(join(root, "node_modules/@openma/deepseek-harness-acp-runtime")), "the shell install pulled the runtime package");
    assert(!existsSync(join(installed, "vendor", "dsh-runtime.tgz")), "the installed shell carries the runtime archive");

    const metadata = JSON.parse(readFileSync(join(installed, "vendor/runtime.json"), "utf8"));
    const runtimeEnv = baseEnv();
    if (runtimeTarball !== undefined) runtimeEnv.DSH_ACP_RUNTIME_TARBALL = resolve(runtimeTarball);
    if (runtimePack !== undefined) runtimeEnv.DSH_ACP_RUNTIME_PACK = resolve(runtimePack);

    // 1. Cold start: the runtime is acquired from the local artifact.
    await serve("cold start", runtimeEnv, async (request) => {
        const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} }, INITIALIZE_TIMEOUT_MS);
        assert.equal(init.agentInfo.name, "dsh-acp");
        const session = await request("session/new", { cwd: workspace, mcpServers: [] });
        assert(session.sessionId);
        await request("session/set_mode", { sessionId: session.sessionId, modeId: "read-only" });
        const status = await request("session/prompt", {
            sessionId: session.sessionId, prompt: [{ type: "text", text: "/status" }],
        });
        assert.equal(status.stopReason, "end_turn");
    });

    // A fresh cache must have been populated: an external host cannot satisfy this test.
    const runtimes = readdirSync(cache).filter((name) => !name.startsWith("."));
    assert.equal(runtimes.length, 1);
    assert.equal(readFileSync(join(cache, runtimes[0], ".dsh-acp-runtime"), "utf8").trim(), metadata.dsh);

    // The native packages are resolved by the launcher now, for this platform only.
    const officePackage = process.platform === "linux"
        ? "@deepseek-ai/libreoffice-kit-wasm"
        : `@deepseek-ai/libreoffice-kit-${process.platform}-${process.arch}`;
    assert(metadata.externalPackages[officePackage], `missing ${officePackage} from runtime metadata`);
    assert(existsSync(join(cache, runtimes[0], "node_modules", officePackage, "package.json")),
        `the runtime did not install ${officePackage}`);
    // The shell itself stays slim: no native package is installed next to it.
    assert(!existsSync(join(installed, "node_modules", officePackage)), `the shell install pulled ${officePackage}`);

    // Windows cannot delete DLLs loaded by this process. The probe must exit
    // before the parent removes the isolated runtime tree.
    execFileSync(process.execPath, [
        fileURLToPath(new URL("./native-smoke.mjs", import.meta.url)),
        join(cache, runtimes[0], "package.json"),
    ], { stdio: "inherit", timeout: 60_000 });

    // 2. Offline: no runtime source, no reachable registry, warm cache only.
    const offlineEnv = baseEnv();
    offlineEnv.DSH_ACP_REGISTRY = "http://127.0.0.1:1";
    await serve("offline start", offlineEnv, async (request) => {
        const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} }, INITIALIZE_TIMEOUT_MS);
        assert.equal(init.agentInfo.name, "dsh-acp");
    });

    // 3. The prefetch path: warm the cache without serving ACP.
    const prefetch = execFileSync(process.execPath, [binary, "--prefetch-runtime"], {
        cwd: workspace, env: offlineEnv, encoding: "utf8", timeout: 600_000,
    });
    assert(prefetch.length >= 0);
    console.log(`STANDALONE_SMOKE_OK ${process.platform}/${process.arch} dsh=${metadata.dsh}`);
} catch (error) {
    dumpChild("standalone smoke failed");
    throw error;
} finally {
    tearingDown = true;
    if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
    }
    rmSync(root, { recursive: true, force: true });
}
