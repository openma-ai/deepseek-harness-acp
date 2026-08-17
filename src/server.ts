/** Reusable ACP server provider: one Host composition, many owned transports. */

import type { Context } from "@deepseek-ai/cordis";
import type { Stream } from "@agentclientprotocol/sdk";

import * as bridge from "./bridge/index.ts";
import { selfHarness } from "./bridge/self-harness.ts";
import type { AcpBridgeConfig } from "./bridge/index.ts";

export const name = "acp-server";
export const inject = bridge.inject;

export type Config = Omit<AcpBridgeConfig, "harness" | "stream">;

export interface AcpServer {
    connect(stream: Stream): unknown;
}

export function apply(ctx: Context, config: Config = {}): void {
    if (ctx.get("acpServer") !== undefined) return;
    const harness = selfHarness();
    const server: AcpServer = {
        connect(stream) {
            return ctx.plugin(bridge, { ...config, stream, harness });
        },
    };
    ctx.provide("acpServer", server);
}

declare module "@deepseek-ai/cordis" {
    interface Context {
        acpServer: AcpServer;
    }
}
