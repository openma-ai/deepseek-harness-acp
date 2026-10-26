import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";

import * as bridge from "../src/bridge/index.ts";
import { selfHarness } from "../src/bridge/self-harness.ts";
import { resolveSessionTitle } from "../src/bridge/session-title.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "/tmp/dsh-acp-session-title-workspace";

interface Outbound {
    jsonrpc: string;
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: unknown;
}

interface TitleCache {
    cachedSnapshot: ReturnType<typeof vi.fn>;
    cachedPredecessorTitle: ReturnType<typeof vi.fn>;
}

function fakeTitleCache(title: string | null | undefined, predecessorTitle?: string): TitleCache {
    return {
        cachedSnapshot: vi.fn(() => title === undefined ? undefined : { asOfSeq: 1, values: { title } }),
        cachedPredecessorTitle: vi.fn(() => predecessorTitle === undefined
            ? undefined
            : { asOfSeq: 0, values: { title: predecessorTitle } }),
    };
}

function storedEvents(logTitle?: string): Array<Record<string, unknown>> {
    return [
        {
            type: "user/message",
            seq: 0,
            data: { source: { kind: "user" }, content: [{ type: "text", text: "Remember the title." }] },
        },
        ...(logTitle === undefined
            ? []
            : [{
                type: "session/title",
                seq: 1,
                data: { title: logTitle, messageSeqs: [], source: { kind: "fallback" } },
            }]),
    ];
}

async function startBridge(options: {
    cacheTitle?: string | null;
    predecessorTitle?: string;
    logTitle?: string;
    headerCount?: number;
}): Promise<{
    request(method: string, params: Record<string, unknown>): Promise<{ response: Outbound; notifications: Outbound[] }>;
    resume: ReturnType<typeof vi.fn>;
    dispose(): Promise<void>;
}> {
    const baseHeader = {
        version: 4,
        id: SESSION_ID,
        createdAt: 1_700_000_000_000,
        cwd: WORKSPACE,
        isSeeded: false,
    };
    const headers = Array.from({ length: options.headerCount ?? 1 }, (_, index) => ({
        ...baseHeader,
        id: index === 0 ? SESSION_ID : `session-${index}`,
        createdAt: baseHeader.createdAt + index,
    }));
    const header = headers[0]!;
    const events = storedEvents(options.logTitle);
    const agent = {
        id: "title-test-agent",
        session: {
            id: SESSION_ID,
            header,
            events,
            snapshotEvents: () => events,
            append: () => undefined,
        },
        options: { model: "test-model" },
        status: "idle",
        ctx: { on: () => () => undefined },
        cancel: () => undefined,
    };
    const resume = vi.fn(async (params: { setup?: (ctx: unknown, restored: unknown) => Promise<void> }) => {
        await params.setup?.({}, agent);
        return { agent, dispose: async () => undefined };
    });
    const cache = fakeTitleCache(options.cacheTitle, options.predecessorTitle);

    const ctx = new Context();
    const services: Record<string, unknown> = {
        agents: { resume },
        credentials: { resolve: async () => "test-key" },
        llm: {
            listProviders: () => [],
            listModels: async () => [],
            resolveModelInfo: async () => ({ reasoning: { efforts: [], defaultEffort: undefined } }),
        },
        agentDefaultModel: {
            currentSelection: () => ({}),
            saveSelection: async () => undefined,
        },
        sessionPersistence: { list: async () => headers },
        approval: { setPolicy: () => undefined },
        permissionPresets: {
            names: [],
            defaultPreset: "workspace-write",
            resolve: (name: string) => ({ sandbox: name, approval: "ask", name, description: "" }),
            current: () => undefined,
            apply: () => undefined,
        },
        commands: { list: () => [], execute: async () => ({}) },
        agentPresets: {
            list: async () => [],
            resolve: async () => ({ id: "default" }),
            mount: async () => undefined,
        },
        skills: { list: async () => [] },
        subagents: {},
        userQuestions: { registerProvider: () => () => undefined },
    };
    for (const name of bridge.inject) {
        ctx.provide(name, services[name] ?? {});
    }
    // `sessionProjectionCache` is optional at runtime, so it is not in inject.
    ctx.provide("sessionProjectionCache", cache);

    const input = new TransformStream();
    const output = new TransformStream();
    await ctx.plugin(bridge, {
        stream: { readable: input.readable, writable: output.writable },
        harness: selfHarness(),
    });
    const writer = input.writable.getWriter();
    const reader = output.readable.getReader();
    let nextId = 1;

    const request = async (
        method: string,
        params: Record<string, unknown>,
    ): Promise<{ response: Outbound; notifications: Outbound[] }> => {
        const id = nextId++;
        await writer.write({ jsonrpc: "2.0", id, method, params });
        const notifications: Outbound[] = [];
        for (;;) {
            const { value, done } = await reader.read();
            if (done) throw new Error("bridge closed before replying");
            const message = value as Outbound;
            if (message.id === id && message.method === undefined) return { response: message, notifications };
            if (typeof message.method === "string") notifications.push(message);
        }
    };

    return {
        request,
        resume,
        dispose: async () => {
            await ctx.fiber.dispose();
        },
    };
}

