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

const archive = resolve(process.argv[2]);
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
try {
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
    const binary = join(root, "node_modules/@openma/deepseek-harness-acp/dist/bin.js");
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
    spawnedAt = Date.now();
    child = spawn(process.execPath, [binary], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    process.stderr.write(`[standalone-smoke] spawned pid=${child.pid}\n`);
    child.stderr.on("data", (chunk) => {
        stderrChunks.push(chunk);
        process.stderr.write(chunk);
    });
    const pending = new Map();
    let id = 0;
    const fail = (error) => {
        if (failed || tearingDown) return;
        failed = true;
        dumpChild(error.message);
        for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
        pending.clear();
    };
    child.on("error", fail);
    child.on("exit", (code, signal) => fail(new Error(`standalone exited: code=${code} signal=${signal}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) {
            dumpChild(`${waiter.method} request failed`);
            waiter.reject(new Error(JSON.stringify(message.error)));
        } else waiter.resolve(message.result);
    });
    const request = (method, params, timeoutMs = REQUEST_TIMEOUT_MS) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
            pending.delete(requestId);
            dumpChild(`${method} request timed out after ${timeoutMs}ms`);
            reject(new Error(`standalone timeout: ${method} (${childDiagnostics()})`));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer, method });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    });
    // The first request absorbs the cold extract of the vendored runtime.
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} }, INITIALIZE_TIMEOUT_MS);
    assert.equal(init.agentInfo.name, "dsh-acp");
    const session = await request("session/new", { cwd: workspace, mcpServers: [] });
    assert(session.sessionId);
    await request("session/set_mode", { sessionId: session.sessionId, modeId: "read-only" });
    const status = await request("session/prompt", {
        sessionId: session.sessionId, prompt: [{ type: "text", text: "/status" }],
    });
    assert.equal(status.stopReason, "end_turn");
    // A fresh cache must have been populated: an external host cannot satisfy this test.
    const runtimes = readdirSync(cache).filter((name) => !name.startsWith("."));
    assert.equal(runtimes.length, 1);
    const metadata = JSON.parse(readFileSync(join(root, "node_modules/@openma/deepseek-harness-acp/vendor/runtime.json")));
    assert.equal(readFileSync(join(cache, runtimes[0], ".dsh-acp-runtime"), "utf8").trim(), metadata.dsh);
    const officePackage = process.platform === "linux"
        ? "@deepseek-ai/libreoffice-kit-wasm"
        : `@deepseek-ai/libreoffice-kit-${process.platform}-${process.arch}`;
    assert(metadata.externalPackages[officePackage], `missing ${officePackage} from runtime metadata`);
    assert(existsSync(join(root, "node_modules", officePackage, "package.json")), `npm did not install ${officePackage}`);
    assert(existsSync(join(cache, runtimes[0], "node_modules", officePackage, "package.json")),
        `runtime did not copy ${officePackage}`);
    // Windows cannot delete DLLs loaded by this process. The probe must exit
    // before the parent removes the isolated runtime tree.
    execFileSync(process.execPath, [
        fileURLToPath(new URL("./native-smoke.mjs", import.meta.url)),
        join(cache, runtimes[0], "package.json"),
    ], { stdio: "inherit", timeout: 60_000 });
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
