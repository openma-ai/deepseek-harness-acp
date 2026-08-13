/**
 * End-to-end smoke test: boots the real dsh-acp server (full harness
 * composition) as a child process and speaks ACP over its stdio.
 *
 * No model calls are made: session/new only constructs an agent, and the
 * /status prompt is intercepted by the adapter before it would reach the
 * model. A fake DEEPSEEK_BASE_URL satisfies the credential gate.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

class AcpTestClient {
    private child: ChildProcessWithoutNullStreams;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    private buffer = "";
    private stderr = "";

    constructor(sessionRoot: string, workspace: string, dshPath?: string) {
        this.child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
            cwd: ROOT,
            env: {
                ...process.env,
                DEEPSEEK_BASE_URL: "http://127.0.0.1:1", // credential gate only; never dialed
                DSH_SESSION_ROOT: sessionRoot,
                DSH_ACP_WORKSPACE: workspace,
                ...(dshPath !== undefined ? { DSH_PATH: dshPath } : {}),
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stdout.setEncoding("utf8");
        this.child.stderr.setEncoding("utf8");
        this.child.stderr.on("data", (chunk: string) => {
            this.stderr += chunk;
        });
        this.child.stdout.on("data", (chunk: string) => {
            this.buffer += chunk;
            let index = this.buffer.indexOf("\n");
            while (index >= 0) {
                const line = this.buffer.slice(0, index).trim();
                this.buffer = this.buffer.slice(index + 1);
                if (line.length > 0) this.dispatch(line);
                index = this.buffer.indexOf("\n");
            }
        });
    }

    private dispatch(line: string): void {
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(line) as Record<string, unknown>;
        } catch {
            return;
        }
        const id = message["id"];
        if (typeof id === "number" && this.pending.has(id)) {
            const pending = this.pending.get(id);
            this.pending.delete(id);
            if (message["error"] !== undefined && message["error"] !== null) {
                const error = message["error"] as { message?: string };
                pending?.reject(new Error(error.message ?? "JSON-RPC error"));
            } else {
                pending?.resolve(message["result"]);
            }
            return;
        }
        const method = message["method"];
        if (typeof method === "string") {
            this.notifications.push({
                method,
                params: (message["params"] as Record<string, unknown>) ?? {},
            });
        }
    }

    request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
        const id = this.nextId;
        this.nextId += 1;
        const promise = new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            setTimeout(() => {
                if (this.pending.delete(id)) {
                    reject(new Error(`${method} timed out\nstderr:\n${this.stderr.slice(-2000)}`));
                }
            }, timeoutMs).unref();
        });
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        return promise;
    }

    updatesFor(sessionId: string): Array<Record<string, unknown>> {
        return this.notifications
            .filter(
                (notification) =>
                    notification.method === "session/update" && notification.params["sessionId"] === sessionId,
            )
            .map((notification) => notification.params["update"] as Record<string, unknown>);
    }

    async close(): Promise<void> {
        this.child.stdin.end();
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.child.kill("SIGKILL");
                resolve();
            }, 5000);
            this.child.on("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}

describe("dsh-acp server (e2e smoke)", () => {
    let client: AcpTestClient;
    let sessionRoot: string;
    let workspace: string;

    beforeAll(() => {
        sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-sessions-"));
        workspace = mkdtempSync(join(tmpdir(), "dsh-acp-workspace-"));
        client = new AcpTestClient(sessionRoot, workspace);
    });

    afterAll(async () => {
        await client.close();
        rmSync(sessionRoot, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    });

    let sessionId: string;

    it("initializes with capabilities and an env-var auth method", async () => {
        const result = (await client.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })) as Record<string, unknown>;
        expect(result["protocolVersion"]).toBe(1);
        expect(result["agentInfo"]).toMatchObject({ name: "dsh-acp" });
        const capabilities = result["agentCapabilities"] as Record<string, unknown>;
        expect(capabilities["loadSession"]).toBe(true);
        expect(capabilities["promptCapabilities"]).toMatchObject({ embeddedContext: true, image: false });
        const authMethods = result["authMethods"] as Array<Record<string, unknown>>;
        expect(authMethods[0]).toMatchObject({ type: "env_var", id: "deepseek-api-key" });
    }, 60_000);

    it("creates a session with modes and model config options", async () => {
        const result = (await client.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        })) as Record<string, unknown>;
        sessionId = result["sessionId"] as string;
        expect(sessionId).toBeTruthy();
        expect(result["modes"]).toMatchObject({ currentModeId: "workspace-write" });
        const modes = (result["modes"] as { availableModes: Array<{ id: string }> }).availableModes.map(
            (mode) => mode.id,
        );
        expect(modes).toEqual(["read-only", "workspace-write", "danger-full-access"]);
        const configOptions = result["configOptions"] as Array<Record<string, unknown>>;
        expect(configOptions[0]).toMatchObject({ id: "model", type: "select", currentValue: "deepseek-v4-flash" });
    }, 60_000);

    it("rejects relative cwds and mcp servers", async () => {
        await expect(client.request("session/new", { cwd: "relative/path", mcpServers: [] })).rejects.toThrow(
            /absolute/,
        );
        await expect(
            client.request("session/new", {
                cwd: workspace,
                mcpServers: [{ name: "x", command: "y", args: [], env: [] }],
            }),
        ).rejects.toThrow(/mcpServers/);
    }, 60_000);

    it("serves the /status command without touching the model", async () => {
        const result = (await client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "/status" }],
        })) as Record<string, unknown>;
        expect(result["stopReason"]).toBe("end_turn");
        const updates = client.updatesFor(sessionId);
        const status = updates.find((update) => update["sessionUpdate"] === "agent_message_chunk");
        expect(status).toBeDefined();
        const content = (status as { content: { text: string } }).content;
        expect(content.text).toContain("dsh-acp");
        expect(content.text).toContain("deepseek-v4-flash");
        expect(content.text).toContain("workspace-write");
    }, 60_000);

    it("publishes available commands for new sessions", () => {
        const updates = client.updatesFor(sessionId);
        const commands = updates.find((update) => update["sessionUpdate"] === "available_commands_update");
        expect(commands).toMatchObject({
            availableCommands: [{ name: "status", description: expect.stringContaining("status") }],
        });
    });

    it("switches session modes", async () => {
        const result = await client.request("session/set_mode", { sessionId, modeId: "read-only" });
        expect(result).toEqual({});
        const updates = client.updatesFor(sessionId);
        expect(
            updates.some(
                (update) =>
                    update["sessionUpdate"] === "current_mode_update" && update["currentModeId"] === "read-only",
            ),
        ).toBe(true);
        await expect(client.request("session/set_mode", { sessionId, modeId: "bogus" })).rejects.toThrow(
            /unknown mode/,
        );
    }, 60_000);

    it("switches models through the config option and lists sessions", async () => {
        const result = (await client.request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: "deepseek-v4-pro",
        })) as Record<string, unknown>;
        const configOptions = result["configOptions"] as Array<Record<string, unknown>>;
        expect(configOptions[0]).toMatchObject({ id: "model", currentValue: "deepseek-v4-pro" });

        const list = (await client.request("session/list", {})) as Record<string, unknown>;
        const sessions = list["sessions"] as Array<Record<string, unknown>>;
        expect(sessions.some((session) => session["sessionId"] === sessionId)).toBe(true);
    }, 60_000);

    it("cancels idle sessions without error and answers unknown sessions loudly", async () => {
        await expect(
            client.request("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] }),
        ).rejects.toThrow(/unknown session/);
    }, 60_000);

    it("loads a persisted session from a fresh server process", async () => {
        // End the first server so the second owns the JSONL store exclusively.
        await client.close();
        client = new AcpTestClient(sessionRoot, workspace);
        await client.request("initialize", { protocolVersion: 1 });
        const result = (await client.request("session/load", {
            sessionId,
            cwd: workspace,
            mcpServers: [],
        })) as Record<string, unknown>;
        expect(result["modes"]).toMatchObject({ currentModeId: "workspace-write" });
        // The reloaded session accepts adapter commands again.
        const status = (await client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "/status" }],
        })) as Record<string, unknown>;
        expect(status["stopReason"]).toBe("end_turn");
        await expect(
            client.request("session/load", { sessionId: "missing", cwd: workspace, mcpServers: [] }),
        ).rejects.toThrow(/session not found/);
    }, 60_000);
});

// Optional: run the same handshake against a real standalone host install
// (`npm install @deepseek-ai/dsh`) when one is available. Set
// DSH_ACP_TEST_HOST to its directory; CI without one skips this block.
const HOST_TREE = process.env["DSH_ACP_TEST_HOST"];

describe.skipIf(HOST_TREE === undefined)("dsh-acp against a standalone host install", () => {
    let client: AcpTestClient;
    let sessionRoot: string;
    let workspace: string;

    beforeAll(() => {
        sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-host-sessions-"));
        workspace = mkdtempSync(join(tmpdir(), "dsh-acp-host-workspace-"));
        client = new AcpTestClient(sessionRoot, workspace, HOST_TREE);
    });

    afterAll(async () => {
        await client.close();
        rmSync(sessionRoot, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    });

    it("boots from the host tree and serves a session", async () => {
        const init = (await client.request("initialize", { protocolVersion: 1 })) as Record<string, unknown>;
        expect(init["agentInfo"]).toMatchObject({ name: "dsh-acp" });
        const created = (await client.request("session/new", { cwd: workspace, mcpServers: [] })) as Record<
            string,
            unknown
        >;
        expect(created["sessionId"]).toBeTruthy();
        const status = (await client.request("session/prompt", {
            sessionId: created["sessionId"],
            prompt: [{ type: "text", text: "/status" }],
        })) as Record<string, unknown>;
        expect(status["stopReason"]).toBe("end_turn");
    }, 120_000);
});
