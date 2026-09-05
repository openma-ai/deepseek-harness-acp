import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const archive = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), "dsh-acp-standalone-"));
const workspace = join(root, "workspace");
const cache = join(root, "cache");
mkdirSync(workspace);
let child;
try {
    execFileSync("npm", ["install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", archive], {
        stdio: "inherit", timeout: 180_000, shell: process.platform === "win32",
    });
    const binary = join(root, "node_modules/@openma/deepseek-harness-acp/dist/bin.js");
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(DSH_|DEEPSEEK_|NODE_|PATH$)/i.test(key)) delete env[key];
    }
    Object.assign(env, {
        PATH: process.platform === "win32" ? join(process.env.SystemRoot, "System32") : "/usr/bin:/bin",
        DSH_HOME: join(root, "home"), DSH_SESSION_ROOT: join(root, "sessions"),
        DSH_ACP_CACHE_DIR: cache, DSH_TELEMETRY_DISABLED: "1",
        DEEPSEEK_API_KEY: "sk-test-not-a-real-key", DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
    });
    child = spawn(process.execPath, [binary], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.pipe(process.stderr);
    const pending = new Map();
    let id = 0;
    const fail = (error) => {
        for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
        pending.clear();
    };
    child.on("error", fail);
    child.on("exit", (code) => fail(new Error(`standalone exited: ${code}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
    });
    const request = (method, params) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`standalone timeout: ${method}`));
        }, 600_000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    });
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
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
    const runtimeRequire = createRequire(join(cache, runtimes[0], "package.json"));
    assert(runtimeRequire("koffi").version);
    const png = await runtimeRequire("sharp")({
        create: { width: 1, height: 1, channels: 3, background: "red" },
    }).png().toBuffer();
    assert(png.length > 0);
    const { rgPath } = runtimeRequire("@vscode/ripgrep");
    assert.match(execFileSync(rgPath, ["--version"], { encoding: "utf8" }), /ripgrep/);
    console.log(`STANDALONE_SMOKE_OK ${process.platform}/${process.arch} dsh=${metadata.dsh}`);
} finally {
    if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
    }
    rmSync(root, { recursive: true, force: true });
}
