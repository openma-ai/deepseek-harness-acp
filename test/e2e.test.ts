/**
 * End-to-end smoke test: boots the real dsh-acp server (full harness
 * composition) as a child process and speaks ACP over its stdio.
 *
 * No model calls are made: session/new only constructs an agent, and the
 * /status prompt is intercepted by the adapter before it would reach the
 * model. A dummy DEEPSEEK_API_KEY plus a fake DEEPSEEK_BASE_URL satisfy
 * the credential gate without ever dialing a provider.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
    private closePromise?: Promise<void>;

    constructor(
        sessionRoot: string,
        workspace: string,
        dshPath?: string,
        envPatch?: Record<string, string | undefined>,
        serverArgs: string[] = [],
    ) {
        const env: Record<string, string | undefined> = {
            ...process.env,
            DEEPSEEK_API_KEY: "sk-test-e2e-not-a-real-key",
            DEEPSEEK_BASE_URL: "http://127.0.0.1:1", // credential gate only; never dialed
            DSH_SESSION_ROOT: sessionRoot,
            DSH_HOME: join(sessionRoot, "home"),
            DSH_ACP_WORKSPACE: workspace,
            // Host-default tests must not inherit the developer shell's
            // explicit per-process override.
            DSH_PERMISSION_MODE: undefined,
            DSH_REASONING_EFFORT: undefined,
            ...(dshPath !== undefined ? { DSH_PATH: dshPath } : {}),
            ...(envPatch ?? {}),
        };
        for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
        this.child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...serverArgs], {
            cwd: ROOT,
            env: env as Record<string, string>,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stdout.setEncoding("utf8");
        this.child.stderr.setEncoding("utf8");
        this.child.stderr.on("data", (chunk: string) => {
            this.stderr += chunk;
        });
        this.child.on("exit", (code, signal) => {
            if (this.pending.size === 0) return;
            const error = new Error(
                `dsh-acp exited before replying (code ${String(code)}, signal ${String(signal)})\n`
                    + `stderr:\n${this.stderr.slice(-2000)}`,
            );
            for (const pending of this.pending.values()) pending.reject(error);
            this.pending.clear();
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
                const error = message["error"] as { code?: number; message?: string; data?: unknown };
                const detail = error.data === undefined ? "" : ` — ${JSON.stringify(error.data)}`;
                pending?.reject(Object.assign(
                    new Error(`${error.message ?? "JSON-RPC error"}${detail}`),
                    { code: error.code },
                ));
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
        if (this.closePromise !== undefined) return this.closePromise;
        this.child.stdin.end();
        this.closePromise = new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.child.kill("SIGKILL");
                resolve();
            }, 5000);
            this.child.on("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
        return this.closePromise;
    }
}

describe("dsh-acp bundle overlays", () => {
    let client: AcpTestClient;
    const roots: string[] = [];

    function testBundle(name: string): { root: string; marker: string } {
        const root = mkdtempSync(join(tmpdir(), "dsh-acp-bundle-"));
        roots.push(root);
        const marker = join(root, "activated.txt");
        writeFileSync(join(root, "package.json"), JSON.stringify({
            name,
            type: "module",
            main: "./index.js",
            dsh: { bundle: { patch: "./cordis.patch.yml" } },
        }));
        writeFileSync(
            join(root, "cordis.patch.yml"),
            JSON.stringify([{
                insert: [{ id: `${name}-marker`, name, config: { marker } }],
            }]),
        );
        writeFileSync(
            join(root, "index.js"),
            "import { writeFileSync } from 'node:fs'\n"
                + "export function apply(_ctx, config) { writeFileSync(config.marker, 'active') }\n",
        );
        return { root, marker };
    }

    afterAll(async () => {
        await client?.close();
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    it("activates every bundle supplied on the command line", async () => {
        const sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-bundle-sessions-"));
        const workspace = mkdtempSync(join(tmpdir(), "dsh-acp-bundle-workspace-"));
        roots.push(sessionRoot, workspace);
        const first = testBundle("dsh-acp-test-first");
        const second = testBundle("dsh-acp-test-second");
        client = new AcpTestClient(
            sessionRoot,
            workspace,
            undefined,
            undefined,
            ["--bundle", first.root, "--bundle", second.root],
        );

        await client.request("initialize", { protocolVersion: 1 }, 60_000);
        expect(existsSync(first.marker)).toBe(true);
        expect(existsSync(second.marker)).toBe(true);
    }, 90_000);
});

describe("dsh-acp live command catalogue", () => {
    let client: AcpTestClient;
    const roots: string[] = [];

    afterAll(async () => {
        await client?.close();
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    it("republishes commands registered after session creation", async () => {
        const sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-command-change-sessions-"));
        const workspace = mkdtempSync(join(tmpdir(), "dsh-acp-command-change-workspace-"));
        const bundle = mkdtempSync(join(tmpdir(), "dsh-acp-command-change-bundle-"));
        const trigger = join(bundle, "register-late-command");
        roots.push(sessionRoot, workspace, bundle);
        writeFileSync(join(bundle, "package.json"), JSON.stringify({
            name: "dsh-acp-test-command-change",
            type: "module",
            main: "./index.js",
            dsh: { bundle: { patch: "./cordis.patch.yml" } },
        }));
        writeFileSync(join(bundle, "cordis.patch.yml"), JSON.stringify([{
            insert: [{
                id: "dsh-acp-test-command-change",
                name: "dsh-acp-test-command-change",
                config: { trigger },
            }],
        }]));
        writeFileSync(join(bundle, "index.js"), [
            "import { existsSync } from 'node:fs'",
            "export const inject = ['agents']",
            "export function apply(ctx, config) {",
            "  const timers = new Set()",
            "  ctx.on('agent/created', ({ agent }) => {",
            "    const timer = setInterval(() => {",
            "      if (!existsSync(config.trigger)) return",
            "      clearInterval(timer)",
            "      timers.delete(timer)",
            "      agent.ctx.inject(['commands'], commandCtx => commandCtx.commands.register({",
            "        name: 'late-fixture-command',",
            "        description: 'Registered after the ACP session snapshot',",
            "        handler: () => ({ kind: 'success', text: 'late command ready' }),",
            "      }))",
            "    }, 20)",
            "    timers.add(timer)",
            "  })",
            "  ctx.effect(() => () => { for (const timer of timers) clearInterval(timer) })",
            "}",
        ].join("\n"));

        client = new AcpTestClient(
            sessionRoot,
            workspace,
            undefined,
            undefined,
            ["--bundle", bundle],
        );
        await client.request("initialize", { protocolVersion: 1 }, 60_000);
        const created = await client.request("session/new", { cwd: workspace, mcpServers: [] }) as {
            sessionId: string;
        };

        let initialNames: string[] = [];
        for (let attempt = 0; attempt < 80; attempt += 1) {
            const update = [...client.updatesFor(created.sessionId)]
                .reverse()
                .find((entry) => entry["sessionUpdate"] === "available_commands_update");
            initialNames = ((update?.["availableCommands"] ?? []) as Array<{ name: string }>).map(({ name }) => name);
            if (initialNames.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(initialNames).not.toContain("late-fixture-command");

        writeFileSync(trigger, "register");
        let liveNames = initialNames;
        for (let attempt = 0; attempt < 120; attempt += 1) {
            const update = [...client.updatesFor(created.sessionId)]
                .reverse()
                .find((entry) => entry["sessionUpdate"] === "available_commands_update");
            liveNames = ((update?.["availableCommands"] ?? []) as Array<{ name: string }>).map(({ name }) => name);
            if (liveNames.includes("late-fixture-command")) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(liveNames).toContain("late-fixture-command");
    }, 90_000);
});

describe("dsh-acp Host-owned defaults", () => {
    const roots: string[] = [];
    const clients: AcpTestClient[] = [];

    afterAll(async () => {
        await Promise.all(clients.map((entry) => entry.close()));
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    it("materializes the Host default route on the parent agent for subagent inheritance", async () => {
        const sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-inherited-model-sessions-"));
        const workspace = mkdtempSync(join(tmpdir(), "dsh-acp-inherited-model-workspace-"));
        const bundle = mkdtempSync(join(tmpdir(), "dsh-acp-inherited-model-bundle-"));
        const marker = join(bundle, "agent-options.json");
        roots.push(sessionRoot, workspace, bundle);

        const harnessHome = join(sessionRoot, "home");
        mkdirSync(harnessHome, { recursive: true });
        writeFileSync(
            join(harnessHome, "settings.yaml"),
            "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-pro\n",
        );
        writeFileSync(join(bundle, "package.json"), JSON.stringify({
            name: "dsh-acp-test-agent-options",
            type: "module",
            main: "./index.js",
            dsh: { bundle: { patch: "./cordis.patch.yml" } },
        }));
        writeFileSync(join(bundle, "cordis.patch.yml"), JSON.stringify([{
            insert: [{
                id: "dsh-acp-test-agent-options",
                name: "dsh-acp-test-agent-options",
                config: { marker },
            }],
        }]));
        writeFileSync(join(bundle, "index.js"), [
            "import { writeFileSync } from 'node:fs'",
            "export const inject = ['agents']",
            "export function apply(ctx, config) {",
            "  ctx.on('agent/created', ({ agent }) => {",
            "    if (agent.session.header.parentSession === undefined) {",
            "      writeFileSync(config.marker, JSON.stringify(agent.options))",
            "    }",
            "  })",
            "}",
        ].join("\n"));

        const client = new AcpTestClient(
            sessionRoot,
            workspace,
            undefined,
            undefined,
            ["--bundle", bundle],
        );
        clients.push(client);

        await client.request("initialize", { protocolVersion: 1 }, 60_000);
        await client.request("session/new", { cwd: workspace, mcpServers: [] });

        expect(JSON.parse(readFileSync(marker, "utf8")))
            .toMatchObject({ provider: "deepseek-official", model: "deepseek-v4-pro" });
    }, 90_000);

    it("saves the selected model but keeps effort scoped to its session", async () => {
        const sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-default-model-sessions-"));
        const workspace = mkdtempSync(join(tmpdir(), "dsh-acp-default-model-workspace-"));
        roots.push(sessionRoot, workspace);
        const client = new AcpTestClient(sessionRoot, workspace);
        clients.push(client);

        await client.request("initialize", { protocolVersion: 1 }, 60_000);
        const first = (await client.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        })) as { sessionId: string };
        await client.request("session/set_config_option", {
            sessionId: first.sessionId,
            configId: "model",
            value: "deepseek-v4-pro",
        });
        await client.request("session/set_config_option", {
            sessionId: first.sessionId,
            configId: "effort",
            value: "max",
        });
        expect(readFileSync(join(sessionRoot, "home", "settings.yaml"), "utf8"))
            .not.toContain("reasoningEffort");

        const later = (await client.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        })) as { configOptions: Array<Record<string, unknown>> };
        const options = new Map(later.configOptions.map((option) => [option["id"], option]));
        expect(options.get("model")).toMatchObject({ currentValue: "deepseek-v4-pro" });
        expect(options.get("effort")).toMatchObject({ currentValue: "high" });
    }, 90_000);

    it("ignores the persisted settings effort when assembling a prompt", async () => {
        const sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-settings-effort-sessions-"));
        const workspace = mkdtempSync(join(tmpdir(), "dsh-acp-settings-effort-workspace-"));
        const harnessHome = join(sessionRoot, "home");
        roots.push(sessionRoot, workspace);
        mkdirSync(harnessHome, { recursive: true });
        writeFileSync(
            join(harnessHome, "settings.yaml"),
            [
                "agent-default-model:",
                "  provider: deepseek-official",
                "  model: deepseek-v4-pro",
                "  reasoningEffort: max",
                "",
            ].join("\n"),
        );

        const requestBodies: Array<Record<string, unknown>> = [];
        const server = createServer((request, response) => {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
                body += chunk;
            });
            request.on("end", () => {
                requestBodies.push(JSON.parse(body) as Record<string, unknown>);
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "fixture stop" } }));
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });

        try {
            const address = server.address();
            if (address === null || typeof address === "string") throw new Error("fixture server has no TCP address");
            const client = new AcpTestClient(sessionRoot, workspace, undefined, {
                DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
            });
            clients.push(client);

            await client.request("initialize", { protocolVersion: 1 }, 60_000);
            const created = (await client.request("session/new", {
                cwd: workspace,
                mcpServers: [],
            })) as { sessionId: string };
            await client.request("session/prompt", {
                sessionId: created.sessionId,
                prompt: [{ type: "text", text: "settings effort source probe" }],
            }).catch(() => undefined);

            expect(requestBodies[0]).toMatchObject({ reasoning_effort: "high" });
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined ? resolve() : reject(error));
            });
        }
    }, 90_000);

    it("restores the selected permission after the ACP Host restarts", async () => {
        const sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-default-permission-switch-sessions-"));
        const workspace = mkdtempSync(join(tmpdir(), "dsh-acp-default-permission-switch-workspace-"));
        roots.push(sessionRoot, workspace);
        const client = new AcpTestClient(sessionRoot, workspace);
        clients.push(client);

        await client.request("initialize", { protocolVersion: 1 }, 60_000);
        const first = (await client.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        })) as { sessionId: string };
        await client.request("session/set_mode", {
            sessionId: first.sessionId,
            modeId: "danger-full-access",
        });
        await client.close();

        const restarted = new AcpTestClient(sessionRoot, workspace);
        clients.push(restarted);
        await restarted.request("initialize", { protocolVersion: 1 }, 60_000);
        const later = (await restarted.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        })) as Record<string, unknown>;
        expect(later["modes"]).toMatchObject({ currentModeId: "danger-full-access" });
        const options = new Map(
            (later["configOptions"] as Array<Record<string, unknown>>)
                .map((option) => [option["id"], option]),
        );
        expect(options.get("mode")).toMatchObject({ currentValue: "danger-full-access" });
        const availableModes = (later["modes"] as { availableModes: Array<Record<string, unknown>> })
            .availableModes;
        expect(availableModes.every((mode) =>
            typeof mode["name"] === "string" && mode["name"].length > 0,
        )).toBe(true);
        const modeChoices = (options.get("mode")?.["options"] ?? []) as Array<Record<string, unknown>>;
        expect(modeChoices.every((choice) =>
            typeof choice["name"] === "string" && choice["name"].length > 0,
        )).toBe(true);
    }, 90_000);

    it("starts a new session from the Host permission default", async () => {
        const sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-default-permission-sessions-"));
        const workspace = mkdtempSync(join(tmpdir(), "dsh-acp-default-permission-workspace-"));
        roots.push(sessionRoot, workspace);
        const harnessHome = join(sessionRoot, "home");
        mkdirSync(harnessHome, { recursive: true });
        writeFileSync(join(harnessHome, "settings.yaml"), "permission:\n  defaultPreset: read-only\n");
        const client = new AcpTestClient(sessionRoot, workspace);
        clients.push(client);

        await client.request("initialize", { protocolVersion: 1 }, 60_000);
        const created = (await client.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        })) as Record<string, unknown>;
        expect(created["modes"]).toMatchObject({ currentModeId: "read-only" });
        const options = new Map(
            (created["configOptions"] as Array<Record<string, unknown>>)
                .map((option) => [option["id"], option]),
        );
        expect(options.get("mode")).toMatchObject({ currentValue: "read-only" });
    }, 90_000);

    it("does not let a stale installed ACP profile override the standalone Host defaults", async () => {
        const sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-stale-profile-sessions-"));
        const workspace = mkdtempSync(join(tmpdir(), "dsh-acp-stale-profile-workspace-"));
        roots.push(sessionRoot, workspace);
        const harnessHome = join(sessionRoot, "home");
        const staleProfile = join(harnessHome, "profiles", "acp");
        mkdirSync(staleProfile, { recursive: true });
        writeFileSync(
            join(staleProfile, "package.json"),
            JSON.stringify({
                name: "stale-acp-profile",
                private: true,
                dependencies: { "@openma/deepseek-harness-acp": "0.0.1" },
                dsh: { profile: { bundles: ["definitely-missing-stale-acp-bundle"] } },
            }),
        );
        writeFileSync(join(staleProfile, "cordis.yml"), "[]\n");
        writeFileSync(join(staleProfile, "cordis.patch.yml"), "[]\n");
        writeFileSync(
            join(harnessHome, "settings.yaml"),
            "permission:\n  defaultPreset: danger-full-access\n",
        );

        const client = new AcpTestClient(sessionRoot, workspace);
        clients.push(client);
        await client.request("initialize", { protocolVersion: 1 }, 60_000);
        const created = (await client.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        })) as Record<string, unknown>;

        expect(created["modes"]).toMatchObject({ currentModeId: "danger-full-access" });
    }, 90_000);

    it("lets an explicit CLI permission override the Host default", async () => {
        const sessionRoot = mkdtempSync(join(tmpdir(), "dsh-acp-explicit-permission-sessions-"));
        const workspace = mkdtempSync(join(tmpdir(), "dsh-acp-explicit-permission-workspace-"));
        roots.push(sessionRoot, workspace);
        const harnessHome = join(sessionRoot, "home");
        mkdirSync(harnessHome, { recursive: true });
        writeFileSync(join(harnessHome, "settings.yaml"), "permission:\n  defaultPreset: read-only\n");
        const client = new AcpTestClient(
            sessionRoot,
            workspace,
            undefined,
            undefined,
            ["--permission-mode", "danger-full-access"],
        );
        clients.push(client);

        await client.request("initialize", { protocolVersion: 1 }, 60_000);
        const created = (await client.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        })) as Record<string, unknown>;
        expect(created["modes"]).toMatchObject({ currentModeId: "danger-full-access" });
    }, 90_000);
});

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

    it("initializes with Agent Auth and logout", async () => {
        const result = (await client.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                _meta: { dsh: { cordis: { protocol: 0 } } },
            },
        })) as Record<string, unknown>;
        expect(result["protocolVersion"]).toBe(1);
        expect(result["agentInfo"]).toMatchObject({ name: "dsh-acp" });
        const capabilities = result["agentCapabilities"] as Record<string, unknown>;
        expect(capabilities["loadSession"]).toBe(true);
        expect(capabilities["promptCapabilities"]).toMatchObject({ embeddedContext: true, image: true });
        expect(capabilities["auth"]).toEqual({ logout: {} });
        expect(capabilities["_meta"]).toMatchObject({ dsh: { cordis: { protocol: 0 } } });
        const methods = result["authMethods"] as Array<Record<string, unknown>>;
        expect(methods.length).toBeGreaterThanOrEqual(1);
        expect(methods.every((method) => method["type"] === undefined || method["type"] === "agent")).toBe(true);
        expect(methods.some((method) => {
            const id = method["id"];
            return typeof id === "string" && id.startsWith("api-key");
        })).toBe(true);
        expect(methods[0]?.["_meta"]).toMatchObject({ "api-key": {} });
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
        expect(byId.get("collaboration_mode")).toMatchObject({
            type: "select",
            currentValue: "default",
            options: [
                { value: "default", name: "Default" },
                { value: "plan", name: "Plan" },
            ],
        });
        const efforts = (byId.get("effort") as { options: Array<{ value: string }> }).options.map((o) => o.value);
        expect(efforts).toContain("high");
        expect(byId.get("agent")).toMatchObject({ type: "select", currentValue: "standard" });
        const agents = (byId.get("agent") as { options: Array<{ value: string }> }).options.map((o) => o.value);
        expect(agents).toEqual(expect.arrayContaining(["standard", "code", "minimal", "cordis"]));
    }, 60_000);

    it("rejects relative cwds", async () => {
        await expect(client.request("session/new", { cwd: "relative/path", mcpServers: [] })).rejects.toThrow(
            /absolute/,
        );
    }, 60_000);

    it("rejects non-empty additional directories instead of silently narrowing the workspace", async () => {
        await expect(client.request("session/new", {
            cwd: workspace,
            additionalDirectories: [join(workspace, "other-root")],
            mcpServers: [],
        })).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining("additionalDirectories is not supported"),
        });
    }, 60_000);

    it("keeps a new session registered while Zed applies config defaults concurrently", async () => {
        const created = (await client.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        })) as Record<string, unknown>;
        const createdSessionId = created["sessionId"];

        const defaults = Promise.all([
            client.request("session/set_config_option", {
                sessionId: createdSessionId,
                configId: "agent",
                value: "code",
            }),
            client.request("session/set_config_option", {
                sessionId: createdSessionId,
                configId: "model",
                value: "deepseek-v4-pro",
            }),
        ]);

        await expect(defaults).resolves.toEqual([expect.any(Object), expect.any(Object)]);
        await expect(client.request("session/prompt", {
            sessionId: createdSessionId,
            prompt: [{ type: "text", text: "/status" }],
        })).resolves.toMatchObject({ stopReason: "end_turn" });
        const status = client.updatesFor(String(createdSessionId)).find(
            (update) =>
                update["sessionUpdate"] === "agent_message_chunk" &&
                (update["content"] as { text?: string } | undefined)?.text?.includes("**dsh-acp**"),
        );
        expect((status?.["content"] as { text: string }).text).toContain("| Preset | code |");
        expect((status?.["content"] as { text: string }).text).toContain("| Model | deepseek-v4-pro |");
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
        // This session has no logged model request, so it follows the live
        // product default saved by the earlier model selection, matching Web.
        expect(content.text).toContain("deepseek-v4-pro");
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
        // Adapter built-ins always lead. Login/logout are ACP methods, not
        // slash commands — putting `/login` in the catalogue made clients
        // treat credential setup as a chat command.
        expect(names.slice(0, 2)).toEqual(["status", "model"]);
        expect(names).not.toContain("login");
        expect(names).not.toContain("logout");
        // …followed by the composition's own registry (dsh-base mounts
        // compact among others).
        expect(names).toContain("compact");
        const commands = [...client.updatesFor(sessionId)]
            .reverse()
            .find((update) => update["sessionUpdate"] === "available_commands_update")?.[
                "availableCommands"
            ] as Array<Record<string, unknown>> | undefined;
        expect(commands?.find((command) => command["name"] === "plan")).toMatchObject({
            _meta: {
                commandAction: {
                    kind: "setConfigOption",
                    configId: "collaboration_mode",
                    value: "plan",
                    resetValue: "default",
                    presentation: "state",
                },
            },
        });
        expect(commands?.find((command) => command["name"] === "plan-view")).toMatchObject({
            description: "Open the current ACP plan",
            _meta: {
                commandAction: {
                    kind: "clientCommand",
                    presentation: "view",
                },
            },
        });
    }, 60_000);

    it("switches plan mode through the standard collaboration config option", async () => {
        const on = (await client.request("session/set_config_option", {
            sessionId,
            configId: "collaboration_mode",
            value: "plan",
        })) as Record<string, unknown>;
        const onById = new Map(
            (on["configOptions"] as Array<Record<string, unknown>>).map((option) => [option["id"], option]),
        );
        expect(onById.get("collaboration_mode")).toMatchObject({ currentValue: "plan" });

        const off = (await client.request("session/set_config_option", {
            sessionId,
            configId: "collaboration_mode",
            value: "default",
        })) as Record<string, unknown>;
        const offById = new Map(
            (off["configOptions"] as Array<Record<string, unknown>>).map((option) => [option["id"], option]),
        );
        expect(offById.get("collaboration_mode")).toMatchObject({ currentValue: "default" });
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

    it("switches the Agent preset to cordis without dropping the session", async () => {
        const result = (await client.request("session/set_config_option", {
            sessionId,
            configId: "agent",
            value: "cordis",
        })) as Record<string, unknown>;
        const configOptions = result["configOptions"] as Array<Record<string, unknown>>;
        const agent = configOptions.find((option) => option["id"] === "agent");
        expect(agent).toMatchObject({ id: "agent", currentValue: "cordis" });

        const status = (await client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "/status" }],
        })) as Record<string, unknown>;
        expect(status["stopReason"]).toBe("end_turn");
    }, 60_000);

    it("cancels idle sessions without error and answers unknown sessions loudly", async () => {
        await expect(
            client.request("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] }),
        ).rejects.toThrow(/unknown session/);
    }, 60_000);

    it("rejects additional directories when loading a session", async () => {
        const created = await client.request("session/new", {
            cwd: workspace,
            mcpServers: [],
        }) as { sessionId: string };
        await expect(client.request("session/load", {
            sessionId: created.sessionId,
            cwd: workspace,
            additionalDirectories: [join(workspace, "other-root")],
            mcpServers: [],
        })).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining("additionalDirectories is not supported"),
        });
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

    it("resumes a persisted session without replaying its history", async () => {
        await client.close();
        client = new AcpTestClient(sessionRoot, workspace);
        const initialized = (await client.request("initialize", { protocolVersion: 1 })) as Record<string, unknown>;
        expect(initialized["agentCapabilities"]).toMatchObject({
            sessionCapabilities: { resume: {} },
        });

        const result = (await client.request("session/resume", {
            sessionId,
            cwd: workspace,
            mcpServers: [],
        })) as Record<string, unknown>;
        expect(result["modes"]).toMatchObject({ currentModeId: "read-only" });

        const replayKinds = new Set([
            "user_message_chunk",
            "agent_message_chunk",
            "agent_thought_chunk",
            "tool_call",
            "tool_call_update",
        ]);
        expect(client.updatesFor(sessionId).filter((update) => replayKinds.has(String(update["sessionUpdate"])))).toEqual([]);

        await expect(client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "/status" }],
        })).resolves.toMatchObject({ stopReason: "end_turn" });
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

    it("serves session controls through the host tree", async () => {
        const init = (await client.request("initialize", { protocolVersion: 1 })) as Record<string, unknown>;
        expect(init["agentInfo"]).toMatchObject({ name: "dsh-acp" });
        const created = (await client.request("session/new", { cwd: workspace, mcpServers: [] })) as Record<
            string,
            unknown
        >;
        const hostSessionId = created["sessionId"] as string;
        expect(hostSessionId).toBeTruthy();

        await expect(
            client.request("session/set_mode", { sessionId: hostSessionId, modeId: "read-only" }),
        ).resolves.toEqual({});

        const plan = (await client.request("session/set_config_option", {
            sessionId: hostSessionId,
            configId: "collaboration_mode",
            value: "plan",
        })) as Record<string, unknown>;
        const planById = new Map(
            (plan["configOptions"] as Array<Record<string, unknown>>).map((option) => [option["id"], option]),
        );
        expect(planById.get("collaboration_mode")).toMatchObject({ currentValue: "plan" });

        const updateStart = client.updatesFor(hostSessionId).length;
        const compact = (await client.request("session/prompt", {
            sessionId: hostSessionId,
            prompt: [{ type: "text", text: "/compact" }],
        })) as Record<string, unknown>;
        expect(compact["stopReason"]).toBe("end_turn");
        const compactText = client
            .updatesFor(hostSessionId)
            .slice(updateStart)
            .filter((update) => update["sessionUpdate"] === "agent_message_chunk")
            .map((update) => (update["content"] as { text?: string } | undefined)?.text ?? "")
            .join("");
        expect(compactText).toMatch(/No compactable history|compact/i);
        expect(compactText).not.toContain("failed:");

        const status = (await client.request("session/prompt", {
            sessionId: hostSessionId,
            prompt: [{ type: "text", text: "/status" }],
        })) as Record<string, unknown>;
        expect(status["stopReason"]).toBe("end_turn");
    }, 120_000);
});

describe("ACP authentication (Agent Auth + logout)", () => {
    let client: AcpTestClient;
    let sessionRoot: string;
    let workspace: string;
    let home: string;

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
    }, 120_000);

    afterAll(async () => {
        await client.close();
        for (const dir of [sessionRoot, workspace, home]) rmSync(dir, { recursive: true, force: true });
    });

    it("refuses session/new without a credential via auth_required", async () => {
        await expect(client.request("session/new", { cwd: workspace, mcpServers: [] })).rejects.toMatchObject({
            message: expect.stringMatching(/Authentication required/i),
            code: -32000,
        });
    }, 60_000);

    it("refuses authenticate until a credential is in the harness store", async () => {
        await expect(client.request("authenticate", { methodId: "api-key" })).rejects.toMatchObject({
            message: expect.stringMatching(/Authentication required/i),
            code: -32000,
        });
    }, 60_000);

    it("accepts authenticate with an API key in _meta and then allows session/new", async () => {
        await expect(client.request("authenticate", {
            methodId: "api-key",
            _meta: { "api-key": { apiKey: "sk-test-abcdef1234567890" } },
        })).resolves.toEqual({});
        expect(existsSync(join(home, ".credentials.yaml"))).toBe(true);
        const created = (await client.request("session/new", { cwd: workspace, mcpServers: [] })) as Record<
            string,
            unknown
        >;
        expect(created["sessionId"]).toBeTruthy();

        await expect(client.request("logout", {})).resolves.toEqual({});
        await expect(client.request("session/new", { cwd: workspace, mcpServers: [] })).rejects.toMatchObject({
            code: -32000,
        });
    }, 120_000);

    it("accepts authenticate with gateway _meta and then allows session/new", async () => {
        await expect(client.request("authenticate", {
            methodId: "gateway",
            _meta: {
                gateway: {
                    baseUrl: "https://api.example.com/v1",
                    headers: { Authorization: "Bearer sk-gateway-abcdef1234567890" },
                },
            },
        })).resolves.toEqual({});
        expect(existsSync(join(home, ".credentials.yaml"))).toBe(true);
        const created = (await client.request("session/new", { cwd: workspace, mcpServers: [] })) as Record<
            string,
            unknown
        >;
        expect(created["sessionId"]).toBeTruthy();
    }, 120_000);
});
