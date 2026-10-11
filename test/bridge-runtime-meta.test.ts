/**
 * `_meta.dsh.runtime` in the initialize response (issue #157): clients show
 * which dsh booted. Provided on the standalone serve path; absent for
 * profile mounts. Both arms are driven in-process over a bridged stream.
 */

import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import * as bridge from "../src/bridge/index.ts";

interface Outbound {
    jsonrpc: string;
    id?: unknown;
    result?: Record<string, unknown>;
    error?: unknown;
}

async function startBridge(services: Record<string, unknown>) {
    const ctx = new Context();
    for (const name of bridge.inject) {
        if (name === "userQuestions") continue;
        ctx.provide(name, {});
    }
    ctx.provide("userQuestions", { registerProvider: () => () => {} });
    for (const [name, value] of Object.entries(services)) ctx.provide(name, value);
    const input = new TransformStream();
    const output = new TransformStream();
    await ctx.plugin(bridge, {
        stream: { readable: input.readable, writable: output.writable },
        harness: {} as bridge.BridgeHarness,
    });
    const writer = input.writable.getWriter();
    const reader = output.readable.getReader();
    return {
        ctx,
        async initialize(params: Record<string, unknown>): Promise<Outbound> {
            await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params });
            const { value } = await reader.read();
            return value as Outbound;
        },
    };
}

describe("initialize _meta.dsh.runtime", () => {
    it("projects the provided runtime identity", async () => {
        const { ctx, initialize } = await startBridge({
            dshAcpHost: { base: "/opt/dsh", version: "0.2.0-rc.2", source: "bundled standalone runtime" },
        });
        try {
            const response = await initialize({ protocolVersion: 1, clientCapabilities: {} });
            const dsh = (response.result?.["agentCapabilities"] as Record<string, unknown>)?.["_meta"] as Record<
                string,
                unknown
            >;
            expect(dsh["dsh"]).toMatchObject({
                runtime: { base: "/opt/dsh", version: "0.2.0-rc.2", source: "bundled standalone runtime" },
            });
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("omits runtime when no host identity was provided", async () => {
        const { ctx, initialize } = await startBridge({});
        try {
            const response = await initialize({ protocolVersion: 1, clientCapabilities: {} });
            const dsh = (response.result?.["agentCapabilities"] as Record<string, unknown>)?.["_meta"] as Record<
                string,
                Record<string, unknown>
            >;
            const meta = dsh["dsh"] as Record<string, unknown>;
            expect(meta["cordis"]).toBeDefined();
            expect(meta["runtime"]).toBeUndefined();
        } finally {
            await ctx.fiber.dispose();
        }
    });

    it("omits runtime for a malformed host value", async () => {
        const { ctx, initialize } = await startBridge({ dshAcpHost: { base: 7 } });
        try {
            const response = await initialize({ protocolVersion: 1, clientCapabilities: {} });
            const dsh = (response.result?.["agentCapabilities"] as Record<string, unknown>)?.["_meta"] as Record<
                string,
                Record<string, unknown>
            >;
            expect((dsh["dsh"] as Record<string, unknown>)["runtime"]).toBeUndefined();
        } finally {
            await ctx.fiber.dispose();
        }
    });
});
