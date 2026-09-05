import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const [binary, archive] = process.argv.slice(2).map((path) => resolve(path));
assert(binary && archive, "usage: node scripts/profile-smoke.mjs DSH_BIN ACP_TARBALL");
const root = mkdtempSync(join(tmpdir(), "dsh-acp-profile-"));
const env = {
    ...process.env,
    DSH_HOME: join(root, "home"),
    DSH_SESSION_ROOT: join(root, "sessions"),
    DEEPSEEK_API_KEY: "sk-test-profile-not-a-real-key",
    DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
    DSH_TELEMETRY_DISABLED: "1",
};
delete env.DSH_PATH;
delete env.DSH_PERMISSION_MODE;
let child;
try {
    execFileSync(process.execPath, [binary, "plugin", "--profile", "acp", "add", archive], {
        cwd: root, env, stdio: "inherit", timeout: 180_000,
    });
    child = spawn(process.execPath, [binary, "--profile", "acp"], {
        cwd: root, env, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.pipe(process.stderr);
    const pending = new Map();
    let id = 0;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
    });
    child.on("exit", (code) => {
        for (const waiter of pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(`dsh --profile exited: ${code}`));
        }
        pending.clear();
    });
    const request = (method, params) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`timeout: ${method}`));
        }, 60_000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    });
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(init.agentInfo.name, "dsh-acp");
    const session = await request("session/new", { cwd: root, mcpServers: [] });
    assert(session.sessionId);
    await request("session/set_mode", { sessionId: session.sessionId, modeId: "read-only" });
    const plan = await request("session/set_config_option", {
        sessionId: session.sessionId, configId: "collaboration_mode", value: "plan",
    });
    assert.equal(plan.configOptions.find((option) => option.id === "collaboration_mode")?.currentValue, "plan");
    const status = await request("session/prompt", {
        sessionId: session.sessionId, prompt: [{ type: "text", text: "/status" }],
    });
    assert.equal(status.stopReason, "end_turn");
    console.log("PROFILE_SMOKE_OK");
} finally {
    if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await exited;
    }
    rmSync(root, { recursive: true, force: true });
}
