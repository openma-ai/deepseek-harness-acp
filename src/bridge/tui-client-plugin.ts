/** Optional Cordis Client ACP extension plane as an ordinary child plugin. */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

import type { AcpRpc } from "./rpc.ts";
import {
    installTuiClientPlane,
    type TuiClientAdvertisement,
} from "./tui-client.ts";

export const name = "acp-tui-client-plane";
export const inject: string[] = [];

export interface Config {
    rpc: AcpRpc;
    findAgent: (agentId: string) => Agent | undefined;
    advertisement: TuiClientAdvertisement;
}

export function apply(ctx: Context, config: Config): void {
    installTuiClientPlane(ctx, config.rpc, {
        findAgent: config.findAgent,
        advertisement: config.advertisement,
    });
}