describe("resolveSessionTitle", () => {
    it("prefers a non-empty projection-cache title over the log fold", () => {
        expect(resolveSessionTitle({ projcacheTitle: "Renamed externally", logTitle: "Generated title" }))
            .toBe("Renamed externally");
    });

    it("falls back to the log title when the cache is missing, null, or empty", () => {
        expect(resolveSessionTitle({ logTitle: "Generated title" })).toBe("Generated title");
        expect(resolveSessionTitle({ projcacheTitle: null, logTitle: "Generated title" })).toBe("Generated title");
        expect(resolveSessionTitle({ projcacheTitle: "", logTitle: "Generated title" })).toBe("Generated title");
    });

    it("omits the title when neither source has a non-empty string", () => {
        expect(resolveSessionTitle({ projcacheTitle: null, logTitle: "" })).toBeUndefined();
        expect(resolveSessionTitle({})).toBeUndefined();
        expect(resolveSessionTitle({ projcacheTitle: 7, logTitle: false })).toBeUndefined();
    });
});

describe("session title bridge paths", () => {
    it("advertises session/close", async () => {
        const started = await startBridge({ logTitle: "Generated title" });
        try {
            const { response } = await started.request("initialize", {
                protocolVersion: 1,
                clientCapabilities: {},
            });
            const capabilities = response.result?.["agentCapabilities"] as Record<string, unknown>;
            expect(capabilities["sessionCapabilities"]).toMatchObject({
                list: {},
                resume: {},
                fork: {},
                close: {},
            });
        } finally {
            await started.dispose();
        }
    });

    it("lists the cached title for rows beyond the event-fold prefix", async () => {
        const started = await startBridge({
            cacheTitle: "Renamed externally",
            logTitle: "Generated title",
            headerCount: 21,
        });
        try {
            const { response } = await started.request("session/list", { cwd: WORKSPACE });
            expect(response.error).toBeUndefined();
            const sessions = response.result?.["sessions"] as Array<Record<string, unknown>>;
            expect(sessions).toHaveLength(21);
            expect(sessions[20]?.["title"]).toBe("Renamed externally");
        } finally {
            await started.dispose();
        }
    });

    it("falls back to the predecessor title when the current cache snapshot has none", async () => {
        const started = await startBridge({
            cacheTitle: null,
            predecessorTitle: "Predecessor rename",
            logTitle: "Generated title",
        });
        try {
            const { response } = await started.request("session/list", { cwd: WORKSPACE });
            expect(response.error).toBeUndefined();
            const sessions = response.result?.["sessions"] as Array<Record<string, unknown>>;
            expect(sessions[0]?.["title"]).toBe("Predecessor rename");
        } finally {
            await started.dispose();
        }
    });

    it("loads with the projection-cache title and notifies session_info_update", async () => {
        const started = await startBridge({ cacheTitle: "Renamed externally", logTitle: "Generated title" });
        try {
            const { response, notifications } = await started.request("session/load", {
                sessionId: SESSION_ID,
                cwd: WORKSPACE,
                mcpServers: [],
            });
            expect(response.error).toBeUndefined();
            const titleUpdates = notifications
                .filter((message) => message.method === "session/update")
                .map((message) => message.params?.["update"] as Record<string, unknown> | undefined)
                .filter((update) => update?.["sessionUpdate"] === "session_info_update" && update["title"] !== undefined);
            expect(titleUpdates).toContainEqual(expect.objectContaining({ title: "Renamed externally" }));
        } finally {
            await started.dispose();
        }
    });

    it("resumes without replay and still notifies the log-folded title", async () => {
        const started = await startBridge({ logTitle: "Generated title" });
        try {
            const { response, notifications } = await started.request("session/resume", {
                sessionId: SESSION_ID,
                cwd: WORKSPACE,
                mcpServers: [],
            });
            expect(response.error).toBeUndefined();
            const titleUpdates = notifications
                .filter((message) => message.method === "session/update")
                .map((message) => message.params?.["update"] as Record<string, unknown> | undefined)
                .filter((update) => update?.["sessionUpdate"] === "session_info_update" && update["title"] !== undefined);
            expect(titleUpdates).toContainEqual(expect.objectContaining({ title: "Generated title" }));
        } finally {
            await started.dispose();
        }
    });
});
