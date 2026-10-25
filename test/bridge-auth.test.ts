/**
 * In-process coverage of the ACP auth surface: capability-gated auth methods,
 * `authenticate` paths, scoped `logout`, `_auth/status_update`, the browser
 * login url elicitation, and the native auth-command interception.
 */

import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { AgentContext } from "@agentclientprotocol/sdk/unstable";
import * as bridge from "../src/bridge/index.ts";
import { selfHarness } from "../src/bridge/self-harness.ts";

const AUTH_STATUS_UPDATE = "_auth/status_update";

interface FakeAgent {
    id: string;
    session: { id: string; header: { id: string; cwd: string }; snapshotEvents: () => unknown[] };
    ctx: Context;
    options: { model?: string };
    cancel: ReturnType<typeof vi.fn>;
    followup: ReturnType<typeof vi.fn>;
    steer: ReturnType<typeof vi.fn>;
    whenIdle: () => Promise<void>;
}

function fakeAgent(id: string, cwd: string): FakeAgent {
    return {
        id,
        session: { id, header: { id, cwd }, snapshotEvents: () => [] },
        ctx: new Context(),
        options: {},
        cancel: vi.fn(),
        followup: vi.fn(),
        steer: vi.fn(),
        whenIdle: () => new Promise<void>(() => {}),
    };
}

