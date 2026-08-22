/**
 * Embeddable ACP Host plugin.
 *
 * This is the single Cordis dependency surfaces mount. It fills the two Host
 * services that dsh-base deliberately leaves to a surface (agent presets and
 * the dynamic Cordis runner), then publishes the transport-independent ACP
 * server. Transports stay outside this plugin: the ACP profile adds its stdio
 * adapter, while the TUI surface connects a separate Client process over that
 * process's standard stdin/stdout.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Context } from "@deepseek-ai/cordis";

import * as bridge from "./bridge/index.ts";
import * as server from "./server.ts";
import type { Config } from "./server.ts";

export const name = "dsh-acp-plugin";
export const inject = [...new Set([...bridge.inject.filter((service) => service !== "agentPresets"), "loader"])];

function resolvedHostModule(ctx: Context, specifier: string): string {
    const anchors = [ctx.baseUrl, import.meta.url].filter((value): value is string => typeof value === "string");
    for (const anchor of anchors) {
        try {
            return pathToFileURL(createRequire(anchor).resolve(specifier)).href;
        } catch {
            // Try the next resolution anchor.
        }
    }
    return specifier;
}

function shippedPresetRoot(ctx: Context): string {
    const anchors = [ctx.baseUrl, import.meta.url].filter((value): value is string => typeof value === "string");
    for (const anchor of anchors) {
        try {
            const manifest = createRequire(anchor).resolve("@deepseek-ai/dsh/package.json");
            const root = join(dirname(manifest), "config", "agent-presets");
            if (existsSync(root)) return root;
        } catch {
            // Try the next resolution anchor.
        }
    }
    throw new Error("dsh-acp-plugin: cannot resolve the dsh shipped agent presets");
}

async function mountService(
    ctx: Context,
    service: string,
    specifier: string,
    config?: unknown,
): Promise<void> {
    if (ctx.get(service) !== undefined) return;
    const exports = await ctx.loader.import(resolvedHostModule(ctx, specifier));
    const plugin = ctx.loader.unwrapExports(exports);
    await ctx.plugin(plugin, config);
    if (ctx.get(service) === undefined) {
        throw new Error(`dsh-acp-plugin: ${specifier} did not provide ${service}`);
    }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
    if (ctx.get("acpServer") !== undefined) return;
    await mountService(ctx, "agentPresets", "@deepseek-ai/dsh-agent-presets", {
        default: "standard",
        roots: [{ path: shippedPresetRoot(ctx), trust: "system" }],
    });
    await mountService(ctx, "dynamicCordisRunner", "@deepseek-ai/dsh-cordis-host-runner");
    await ctx.plugin(server, config);
    if (ctx.get("acpServer") === undefined) {
        throw new Error("dsh-acp-plugin: ACP server did not activate");
    }
}
