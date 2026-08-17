/**
 * Bundle entry: bind the reusable ACP server to process stdio.
 *
 * This is what `@openma/deepseek-harness-acp/bridge` resolves to when the
 * package is installed into a dsh profile (`dsh plugin --profile acp add …`)
 * and named by the bundle patch. In a profile, the surrounding dsh
 * installation provides every `@deepseek-ai/*` module, so — unlike the
 * standalone CLI, which loads them from a discovered host tree — this entry
 * imports its helpers directly and hands the bridge a ready `harness` kit.
 *
 * The agent composition (spine, adapters, tools, persistence, sandbox,
 * skills, subagents, …) comes from the profile's other bundles, normally
 * `@deepseek-ai/dsh-base`. The bridge rides whatever the profile mounts: its
 * event projection is composition-agnostic by design.
 */

import type { Context } from "@deepseek-ai/cordis";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

import * as bridge from "./bridge/index.ts";
import { selfHarness } from "./bridge/self-harness.ts";
import type { AcpBridgeConfig } from "./bridge/index.ts";
import type { AcpServer } from "./server.ts";

export const name = "acp-bridge";
export const inject = bridge.inject;

/** Bundle-facing config: everything except the injected harness kit/stream. */
export type Config = Omit<AcpBridgeConfig, "harness" | "stream">;

/** Adapt client→agent / agent→client Node pipes to the ACP SDK stream. */
export function nodeAcpStream(input: Readable, output: Writable): Stream {
    return ndJsonStream(
        Writable.toWeb(output) as WritableStream<Uint8Array>,
        Readable.toWeb(input) as ReadableStream<Uint8Array>,
    );
}

export function apply(ctx: Context, config: Config = {}): unknown {
    const stream = nodeAcpStream(process.stdin, process.stdout);
    const server = ctx.get("acpServer") as AcpServer | undefined;
    if (server !== undefined) return server.connect(stream);

    // Compatibility with profiles composed from an older globally installed
    // ACP bundle patch: that patch mounts only this row. Keep the transport
    // functional instead of waiting forever for a provider row it never saw.
    return ctx.plugin(bridge, { ...config, stream, harness: selfHarness() });
}