class BridgeClient {
    private input = new TransformStream();
    private output = new TransformStream();
    private writer = this.input.writable.getWriter();
    private reader = this.output.readable.getReader();
    private buffered: Record<string, unknown>[] = [];
    private waiters: { match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
    private nextId = 0;
    readonly notifications: Record<string, unknown>[] = [];
    /** Handles agent→client requests (e.g. elicitation/create). */
    onClientRequest: ((message: Record<string, unknown>) => void) | undefined;

    constructor() {
        void this.pump();
    }

    private async pump(): Promise<void> {
        for (;;) {
            const { value, done } = await this.reader.read();
            if (done) return;
            const message = value as Record<string, unknown>;
            if (message["method"] !== undefined && message["id"] === undefined) this.notifications.push(message);
            if (typeof message["method"] === "string" && message["id"] !== undefined) {
                this.onClientRequest?.(message);
                continue;
            }
            const waiter = this.waiters.findIndex((entry) => entry.match(message));
            if (waiter >= 0) {
                const [entry] = this.waiters.splice(waiter, 1);
                entry?.resolve(message);
            } else {
                this.buffered.push(message);
            }
        }
    }

    async send(message: Record<string, unknown>): Promise<void> {
        await this.writer.write(message);
    }

    async respond(id: unknown, result: unknown): Promise<void> {
        await this.send({ jsonrpc: "2.0", id, result });
    }

    async respondError(id: unknown, code: number, message: string): Promise<void> {
        await this.send({ jsonrpc: "2.0", id, error: { code, message } });
    }

    waitFor(match: (m: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<Record<string, unknown>> {
        const hit = this.buffered.find(match);
        if (hit !== undefined) {
            this.buffered.splice(this.buffered.indexOf(hit), 1);
            return Promise.resolve(hit);
        }
        return new Promise((resolve, reject) => {
            const entry = { match, resolve };
            this.waiters.push(entry);
            setTimeout(() => {
                const index = this.waiters.indexOf(entry);
                if (index >= 0) {
                    this.waiters.splice(index, 1);
                    reject(new Error("timed out waiting for a matching ACP message"));
                }
            }, timeoutMs).unref();
        });
    }

    request(method: string, params: unknown): Promise<Record<string, unknown>> {
        const id = ++this.nextId;
        void this.send({ jsonrpc: "2.0", id, method, params });
        return this.waitFor((m) => m["id"] === id);
    }

    /** Fire-and-forget request whose response is not awaited (e.g. a prompt that stays in flight). */
    sendRequest(method: string, params: unknown): void {
        void this.send({ jsonrpc: "2.0", id: ++this.nextId, method, params });
    }
}

function credentialStore() {
    const values = new Map<string, { value: string; source: string }>();
    let emitUpdate: ((ref: unknown) => void) | undefined;
    const service = {
        resolve: async (ref: unknown) => {
            const entry = values.get(String(ref));
            return entry === undefined ? undefined : { value: entry.value, source: entry.source };
        },
        describe: async (ref: unknown) => {
            const entry = values.get(String(ref));
            return entry === undefined
                ? { configured: false }
                : { configured: true, source: entry.source, writable: entry.source !== "env" };
        },
        set: async (ref: unknown, value: string) => {
            values.set(String(ref), { value, source: "file" });
            emitUpdate?.(ref);
        },
        unset: async (ref: unknown) => {
            values.delete(String(ref));
            emitUpdate?.(ref);
        },
    };
    return { values, service, bindEmit: (fn: (ref: unknown) => void) => { emitUpdate = fn; } };
}

interface BootOptions {
    providers?: { id: string; name?: string }[];
    commandDescriptors?: { name: string; description: string }[];
    skills?: { name: string; description: string; invocation: { userInvocable: boolean } }[];
    env?: NodeJS.ProcessEnv;
    provider?: string;
}

async function boot(options: BootOptions = {}) {
    const ctx = new Context();
    for (const name of bridge.inject) ctx.provide(name, {});
    const creds = credentialStore();
    creds.bindEmit((ref) => ctx.emit("credentials/reference-updated", ref as never));
    const createdAgents: FakeAgent[] = [];
    const agents = {
        create: vi.fn(async (opts: { sessionId: string; meta?: { cwd?: string }; setup?: (c: unknown) => Promise<void> }) => {
            const agent = fakeAgent(String(opts.sessionId), opts.meta?.cwd ?? "/ws");
            createdAgents.push(agent);
            if (opts.setup !== undefined) await opts.setup({});
            return { agent, dispose: async () => {} };
        }),
        get: (id: string) => createdAgents.find((agent) => agent.id === id),
        resume: vi.fn(),
    };
    ctx.set("agents", agents);
    ctx.set("credentials", creds.service);
    ctx.set("llm", {
        listProviders: () => options.providers ?? [],
        listModels: async () => [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
        resolveModelInfo: async () => ({}),
    });
    ctx.set("agentDefaultModel", { currentSelection: () => ({}), saveSelection: async () => {} });
    ctx.set("sessionPersistence", {});
    ctx.set("approval", {});
    ctx.set("permissionPresets", {
        names: [],
        defaultPreset: "read-only",
        resolve: (name: string) => ({ sandbox: name, approval: "ask", name, description: "" }),
        current: () => undefined,
        apply: () => {},
    });
    ctx.set("commands", {
        list: () => options.commandDescriptors ?? [],
        execute: async () => undefined,
    });
    ctx.set("agentPresets", {
        resolve: async (id?: string) => ({ id: id ?? "default" }),
        list: async () => [],
        mount: async () => {},
    });
    ctx.set("skills", { list: async () => options.skills ?? [] });
    ctx.set("subagents", { drainContinuableDescendants: async () => {} });
    let questionProvider: { ask: (request: unknown) => Promise<unknown> } | undefined;
    ctx.set("userQuestions", { registerProvider: (provider: typeof questionProvider) => { questionProvider = provider; return () => {}; } });

    const client = new BridgeClient();
    const harness = selfHarness();
    delete harness.installModelSelection;
    await ctx.plugin(bridge, {
        stream: { readable: client["input"].readable, writable: client["output"].writable },
        harness,
        env: options.env ?? { NODE_ENV: "production" },
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
    });
    return { ctx, client, creds, agents, createdAgents, ask: (request: unknown) => questionProvider!.ask(request) };
}

function authMethodIds(result: Record<string, unknown>): string[] {
    return ((result["result"] as { authMethods?: { id: string }[] } | undefined)?.authMethods ?? []).map(
        (method) => method.id,
    );
}

const CAPS_EVERYTHING = {
    auth: { terminal: true, _meta: { gateway: true } },
    elicitation: { url: {} },
    _meta: { "terminal-auth": true },
};

describe("ACP auth methods by capability", () => {
    it("advertises api-key only to a bare client", async () => {
        const { ctx, client } = await boot({ providers: [{ id: "deepseek-official", name: "DeepSeek" }] });
        try {
            const response = await client.request("initialize", { protocolVersion: 1 });
            expect(authMethodIds(response)).toEqual(["api-key:deepseek-official"]);
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("advertises api-key per provider, terminal, browser and gateway to a full client", async () => {
        const { ctx, client } = await boot({
            providers: [
                { id: "deepseek-official", name: "DeepSeek" },
                { id: "anthropic", name: "Anthropic" },
            ],
        });
        try {
            const response = await client.request("initialize", {
                protocolVersion: 1,
                clientCapabilities: CAPS_EVERYTHING,
            });
            expect(authMethodIds(response)).toEqual([
                "api-key:deepseek-official",
                "api-key:anthropic",
                "terminal-login",
                "browser",
                "gateway",
            ]);
            const methods = (response["result"] as { authMethods: Record<string, unknown>[] }).authMethods;
            const terminal = methods.find((method) => method["id"] === "terminal-login");
            expect(terminal).toMatchObject({
                type: "terminal",
                args: ["login"],
                _meta: { "terminal-auth": { label: "dsh-acp login" } },
            });
            const caps = response["result"] as { agentCapabilities: { _meta: Record<string, unknown> } };
            expect(caps.agentCapabilities._meta["authStatus"]).toEqual({});
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("pushes the initial _auth/status_update after initialize", async () => {
        const { ctx, client } = await boot({ providers: [{ id: "deepseek-official" }] });
        try {
            const status = client.waitFor((m) => m["method"] === AUTH_STATUS_UPDATE);
            await client.request("initialize", { protocolVersion: 1 });
            expect((await status)["params"]).toMatchObject({
                authStatus: { kind: "none", label: "Not logged in", providers: [] },
            });
        } finally {
            await ctx.fiber.dispose();
        }
    });
});

describe("authenticate paths", () => {
    it("rejects session/new with -32000 carrying data.authMethods when nothing is stored", async () => {
        const { ctx, client } = await boot({ providers: [{ id: "deepseek-official" }] });
        try {
            await client.request("initialize", { protocolVersion: 1, clientCapabilities: CAPS_EVERYTHING });
            const response = await client.request("session/new", { cwd: "/ws", mcpServers: [] });
            const error = response["error"] as { code: number; data?: { authMethods?: { id: string }[] } };
            expect(error.code).toBe(-32000);
            expect(error.data?.authMethods?.map((method) => method.id)).toEqual([
                "api-key:deepseek-official",
                "terminal-login",
                "browser",
                "gateway",
            ]);
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("stores an api-key _meta credential, reports it, and lets session/new proceed", async () => {
        const { ctx, client, creds } = await boot({ providers: [{ id: "deepseek-official", name: "DeepSeek" }] });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const status = client.waitFor(
                (m) =>
                    m["method"] === AUTH_STATUS_UPDATE &&
                    (m["params"] as { authStatus: { kind: string } }).authStatus.kind === "authenticated",
            );
            const response = await client.request("authenticate", {
                methodId: "api-key:deepseek-official",
                _meta: { "api-key": { apiKey: "sk-secret" } },
            });
            expect(response["result"]).toEqual({});
            expect(creds.values.get("DEEPSEEK_API_KEY")?.value).toBe("sk-secret");
            expect((await status)["params"]).toMatchObject({
                authStatus: {
                    kind: "authenticated",
                    providers: [{ providerId: "deepseek-official", name: "DeepSeek", kind: "api_key" }],
                },
            });
            const created = await client.request("session/new", { cwd: "/ws", mcpServers: [] });
            expect((created["result"] as { sessionId?: string })?.sessionId).toBeTruthy();
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("stores gateway credentials and reports the gateway method", async () => {
        const { ctx, client, creds } = await boot({ providers: [{ id: "deepseek-official" }] });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const status = client.waitFor(
                (m) =>
                    m["method"] === AUTH_STATUS_UPDATE &&
                    JSON.stringify(m["params"]).includes('"gateway"'),
            );
            const response = await client.request("authenticate", {
                methodId: "gateway",
                _meta: {
                    gateway: {
                        baseUrl: "https://gateway.example.com/v1",
                        headers: { Authorization: "Bearer sk-gw" },
                    },
                },
            });
            expect(response["result"]).toEqual({});
            expect(creds.values.get("DEEPSEEK_API_KEY")?.value).toBe("sk-gw");
            expect(creds.values.get("DEEPSEEK_BASE_URL")?.value).toBe("https://gateway.example.com/v1");
            expect((await status)["params"]).toMatchObject({
                authStatus: { providers: [{ providerId: "deepseek-official", kind: "gateway" }] },
            });
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("rejects a gateway authenticate missing its secret or base URL with data.authMethods", async () => {
        const { ctx, client } = await boot();
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const missingKey = await client.request("authenticate", {
                methodId: "gateway",
                _meta: { gateway: { baseUrl: "https://gateway.example.com/v1" } },
            });
            expect((missingKey["error"] as { code: number }).code).toBe(-32000);
            const missingUrl = await client.request("authenticate", {
                methodId: "api-key",
                _meta: { gateway: { headers: { Authorization: "Bearer sk-gw" } } },
            });
            expect((missingUrl["error"] as { code: number }).code).toBe(-32000);
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("succeeds without _meta when a credential is already present", async () => {
        const { ctx, client, creds } = await boot();
        creds.values.set("DEEPSEEK_API_KEY", { value: "sk-env", source: "env" });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const response = await client.request("authenticate", { methodId: "api-key" });
            expect(response["result"]).toEqual({});
            expect(creds.values.get("DEEPSEEK_API_KEY")?.value).toBe("sk-env");
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("rejects an api-key authenticate without _meta and without elicitation support", async () => {
        const { ctx, client } = await boot();
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const response = await client.request("authenticate", { methodId: "api-key" });
            const error = response["error"] as { code: number; data?: { authMethods?: unknown[] } };
            expect(error.code).toBe(-32000);
            expect(error.data?.authMethods).toBeInstanceOf(Array);
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("tells a client sending a terminal method that login runs out of band", async () => {
        const { ctx, client } = await boot();
        try {
            await client.request("initialize", {
                protocolVersion: 1,
                clientCapabilities: { auth: { terminal: true } },
            });
            const response = await client.request("authenticate", { methodId: "terminal-login" });
            const error = response["error"] as { code: number; message?: string };
            expect(error.code).toBe(-32000);
            expect(error.message).toMatch(/out of band|dsh-acp login/);
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("still reports out-of-band for a terminal method when a credential is already present", async () => {
        const { ctx, client, creds } = await boot();
        creds.values.set("DEEPSEEK_API_KEY", { value: "sk-env", source: "env" });
        try {
            await client.request("initialize", {
                protocolVersion: 1,
                clientCapabilities: { auth: { terminal: true } },
            });
            const response = await client.request("authenticate", { methodId: "terminal-login" });
            const error = response["error"] as { code: number; message?: string };
            expect(error.code).toBe(-32000);
            expect(error.message).toMatch(/out of band|dsh-acp login/);
            const data = (error as { data?: { authMethods?: unknown[] } }).data;
            expect(data?.authMethods).toBeInstanceOf(Array);
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("runs the browser login through url elicitation and saves the page submission", async () => {
        const { ctx, client, creds } = await boot();
        try {
            client.onClientRequest = (message) => {
                const params = message["params"] as { url: string; mode: string; requestId: number };
                expect(params.mode).toBe("url");
                void client.respond(message["id"], { action: "accept" });
                void fetch(params.url, {
                    method: "POST",
                    body: new URLSearchParams({ "api-key": "sk-browser" }),
                });
            };
            await client.request("initialize", {
                protocolVersion: 1,
                clientCapabilities: { elicitation: { url: {} } },
            });
            const status = client.waitFor(
                (m) =>
                    m["method"] === AUTH_STATUS_UPDATE &&
                    (m["params"] as { authStatus: { kind: string } }).authStatus.kind === "authenticated",
            );
            const response = await client.request("authenticate", { methodId: "browser" });
            expect(response["result"]).toEqual({});
            expect(creds.values.get("DEEPSEEK_API_KEY")?.value).toBe("sk-browser");
            await status;
            const completed = await client.waitFor((m) => m["method"] === "elicitation/complete");
            expect(completed["params"]).toMatchObject({ elicitationId: expect.stringContaining("dsh-acp-auth-") });
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("fails browser login with a clear error when the client declines the elicitation", async () => {
        const { ctx, client } = await boot();
        try {
            client.onClientRequest = (message) => {
                void client.respond(message["id"], { action: "decline" });
            };
            await client.request("initialize", {
                protocolVersion: 1,
                clientCapabilities: { elicitation: { url: {} } },
            });
            const response = await client.request("authenticate", { methodId: "browser" });
            const error = response["error"] as { code: number; message?: string; data?: { authMethods?: unknown[] } };
            expect(error.code).toBe(-32000);
            expect(error.message).toMatch(/cancelled/);
            expect(error.data?.authMethods).toBeInstanceOf(Array);
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("passes an elicitation transport failure through as the client's error", async () => {
        const { ctx, client } = await boot();
        try {
            client.onClientRequest = (message) => {
                void client.respondError(message["id"], -32601, "Method not found");
            };
            await client.request("initialize", {
                protocolVersion: 1,
                clientCapabilities: { elicitation: { url: {} } },
            });
            const response = await client.request("authenticate", { methodId: "browser" });
            expect((response["error"] as { code: number }).code).toBe(-32601);
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("fails browser login with an actionable error when saving the key fails", async () => {
        const { ctx, client, creds } = await boot();
        try {
            creds.service.set = async () => {
                throw new Error("store is read-only");
            };
            client.onClientRequest = (message) => {
                const params = message["params"] as { url: string };
                void client.respond(message["id"], { action: "accept" });
                void fetch(params.url, {
                    method: "POST",
                    body: new URLSearchParams({ "api-key": "sk-browser" }),
                });
            };
            await client.request("initialize", {
                protocolVersion: 1,
                clientCapabilities: { elicitation: { url: {} } },
            });
            const response = await client.request("authenticate", { methodId: "api-key" });
            const error = response["error"] as { code: number; message?: string };
            expect(error.code).toBe(-32000);
            expect(error.message).toMatch(/did not complete.*read-only/s);
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("rejects browser authenticate without url elicitation support", async () => {
        const { ctx, client } = await boot();
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const response = await client.request("authenticate", { methodId: "browser" });
            const error = response["error"] as { code: number; message?: string };
            expect(error.code).toBe(-32000);
            expect(error.message).toMatch(/URL elicitation/);
        } finally {
            await ctx.fiber.dispose();
        }
    });
});

describe("scoped logout and switching", () => {
    it("clears only the active provider's credential and reports the change", async () => {
        const { ctx, client, creds } = await boot({
            providers: [
                { id: "deepseek-official", name: "DeepSeek" },
                { id: "anthropic", name: "Anthropic" },
            ],
        });
        creds.values.set("DEEPSEEK_API_KEY", { value: "sk-deep", source: "file" });
        creds.values.set("ANTHROPIC_API_KEY", { value: "sk-ant", source: "file" });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const status = client.waitFor(
                (m) =>
                    m["method"] === AUTH_STATUS_UPDATE &&
                    !JSON.stringify(m["params"]).includes("deepseek-official") &&
                    JSON.stringify(m["params"]).includes("authenticated"),
            );
            const response = await client.request("logout", {});
            expect(response["result"]).toEqual({});
            expect(creds.values.has("DEEPSEEK_API_KEY")).toBe(false);
            expect(creds.values.get("ANTHROPIC_API_KEY")?.value).toBe("sk-ant");
            await status;
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("clears the provider named in logout _meta.provider", async () => {
        const { ctx, client, creds } = await boot({
            providers: [
                { id: "deepseek-official", name: "DeepSeek" },
                { id: "anthropic", name: "Anthropic" },
            ],
        });
        creds.values.set("DEEPSEEK_API_KEY", { value: "sk-deep", source: "file" });
        creds.values.set("ANTHROPIC_API_KEY", { value: "sk-ant", source: "file" });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const response = await client.request("logout", { _meta: { provider: "anthropic" } });
            expect(response["result"]).toEqual({});
            expect(creds.values.has("ANTHROPIC_API_KEY")).toBe(false);
            expect(creds.values.get("DEEPSEEK_API_KEY")?.value).toBe("sk-deep");
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("ignores non-string and empty _meta.provider values", async () => {
        const { ctx, client, creds } = await boot();
        creds.values.set("DEEPSEEK_API_KEY", { value: "sk-deep", source: "file" });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            await client.request("logout", { _meta: { provider: "  " } });
            expect(creds.values.has("DEEPSEEK_API_KEY")).toBe(false);
        } finally {
            await ctx.fiber.dispose();
        }
    });
});

describe("native auth commands over ACP", () => {
    it("answers typed /login and /logout with a plain notice + end_turn, never reaching the model or credentials", async () => {
        const { ctx, client, creds, createdAgents } = await boot();
        creds.values.set("DEEPSEEK_API_KEY", { value: "sk-deep", source: "file" });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const created = await client.request("session/new", { cwd: "/ws", mcpServers: [] });
            const sessionId = (created["result"] as { sessionId: string }).sessionId;
            const cases: [string, RegExp][] = [
                ["/login", /\/login isn't available.*sign-in/i],
                ["/login with args", /\/login isn't available.*sign-in/i],
                ["/logout", /\/logout isn't available.*sign-out/i],
            ];
            for (const [command, notice] of cases) {
                const response = await client.request("session/prompt", {
                    sessionId,
                    prompt: [{ type: "text", text: command }],
                });
                expect(response["error"]).toBeUndefined();
                expect(response["result"]).toEqual({ stopReason: "end_turn" });
                const chunk = await client.waitFor(
                    (m) =>
                        m["method"] === "session/update" &&
                        JSON.stringify(m["params"]).includes("agent_message_chunk") &&
                        notice.test(JSON.stringify(m["params"])),
                );
                expect(chunk).toBeDefined();
            }
            const agent = createdAgents[0];
            expect(agent?.followup).not.toHaveBeenCalled();
            expect(agent?.steer).not.toHaveBeenCalled();
            expect(creds.values.get("DEEPSEEK_API_KEY")?.value).toBe("sk-deep");
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("answers /login typed during a running turn with the notice, never steering it in", async () => {
        const { ctx, client, creds, createdAgents } = await boot();
        creds.values.set("DEEPSEEK_API_KEY", { value: "sk-deep", source: "file" });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const created = await client.request("session/new", { cwd: "/ws", mcpServers: [] });
            const sessionId = (created["result"] as { sessionId: string }).sessionId;
            // First prompt stays in flight: the agent never reaches idle.
            client.sendRequest("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: "long turn" }],
            });
            await client.waitFor(() => createdAgents[0]?.followup.mock.calls.length === 1);
            const response = await client.request("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: "/login" }],
            });
            expect(response["error"]).toBeUndefined();
            expect(response["result"]).toEqual({ stopReason: "end_turn" });
            expect(createdAgents[0]?.steer).not.toHaveBeenCalled();
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("never advertises login/logout even when the composition registers them", async () => {
        const { ctx, client, creds } = await boot({
            commandDescriptors: [
                { name: "login", description: "native login" },
                { name: "logout", description: "native logout" },
                { name: "compact", description: "compact context" },
            ],
            skills: [
                { name: "login", description: "login skill", invocation: { userInvocable: true } },
                { name: "internal", description: "internal skill", invocation: { userInvocable: false } },
                { name: "docs", description: "docs skill", invocation: { userInvocable: true } },
            ],
        });
        creds.values.set("DEEPSEEK_API_KEY", { value: "sk-deep", source: "file" });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const commands = client.waitFor(
                (m) =>
                    m["method"] === "session/update" &&
                    (m["params"] as { update?: { sessionUpdate?: string } }).update?.sessionUpdate ===
                        "available_commands_update",
            );
            await client.request("session/new", { cwd: "/ws", mcpServers: [] });
            const update = ((await commands)["params"] as { update: { availableCommands: { name: string }[] } })
                .update;
            const names = update.availableCommands.map((command) => command.name);
            expect(names).toContain("status");
            expect(names).toContain("model");
            expect(names).toContain("compact");
            expect(names).toContain("docs");
            expect(names).not.toContain("login");
            expect(names).not.toContain("logout");
        } finally {
            await ctx.fiber.dispose();
        }
    });
});

describe("_auth/status_update", () => {
    it("republishes when the credential store changes under the connection", async () => {
        const { ctx, client, creds } = await boot({ providers: [{ id: "deepseek-official" }] });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            const status = client.waitFor(
                (m) =>
                    m["method"] === AUTH_STATUS_UPDATE &&
                    (m["params"] as { authStatus: { kind: string } }).authStatus.kind === "authenticated",
            );
            await creds.service.set(credentialRef("DEEPSEEK_API_KEY"), "sk-external");
            expect((await status)["params"]).toMatchObject({
                authStatus: { providers: [{ providerId: "deepseek-official", kind: "api_key" }] },
            });
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("survives a describe failure and reports the remaining providers", async () => {
        const { ctx, client, creds } = await boot({
            providers: [
                { id: "deepseek-official", name: "DeepSeek" },
                { id: "anthropic", name: "Anthropic" },
            ],
        });
        creds.values.set("ANTHROPIC_API_KEY", { value: "sk-ant", source: "file" });
        const originalDescribe = creds.service.describe;
        creds.service.describe = async (ref: unknown) => {
            if (String(ref) === "DEEPSEEK_API_KEY") throw new Error("describe exploded");
            return originalDescribe(ref);
        };
        try {
            const status = client.waitFor(
                (m) =>
                    m["method"] === AUTH_STATUS_UPDATE &&
                    (m["params"] as { authStatus: { kind: string } }).authStatus.kind === "authenticated",
            );
            await client.request("initialize", { protocolVersion: 1 });
            expect((await status)["params"]).toMatchObject({
                authStatus: { providers: [{ providerId: "anthropic", name: "Anthropic", kind: "api_key" }] },
            });
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("reports lazily discovered routes before initialize, with the provider id as the label", async () => {
        const { ctx, client, creds } = await boot({ providers: [{ id: "deepseek-official" }] });
        creds.values.set("DEEPSEEK_API_KEY", { value: "sk-deep", source: "file" });
        try {
            const status = client.waitFor(
                (m) =>
                    m["method"] === AUTH_STATUS_UPDATE &&
                    JSON.stringify(m["params"]).includes("deepseek-official · DEEPSEEK_API_KEY"),
            );
            ctx.emit("credentials/reference-updated", credentialRef("DEEPSEEK_API_KEY") as never);
            expect((await status)["params"]).toMatchObject({
                authStatus: { providers: [{ providerId: "deepseek-official", kind: "api_key" }] },
            });
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("counts several configured providers and tolerates a base-url describe failure", async () => {
        const { ctx, client, creds } = await boot({
            providers: [
                { id: "deepseek-official", name: "DeepSeek" },
                { id: "anthropic", name: "Anthropic" },
            ],
        });
        creds.values.set("DEEPSEEK_API_KEY", { value: "sk-deep", source: "file" });
        creds.values.set("ANTHROPIC_API_KEY", { value: "sk-ant", source: "file" });
        const originalDescribe = creds.service.describe;
        creds.service.describe = async (ref: unknown) => {
            if (String(ref) === "ANTHROPIC_BASE_URL") throw new Error("base-url exploded");
            return originalDescribe(ref);
        };
        try {
            const status = client.waitFor(
                (m) =>
                    m["method"] === AUTH_STATUS_UPDATE &&
                    JSON.stringify(m["params"]).includes("2 providers"),
            );
            await client.request("initialize", { protocolVersion: 1 });
            expect((await status)["params"]).toMatchObject({
                authStatus: {
                    label: "2 providers",
                    providers: [
                        { providerId: "anthropic", name: "Anthropic", kind: "api_key" },
                        { providerId: "deepseek-official", name: "DeepSeek", kind: "api_key" },
                    ],
                },
            });
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("survives a status computation failure inside the credential-update listener", async () => {
        // The fallback route carries whatever the config gave it; a malformed
        // provider id breaks computeAuthStatus and lands in the listener's
        // defensive catch instead of leaking an unhandled rejection.
        const { ctx, client } = await boot({ provider: 123 as never });
        try {
            ctx.emit("credentials/reference-updated", credentialRef("DEEPSEEK_API_KEY") as never);
            const response = await client.request("initialize", { protocolVersion: 1 });
            expect(response["result"]).toBeDefined();
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("does not re-push an unchanged status", async () => {
        const { ctx, client } = await boot({ providers: [{ id: "deepseek-official" }] });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            await client.waitFor((m) => m["method"] === AUTH_STATUS_UPDATE);
            ctx.emit("credentials/reference-updated", credentialRef("DEEPSEEK_API_KEY") as never);
            await new Promise((resolve) => setTimeout(resolve, 50));
            const extras = client["buffered"].filter((m) => m["method"] === AUTH_STATUS_UPDATE);
            expect(extras).toHaveLength(0);
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("swallows extNotification failures inside publishAuthStatus", async () => {
        const spy = vi
            .spyOn(AgentContext.prototype, "notify")
            .mockRejectedValue(new Error("client gone"));
        const { ctx, client, creds } = await boot({ providers: [{ id: "deepseek-official" }] });
        try {
            await client.request("initialize", { protocolVersion: 1 });
            ctx.emit("credentials/reference-updated", credentialRef("DEEPSEEK_API_KEY") as never);
            await creds.service.set(credentialRef("DEEPSEEK_API_KEY"), "sk-external");
            const response = await client.request("authenticate", {
                methodId: "api-key",
                _meta: { "api-key": { apiKey: "sk-secret" } },
            });
            expect(response["result"]).toEqual({});
        } finally {
            spy.mockRestore();
            await ctx.fiber.dispose();
        }
    });
});


// RFD contract tests exercise the bridge on its real JSON-RPC stream. DSH
// lifecycle/interaction producers are controlled because no model is needed.
describe("opt-in subagent sessions", () => {
    async function setup(subagents: unknown) {
        const env = await boot({ providers: [{ id: "deepseek" }] });
        await env.client.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { ...(subagents !== undefined ? { subagents } : {}), elicitation: { form: {} } },
        });
        await env.client.request("authenticate", {
            methodId: "api-key:deepseek", _meta: { "api-key": { apiKey: "test-key" } },
        });
        const response = await env.client.request("session/new", { cwd: "/ws", mcpServers: [] });
        expect(response["error"]).toBeUndefined();
        const id = (response["result"] as { sessionId: string }).sessionId;
        const parent = env.createdAgents[0]!;
        const { agent: child } = await env.agents.create({ sessionId: "child", meta: { cwd: "/child" } });
        const emit = (agent: FakeAgent, type: string, data: unknown) => (agent.ctx.emit as (type: string, data: unknown) => void)(type, data);
        const start = (agent = parent, childId = "child", runId = "r1") => emit(agent, "subagent/start", {
            id: childId, runId, provider: "local", local: true,
        });
        const end = (stopReason = "completed", runId = "r1", childId = "child", agent = parent) => emit(agent, "subagent/end", {
            id: childId, runId, provider: "local", local: true, stopReason,
            lastAssistantMessage: [{ type: "text", text: "FINAL" }],
        });
        const flush = async () => { await env.client.request("session/list", {}); };
        const updates = () => env.client.notifications.filter(n => n["method"] === "session/update")
            .map(n => n["params"] as { sessionId: string; update: Record<string, unknown> });
        return { ...env, id, parent, child, start, end, flush, updates };
    }

    it("announces before automatically routing child output and keeps reusable identities", async () => {
        const e = await setup({});
        try {
            e.start();
            e.ctx.emit("session/event", { header: { id: "child" } } as never, {
                type: "assistant/message", data: { message: { content: [{ type: "text", text: "child answer" }] } },
            } as never);
            e.end();
            e.start(e.parent, "child", "r2");
            e.end("aborted", "r2");
            await e.flush();
            const updates = e.updates();
            const associations = updates.filter(n => n.update["sessionUpdate"] === "subagent_update");
            expect(associations).toEqual([
                { sessionId: e.id, update: { sessionUpdate: "subagent_update", sessionId: "child", state: { state: "running" } } },
                { sessionId: e.id, update: { sessionUpdate: "subagent_update", sessionId: "child", state: { state: "idle", stopReason: "end_turn" } } },
                { sessionId: e.id, update: { sessionUpdate: "subagent_update", sessionId: "child", state: { state: "running" } } },
                { sessionId: e.id, update: { sessionUpdate: "subagent_update", sessionId: "child", state: { state: "idle", stopReason: "cancelled" } } },
            ]);
            const output = updates.findIndex(n => n.sessionId === "child" && n.update["sessionUpdate"] === "agent_message_chunk");
            expect(output).toBeGreaterThan(updates.indexOf(associations[0]!));
            expect(updates[output]?.update["content"]).toEqual({ type: "text", text: "child answer" });
        } finally { await e.ctx.fiber.dispose(); }
    });

    it("uses immediate parents, not the root, and retains routing after an activation ends", async () => {
        const e = await setup({});
        try {
            const { agent: grandchild } = await e.agents.create({ sessionId: "grandchild" });
            e.start();
            e.end();
            e.start(e.child, "grandchild", "r3");
            e.end("error", "r3", "grandchild", e.child);
            await e.flush();
            expect(e.updates()).toContainEqual({ sessionId: "child", update: {
                sessionUpdate: "subagent_update", sessionId: grandchild.id, state: { state: "running" },
            } });
            expect(e.updates()).toContainEqual({ sessionId: "child", update: {
                sessionUpdate: "subagent_update", sessionId: grandchild.id, state: { state: "idle", stopReason: "error" },
            } });
        } finally { await e.ctx.fiber.dispose(); }
    });

    it("preserves final output as independently identified, linked child/parent message views", async () => {
        const e = await setup({});
        try {
            e.start();
            e.ctx.emit("session/event", e.parent.session as never, { type: "user/message", data: {
                id: "delivery-1", source: { kind: "subagent-settled", senderSessionId: "child" },
                content: [{ type: "text", text: "FINAL" }],
            } } as never);
            e.end(); await e.flush();
            const messages = e.updates().filter(n => n.update["sessionUpdate"] === "session_message");
            expect(new Set(messages.map(n => `${n.sessionId}:${n.update["messageId"]}`)).size).toBe(2);
            const outgoing = messages.find(n => n.sessionId === "child")!;
            const incomingViews = messages.filter(n => n.sessionId === e.id);
            const incoming = { ...incomingViews[0]!, update: Object.assign({}, ...incomingViews.map(n => n.update)) };
            expect(outgoing.update).toMatchObject({ senderSessionId: "child", recipientSessionId: e.id,
                recipientMessageId: incoming.update["messageId"], content: [{ type: "text", text: "FINAL" }] });
            expect(incoming.update).toMatchObject({ senderSessionId: "child", recipientSessionId: e.id,
                senderMessageId: outgoing.update["messageId"], content: [{ type: "text", text: "FINAL" }] });
            expect(outgoing.update["messageId"]).not.toBe(incoming.update["messageId"]);
        } finally { await e.ctx.fiber.dispose(); }
    });

    it.each([undefined, null])("keeps legacy metadata without opt-in (%s)", async capability => {
        const e = await setup(capability);
        try {
            e.start(); e.end(); await e.flush();
            expect(e.updates().some(n => n.update["sessionUpdate"] === "subagent_update")).toBe(false);
            expect(e.updates()).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: e.id,
                update: expect.objectContaining({ _meta: expect.objectContaining({ dsh: expect.objectContaining({ event: "subagent/lifecycle" }) }) }),
            })]));
        } finally { await e.ctx.fiber.dispose(); }
    });

    it("links an observed foreground tool result to its child's final result without truncation", async () => {
        const e = await setup({});
        try {
            e.start(); e.end();
            e.ctx.emit("tools/result", { agent: e.parent, callId: "delegate-1" } as never, {
                isError: false, value: { kind: "foreground", runId: "child", output: [{ type: "text", text: "x".repeat(24000) }] },
            } as never);
            await e.flush();
            const messages = e.updates().filter(n => n.update["sessionUpdate"] === "session_message");
            const incoming = messages.find(n => n.sessionId === e.id);
            expect(incoming).toBeDefined();
            expect(incoming!.update).toMatchObject({ senderSessionId: "child", recipientSessionId: e.id,
                senderMessageId: "dsh:r1:out", content: [{ type: "text", text: "x".repeat(24000) }] });
            expect(messages).toContainEqual({ sessionId: "child", update: {
                sessionUpdate: "session_message", messageId: "dsh:r1:out", recipientMessageId: incoming!.update["messageId"],
            } });
        } finally { await e.ctx.fiber.dispose(); }
    });

    it("routes thoughts, tools, plans, usage and live assistant frames to the child", async () => {
        const e = await setup({});
        try {
            e.start();
            const event = (type: string, data: unknown) => e.ctx.emit("session/event", { header: { id: "child" } } as never, { type, data } as never);
            event("assistant/chunk", { turn: 1, step: 0, chunk: { type: "reasoning-delta", text: "Thinking" } });
            event("tool/call", { turn: 1, step: 0, callId: "tool-child", name: "bash", arguments: '{"command":"pwd"}' });
            event("todo/write", { todos: [{ content: "Investigate", status: "in_progress" }] });
            event("request/context", { contextWindow: 1000 });
            event("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "answer" }] }, usage: { inputTokens: 100, outputTokens: 20 } });
            e.ctx.emit("agent/assistant-stream", { agent: e.child, frame: { type: "start", attemptId: "a2", turn: 2, step: 0 } } as never);
            e.ctx.emit("agent/assistant-stream", { agent: e.child, frame: { type: "chunk", attemptId: "a2", chunk: { type: "text-delta", index: 0, text: "LIVE" } } } as never);
            await e.flush();
            const updates = e.updates();
            for (const kind of ["agent_thought_chunk", "tool_call", "plan", "usage_update", "agent_message_chunk"]) {
                expect(updates.some(n => n.sessionId === "child" && n.update["sessionUpdate"] === kind)).toBe(true);
                expect(updates.some(n => n.sessionId === e.id && n.update["sessionUpdate"] === kind)).toBe(false);
            }
        } finally { await e.ctx.fiber.dispose(); }
    });

    it("does not invent a parent receipt merely because a child completed", async () => {
        const e = await setup({});
        try {
            e.start(); e.end(); await e.flush();
            const incoming = e.updates().filter(n => n.sessionId === e.id && n.update["sessionUpdate"] === "session_message");
            expect(incoming).toEqual([]);
        } finally { await e.ctx.fiber.dispose(); }
    });

    it("reports repeated work and late final chunks without requiring a fresh activation", async () => {
        const e = await setup({});
        try {
            e.start(); e.end();
            e.ctx.emit("agent/status", { agent: e.child, status: "running" } as never);
            e.ctx.emit("session/event", { header: { id: "child" } } as never, {
                type: "turn/end", data: { turn: "t2", reason: { kind: "max-tokens" } },
            } as never);
            e.ctx.emit("agent/status", { agent: e.child, status: "idle" } as never);
            await e.flush();
            const states = e.updates().filter(n => n.update["sessionUpdate"] === "subagent_update").map(n => n.update["state"]);
            expect(states.slice(-2)).toEqual([{ state: "running" }, { state: "idle", stopReason: "max_tokens" }]);
        } finally { await e.ctx.fiber.dispose(); }
    });

    it("routes child permissions and elicitation to the child after announcement", async () => {
        const e = await setup({});
        try {
            e.start();
            const requests: Record<string, unknown>[] = [];
            e.client.onClientRequest = message => {
                requests.push(message);
                void e.client.respond(message["id"], message["method"] === "session/request_permission"
                    ? { outcome: { outcome: "selected", optionId: "allow-once" } }
                    : { action: "accept", content: { question_0: "option_0" } });
            };
            const decision = await e.ctx.waterfall("approval/request", { agent: e.child, callId: "call-1" } as never,
                (() => "fallback") as never);
            expect(decision).toBe("allowed-once");
            const answer = await e.ask({ agent: e.child, questions: [{ id: "q", question: "Continue?", options: [{ label: "yes" }] }] });
            expect(answer).toBeDefined();
            expect(e.parent.cancel).not.toHaveBeenCalled();
            expect(requests.map(r => (r["params"] as { sessionId: string }).sessionId)).toEqual(["child", "child"]);
            expect(e.updates().find(n => n.update["sessionUpdate"] === "subagent_update")).toMatchObject({ sessionId: e.id, update: { sessionUpdate: "subagent_update", sessionId: "child" } });
        } finally { await e.ctx.fiber.dispose(); }
    });
});
