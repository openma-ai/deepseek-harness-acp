import { describe, expect, it } from "vitest";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { AcpRpc } from "../src/bridge/rpc.ts";
import * as tuiClientPlugin from "../src/bridge/tui-client-plugin.ts";
import * as userQuestionsPlugin from "../src/bridge/user-questions-plugin.ts";

function effectCtx(services: Record<string, unknown> = {}) {
    const disposers: Array<() => unknown> = [];
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    return {
        ...services,
        get(name: string) {
            return services[name];
        },
        effect(setup: () => unknown) {
            const release = setup();
            if (typeof release === "function") disposers.push(release as () => unknown);
            return release;
        },
        on(name: string, listener: (payload: unknown) => void) {
            const current = listeners.get(name) ?? [];
            current.push(listener);
            listeners.set(name, current);
            const release = () => {
                const next = (listeners.get(name) ?? []).filter((item) => item !== listener);
                listeners.set(name, next);
            };
            disposers.push(release);
            return release;
        },
        emit(name: string, payload: unknown) {
            for (const listener of listeners.get(name) ?? []) listener(payload);
        },
        dispose() {
            for (const release of disposers.reverse()) release();
        },
    };
}

describe("bridge child plugins", () => {
    it("mounts the Cordis Client RPC plane as an effect-scoped plugin", async () => {
        expect(tuiClientPlugin.inject).toEqual([]);
        const agent = { id: "agent-1" } as Agent;
        const ctx = effectCtx({
            dynamicCordisRunner: {
                async runHostHalf() { return { ok: true }; },
                listPlugins() { return []; },
            },
        });
        const rpc = new AcpRpc();
        const outbound: unknown[] = [];
        rpc.attachWriter((value) => outbound.push(value));

        tuiClientPlugin.apply(ctx as never, {
            rpc,
            findAgent: (id) => id === "agent-1" ? agent : undefined,
            advertisement: { advertised: true },
        });
        await rpc.dispatch(1, "_dsh/cordis/plugins/list", { agentId: "agent-1" });

        expect(outbound).toContainEqual({ jsonrpc: "2.0", id: 1, result: [] });
        ctx.dispose();
        expect(rpc.has("_dsh/cordis/plugins/list")).toBe(false);
        await rpc.dispatch(2, "_dsh/cordis/plugins/list", { agentId: "agent-1" });
        expect(outbound).not.toContainEqual(expect.objectContaining({ id: 2 }));
    });

    it("mounts and retracts the ACP elicitation provider with its plugin fiber", () => {
        expect(userQuestionsPlugin.inject).toEqual(["userQuestions"]);
        let provider: unknown;
        let disposed = 0;
        const ctx = effectCtx({
            userQuestions: {
                registerProvider(next: unknown) {
                    provider = next;
                    return () => { disposed += 1; };
                },
            },
        });

        userQuestionsPlugin.apply(ctx as never, {
            formSupported: () => true,
            sessionIdForRequest: () => "s-1",
            create: async () => ({ action: "cancel" }),
        });

        expect(provider).toBeDefined();
        ctx.dispose();
        expect(disposed).toBe(1);
    });
});
