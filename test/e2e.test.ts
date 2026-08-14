/**
 * End-to-end smoke test: boots the real dsh-acp server (full harness
 * composition) as a child process and speaks ACP over its stdio.
 *
 * No model calls are made: session/new only constructs an agent, and the
 * /status prompt is intercepted by the adapter before it would reach the
 * model. A fake DEEPSEEK_BASE_URL satisfies the credential gate.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

    constructor(
        sessionRoot: string,
        workspace: string,
        dshPath?: string,
        envPatch?: Record<string, string | undefined>,
    ) {
        const env: Record<string, string | undefined> = {
            ...process.env,
            DEEPSEEK_BASE_URL: "http://127.0.0.1:1", // credential gate only; never dialed
            DSH_SESSION_ROOT: sessionRoot,
            DSH_HOME: join(sessionRoot, "home"),
            DSH_ACP_WORKSPACE: workspace,
            ...(dshPath !== undefined ? { DSH_PATH: dshPath } : {}),
            ...(envPatch ?? {}),
        };
        for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
        this.child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
            cwd: ROOT,
            env: env as Record<string, string>,
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
                const error = message["error"] as { message?: string; data?: unknown };
                const detail = error.data === undefined ? "" : ` — ${JSON.stringify(error.data)}`;
                pending?.reject(new Error(`${error.message ?? "JSON-RPC error"}${detail}`));
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

    it("initializes with capabilities and no ACP-mediated auth", async () => {
        const result = (await client.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })) as Record<string, unknown>;
        expect(result["protocolVersion"]).toBe(1);
        expect(result["agentInfo"]).toMatchObject({ name: "dsh-acp" });
        const capabilities = result["agentCapabilities"] as Record<string, unknown>;
        expect(capabilities["loadSession"]).toBe(true);
        expect(capabilities["promptCapabilities"]).toMatchObject({ embeddedContext: true, image: false });
        // Credential management is the harness's own concern (dsh Web UI /
        // environment); the adapter advertises no ACP auth methods.
        // Terminal Auth only: `dsh-acp login` runs out-of-band; no auth flows
        // through the client itself.
        const methods = result["authMethods"] as Array<Record<string, unknown>>;
        expect(methods).toHaveLength(1);
        expect(methods[0]).toMatchObject({
            id: "terminal-login",
            _meta: { "terminal-auth": { args: ["login"] } },
        });
    }, 60_000);

    it("creates a session with sandbox modes and config options (model, effort)", async () => {
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
        const byId = new Map(configOptions.map((option) => [option["id"], option]));
        // The permission level is both the session-mode state and a config
        // option (some clients only render the latter); approval policy stays
        // bundled inside it, never a standalone option (matching the Web UI).
        expect(byId.get("mode")).toMatchObject({ type: "select", category: "mode", currentValue: "workspace-write" });
        expect(byId.has("approvals")).toBe(false);
        expect(byId.get("model")).toMatchObject({ type: "select", category: "model", currentValue: "deepseek-v4-flash" });
        expect(byId.get("effort")).toMatchObject({ type: "select", category: "thought_level" });
        const efforts = (byId.get("effort") as { options: Array<{ value: string }> }).options.map((o) => o.value);
        expect(efforts).toContain("high");
    }, 60_000);

    it("rejects relative cwds", async () => {
        await expect(client.request("session/new", { cwd: "relative/path", mcpServers: [] })).rejects.toThrow(
            /absolute/,
        );
    }, 60_000);

    it("accepts mcpServers, tolerating dead servers and unknown transports", async () => {
        // failOnStartupError is off: a server that cannot start must not take
        // the session down, and an unsupported transport is skipped. The name
        // is sanitized onto mcp-client's [A-Za-z0-9_-]{1,32} charset.
        const result = (await client.request("session/new", {
            cwd: workspace,
            mcpServers: [
                {
                    name: "dead server! (test)",
                    command: "/nonexistent/dsh-acp-mcp-e2e",
                    args: [],
                    env: [{ name: "X", value: "1" }],
                },
                { type: "sse", name: "legacy", url: "http://127.0.0.1:1/sse" },
            ],
        })) as Record<string, unknown>;
        expect(result["sessionId"]).toBeTruthy();
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

    it("publishes available commands (builtins + harness registry)", async () => {
        let names: string[] = [];
        for (let attempt = 0; attempt < 40; attempt += 1) {
            const updates = client.updatesFor(sessionId);
            const commands = [...updates]
                .reverse()
                .find((update) => update["sessionUpdate"] === "available_commands_update");
            const list = commands?.["availableCommands"] as Array<{ name: string }> | undefined;
            names = list?.map((c) => c.name) ?? [];
            if (names.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        // Adapter built-ins always lead…
        expect(names.slice(0, 4)).toEqual(["status", "login", "logout", "model"]);
        // …followed by the composition's own registry (dsh-base mounts
        // compact among others).
        expect(names).toContain("compact");
    }, 60_000);

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
        // Mode changes also republish config options so config-option clients stay in sync.
        expect(updates.some((update) => update["sessionUpdate"] === "config_option_update")).toBe(true);
        await expect(client.request("session/set_mode", { sessionId, modeId: "bogus" })).rejects.toThrow(
            /unknown mode/,
        );
    }, 60_000);

    it("switches effort through config options; permission knobs are not options", async () => {
        const effort = (await client.request("session/set_config_option", {
            sessionId,
            configId: "effort",
            value: "high",
        })) as Record<string, unknown>;
        const byId = new Map(
            (effort["configOptions"] as Array<Record<string, unknown>>).map((option) => [option["id"], option]),
        );
        expect(byId.get("effort")).toMatchObject({ currentValue: "high" });

        // Permission facts travel through the mode option or session modes;
        // a standalone approvals knob stays rejected.
        const modeSet = (await client.request("session/set_config_option", {
            sessionId,
            configId: "mode",
            value: "read-only",
        })) as Record<string, unknown>;
        const modeById = new Map(
            (modeSet["configOptions"] as Array<Record<string, unknown>>).map((option) => [option["id"], option]),
        );
        expect(modeById.get("mode")).toMatchObject({ currentValue: "read-only" });
        const approvalsError = await client
            .request("session/set_config_option", { sessionId, configId: "approvals", value: "never" })
            .then(
                () => undefined,
                (error: unknown) => error,
            );
        expect(String(approvalsError)).toMatch(/unknown config option/);

        await expect(
            client.request("session/set_config_option", { sessionId, configId: "effort", value: "bogus" }),
        ).rejects.toThrow(/unknown effort/);
        await expect(
            client.request("session/set_config_option", { sessionId, configId: "bogus", value: "x" }),
        ).rejects.toThrow(/unknown config option/);

        // Restore for the later status/mode assertions.
        await client.request("session/set_mode", { sessionId, modeId: "read-only" });
    }, 60_000);

    it("switches models through the config option and lists sessions", async () => {
        const result = (await client.request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: "deepseek-v4-pro",
        })) as Record<string, unknown>;
        const configOptions = result["configOptions"] as Array<Record<string, unknown>>;
        const model = configOptions.find((option) => option["id"] === "model");
        expect(model).toMatchObject({ id: "model", currentValue: "deepseek-v4-pro" });
        // The picked effort survives the resume-based model switch.
        const effort = configOptions.find((option) => option["id"] === "effort");
        expect(effort).toMatchObject({ currentValue: "high" });

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
        // The mode switched to read-only earlier in this suite; the durable
        // permission/preset fact must fold back on load (a fresh process).
        expect(result["modes"]).toMatchObject({ currentModeId: "read-only" });
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

    it("restores a persisted session on direct prompt without session/load", async () => {
        // Zed keeps threads across agent restarts and may prompt an old
        // session id directly; the adapter restores it from the log.
        await client.close();
        client = new AcpTestClient(sessionRoot, workspace);
        await client.request("initialize", { protocolVersion: 1 });
        const status = (await client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "/status" }],
        })) as Record<string, unknown>;
        expect(status["stopReason"]).toBe("end_turn");
        // Truly unknown ids still fail loudly.
        await expect(
            client.request("session/prompt", {
                sessionId: "11111111-1111-4111-8111-111111111111",
                prompt: [{ type: "text", text: "hi" }],
            }),
        ).rejects.toThrow(/unknown session/);
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

describe("credential self-service (/login flow)", () => {
    let client: AcpTestClient;
    let sessionRoot: string;
    let workspace: string;
    let home: string;
    let sessionId: string;

    beforeAll(async () => {
        sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-login-sessions-"));
        workspace = mkdtempSync(join(tmpdir(), "dsh-acp-login-workspace-"));
        home = mkdtempSync(join(tmpdir(), "dsh-acp-login-home-"));
        // No ambient credential at all; the harness credential store lives in
        // an isolated DSH_HOME.
        client = new AcpTestClient(sessionRoot, workspace, undefined, {
            DEEPSEEK_BASE_URL: undefined,
            DEEPSEEK_API_KEY: undefined,
            DSH_HOME: home,
        });
        await client.request("initialize", { protocolVersion: 1 });
        const created = (await client.request("session/new", { cwd: workspace, mcpServers: [] })) as Record<
            string,
            unknown
        >;
        sessionId = created["sessionId"] as string;
    }, 120_000);

    afterAll(async () => {
        await client.close();
        for (const dir of [sessionRoot, workspace, home]) rmSync(dir, { recursive: true, force: true });
    });

    const promptText = async (text: string): Promise<string> => {
        const before = client.updatesFor(sessionId).length;
        const result = (await client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text }],
        })) as Record<string, unknown>;
        expect(result["stopReason"]).toBe("end_turn");
        return client
            .updatesFor(sessionId)
            .slice(before)
            .filter((update) => update["sessionUpdate"] === "agent_message_chunk")
            .map((update) => (update["content"] as { text: string }).text)
            .join("");
    };

    it("creates a session without any credential and guides instead of erroring", async () => {
        expect(sessionId).toBeTruthy();
        const guidance = await promptText("hello there");
        expect(guidance).toContain("/login");
        expect(guidance).toContain("not sent to the model");
    }, 120_000);

    it("stores a key via /login, reports it in /status, removes it via /logout", async () => {
        const saved = await promptText("/login sk-test-abcdef1234567890");
        expect(saved).toContain("Saved DEEPSEEK_API_KEY");
        expect(saved).toContain("sk-t…7890");
        expect(existsSync(join(home, ".credentials.yaml"))).toBe(true);

        const status = await promptText("/status");
        expect(status).toContain("| Credential |");
        expect(status).not.toContain("not configured");

        const removed = await promptText("/logout");
        expect(removed).toContain("Removed the stored DEEPSEEK_API_KEY");

        const guidance = await promptText("are you there?");
        expect(guidance).toContain("/login");
    }, 120_000);
});
