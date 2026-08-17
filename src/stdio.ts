/** Standard ACP profile transport: bind the embedded Host plugin to stdio. */

import type { Context } from "@deepseek-ai/cordis";

import { nodeAcpStream } from "./bundle.ts";
import type { AcpServer } from "./server.ts";

export const name = "acp-stdio";
export const inject = ["acpServer"];

export function apply(ctx: Context): unknown {
    const server = ctx.get("acpServer") as AcpServer;
    return server.connect(nodeAcpStream(process.stdin, process.stdout));
}
