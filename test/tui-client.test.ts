import { describe, expect, it } from "vitest";
import { AcpRpc } from "../src/bridge/rpc.ts";
import { installTuiClientPlane } from "../src/bridge/tui-client.ts";
import type { Agent } from "@deepseek-ai/dsh-agent";

function fakeCtx(services: Record<string, unknown> = {}) {
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    return {
        get(name: string) {
            return services[name];
        },
        provide() {},
        effect(fn: () => unknown) {
            return fn();
        },
        on(name: string, listener: (payload: unknown) => void) {
            const list = listeners.get(name) ?? [];
            list.push(listener);
            listeners.set(name, list);
            return () => {};
        },
        emit(name: string, payload: unknown) {
            for (const listener of listeners.get(name) ?? []) listener(payload);
        },
    };
}

describe("TUI Client ACP extras", () => {
    it("lists only the dynamic plugins owned by the requested agent", async () => {
        const listedFor: string[] = [];
        const agent = { id: "agent-1" } as Agent;
        const plugins = [{
            pluginId: "panel-1",
            currentPackageId: "pkg-1",
            packages: [{
                packageId: "pkg-1",
                name: "Status panel",
                purpose: "Show live status",
                hasHostHalf: true,
                hasClientHalf: true,
            }],
        }];
        const ctx = fakeCtx({
            dynamicCordisRunner: {
                runHostHalf() {},
                listPlugins(owner: Agent) {
                    listedFor.push(String(owner.id));
                    return plugins;
                },
            },
        });
        const rpc = new AcpRpc();
        const outbound: unknown[] = [];
        rpc.attachWriter((value) => outbound.push(value));
        installTuiClientPlane(ctx as never, rpc, {
            findAgent: (id) => (id === "agent-1" ? agent : undefined),
            advertisement: { advertised: true },
        });

        await rpc.dispatch(8, "tui/list-plugins", { agentId: "agent-1" });

        expect(listedFor).toEqual(["agent-1"]);
        expect(outbound).toContainEqual({ jsonrpc: "2.0", id: 8, result: plugins });
    });

    it("stops a dynamic plugin through the Host panel lifecycle", async () => {
        const stopped: unknown[] = [];
        const agent = { id: "agent-1" } as Agent;
        const ctx = fakeCtx({
            dynamicCordisRunner: {
                runHostHalf() {},
                stopFromPanel(owner: Agent, pluginId: string) {
                    stopped.push({ owner: owner.id, pluginId });
                    return Promise.resolve({ ok: true });
                },
            },
        });
        const rpc = new AcpRpc();
        const outbound: unknown[] = [];
        rpc.attachWriter((value) => outbound.push(value));
        installTuiClientPlane(ctx as never, rpc, {
            findAgent: (id) => (id === "agent-1" ? agent : undefined),
            advertisement: { advertised: true },
        });

        await rpc.dispatch(9, "tui/stop-plugin", {
            agentId: "agent-1",
            pluginId: "panel-1",
        });

        expect(stopped).toEqual([{ owner: "agent-1", pluginId: "panel-1" }]);
        expect(outbound).toContainEqual({
            jsonrpc: "2.0",
            id: 9,
            result: { ok: true },
        });
    });

    it("restores the backend current package instead of trusting a client package id", async () => {
        const agent = { id: "agent-1" } as Agent;
        const started: unknown[] = [];
        const ctx = fakeCtx({
            dynamicCordisRunner: {
                runHostHalf(
                    owner: Agent,
                    pluginId: string,
                    packageId: string,
                    mode: string,
                    requestId: string | null,
                    approveFutureVersions: boolean,
                ) {
                    started.push({
                        owner: owner.id,
                        pluginId,
                        packageId,
                        mode,
                        requestId,
                        approveFutureVersions,
                    });
                    return Promise.resolve({
                        ok: true,
                        pluginRunId: "run-restored",
                        startedHere: true,
                    });
                },
                listPlugins() {
                    return [{
                        pluginId: "panel-1",
                        currentPackageId: "pkg-current",
                        packages: [
                            {
                                packageId: "pkg-old",
                                name: "Old panel",
                                purpose: "old",
                                hasHostHalf: true,
                                hasClientHalf: true,
                            },
                            {
                                packageId: "pkg-current",
                                name: "Current panel",
                                purpose: "current",
                                hasHostHalf: true,
                                hasClientHalf: true,
                            },
                        ],
                    }];
                },
            },
        });
        const rpc = new AcpRpc();
        const outbound: unknown[] = [];
        rpc.attachWriter((value) => outbound.push(value));
        installTuiClientPlane(ctx as never, rpc, {
            findAgent: (id) => (id === "agent-1" ? agent : undefined),
            advertisement: { advertised: true },
        });

        await rpc.dispatch(10, "tui/start-plugin", {
            agentId: "agent-1",
            pluginId: "panel-1",
            packageId: "pkg-old",
        });

        expect(started).toEqual([{
            owner: "agent-1",
            pluginId: "panel-1",
            packageId: "pkg-current",
            mode: "run",
            requestId: null,
            approveFutureVersions: false,
        }]);
        expect(outbound).toContainEqual({
            jsonrpc: "2.0",
            method: "tui/user-run",
            params: {
                agentId: "agent-1",
                pluginId: "panel-1",
                packageId: "pkg-current",
                pluginRunId: "run-restored",
                startedHere: true,
                mode: "run",
                hasClientHalf: true,
            },
        });
        expect(outbound).toContainEqual({
            jsonrpc: "2.0",
            id: 10,
            result: {
                ok: true,
                status: "starting",
                pluginId: "panel-1",
                packageId: "pkg-current",
                pluginRunId: "run-restored",
            },
        });
    });

    it("settles a restored Client half through the direct user-run lifecycle", async () => {
        const settled: unknown[] = [];
        const agent = { id: "agent-1" } as Agent;
        const ctx = fakeCtx({
            dynamicCordisRunner: {
                runHostHalf() {},
                settleUserRun(owner: Agent, pluginId: string, resolution: unknown) {
                    settled.push({ owner: owner.id, pluginId, resolution });
                    return Promise.resolve({ ok: true });
                },
            },
        });
        const rpc = new AcpRpc();
        const outbound: unknown[] = [];
        rpc.attachWriter((value) => outbound.push(value));
        installTuiClientPlane(ctx as never, rpc, {
            findAgent: (id) => (id === "agent-1" ? agent : undefined),
            advertisement: { advertised: true },
        });

        await rpc.dispatch(11, "tui/settle-user-run", {
            agentId: "agent-1",
            pluginId: "panel-1",
            resolution: { ok: true, pluginRunId: "run-2", waitingFor: [] },
        });

        expect(settled).toEqual([{
            owner: "agent-1",
            pluginId: "panel-1",
            resolution: { ok: true, pluginRunId: "run-2", waitingFor: [] },
        }]);
        expect(outbound).toContainEqual({ jsonrpc: "2.0", id: 11, result: { ok: true } });
    });

    it("routes a package-private Client call to the active Host half", async () => {
        const invoked: unknown[] = [];
        const agent = { id: "agent-1" } as Agent;
        const ctx = fakeCtx({
            dynamicCordisRunner: {
                runHostHalf() {},
                getClientCode() {},
                resolveRequestRun() {},
                invoke(pluginId: string, pluginRunId: string, method: string, args: unknown) {
                    invoked.push({ pluginId, pluginRunId, method, args });
                    return Promise.resolve({ ok: true, value: { value: "ready" } });
                },
            },
        });
        const rpc = new AcpRpc();
        const outbound: unknown[] = [];
        rpc.attachWriter((value) => {
            outbound.push(value);
        });
        installTuiClientPlane(ctx as never, rpc, {
            findAgent: (id) => (id === "agent-1" ? agent : undefined),
            advertisement: { advertised: true },
        });

        await rpc.dispatch(7, "tui/invoke", {
            agentId: "agent-1",
            pluginId: "panel-1",
            pluginRunId: "run-1",
            method: "read-state",
            args: { key: "status" },
        });

        expect(invoked).toEqual([{
            pluginId: "panel-1",
            pluginRunId: "run-1",
            method: "read-state",
            args: { key: "status" },
        }]);
        expect(outbound).toContainEqual({
            jsonrpc: "2.0",
            id: 7,
            result: { ok: true, value: { value: "ready" } },
        });
    });

    it("mirrors a Theme inspect directory and answers queries after sync", async () => {
        const synced: unknown[] = [];
        const resolved: unknown[] = [];
        const agent = { id: "agent-1" } as Agent;
        const ctx = fakeCtx({
            cordisInspect: {
                syncClientManifest(providers: unknown[]) {
                    synced.push(providers);
                },
                resolveClientQuery(_agent: Agent, requestId: string, resolution: unknown) {
                    resolved.push({ requestId, resolution });
                    return { accepted: true };
                },
            },
        });
        const rpc = new AcpRpc();
        const outbound: unknown[] = [];
        rpc.attachWriter((value) => {
            outbound.push(value);
        });
        const advertisement = { advertised: false };
        installTuiClientPlane(ctx as never, rpc, {
            findAgent: (id) => (id === "agent-1" ? agent : undefined),
            advertisement,
        });

        expect(rpc.has("tui/inspect-sync")).toBe(true);
        await rpc.dispatch(1, "tui/inspect-sync", {
            providers: [
                {
                    id: "Theme",
                    description: "TUI tokens",
                    methods: [{ name: "listTokens", description: "list", inputSchema: {}, outputSchema: {} }],
                },
            ],
        });
        expect(synced).toHaveLength(1);
        expect(advertisement.advertised).toBe(true);
        expect(outbound).toContainEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });

        ctx.emit("cordis/inspect-query", {
            requestId: "inspect-1",
            agentId: "agent-1",
            provider: "Theme",
            method: "listTokens",
        });
        expect(outbound).toContainEqual({
            jsonrpc: "2.0",
            method: "tui/inspect-query",
            params: {
                requestId: "inspect-1",
                agentId: "agent-1",
                provider: "Theme",
                method: "listTokens",
            },
        });

        ctx.emit("cordis/request-run", {
            requestId: "approval-1",
            agentId: "agent-1",
            pluginId: "clay-1",
        });
        expect(outbound).toContainEqual({
            jsonrpc: "2.0",
            method: "tui/request-run",
            params: {
                requestId: "approval-1",
                agentId: "agent-1",
                pluginId: "clay-1",
            },
        });

        await rpc.dispatch(2, "tui/inspect-resolve", {
            agentId: "agent-1",
            requestId: "inspect-1",
            resolution: { ok: true, data: { tokens: [] } },
        });
        expect(resolved).toEqual([
            { requestId: "inspect-1", resolution: { ok: true, data: { tokens: [] } } },
        ]);
    });

    it("does not forward inspect queries until a TUI client advertised", () => {
        const ctx = fakeCtx({
            cordisInspect: {
                syncClientManifest() {},
                resolveClientQuery() {
                    return { accepted: false };
                },
            },
        });
        const rpc = new AcpRpc();
        const outbound: unknown[] = [];
        rpc.attachWriter((value) => {
            outbound.push(value);
        });
        installTuiClientPlane(ctx as never, rpc, {
            findAgent: () => undefined,
            advertisement: { advertised: false },
        });
        ctx.emit("cordis/inspect-query", { requestId: "inspect-1" });
        expect(outbound).toEqual([]);
    });
});
