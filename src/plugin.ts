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
        } catch (error) {
            // A resolved Host package without this export is authoritative.
            if ((error as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return specifier;
            // Try the next resolution anchor.
        }
    }
    return specifier;
}

type PresetRoot = { path: string; trust: "system" };

/**
 * Where the four shipped presets live changed with the dsh generation:
 *
 * - dsh 0.1.1 ships them inside the meta package at
 *   `@deepseek-ai/dsh/config/agent-presets`;
 * - dsh 0.1.2 ships them inside `@deepseek-ai/dsh-agent-presets/presets` and
 *   prepends that root itself via its `includeShippedRoot` default, so the
 *   mount must pass no explicit roots at all.
 *
 * Returns the explicit system root for the legacy layout, an empty list when
 * the resolved roster package self-ships its presets, and throws only when
 * neither layout can be resolved (the mount would otherwise silently serve an
 * empty roster).
 */
function shippedPresetRoots(ctx: Context): PresetRoot[] {
    const anchors = [ctx.baseUrl, import.meta.url].filter((value): value is string => typeof value === "string");
    for (const anchor of anchors) {
        try {
            const manifest = createRequire(anchor).resolve("@deepseek-ai/dsh/package.json");
            const root = join(dirname(manifest), "config", "agent-presets");
            if (existsSync(root)) return [{ path: root, trust: "system" }];
        } catch {
            // Try the next resolution anchor.
        }
    }
    for (const anchor of anchors) {
        try {
            const manifest = createRequire(anchor).resolve("@deepseek-ai/dsh-agent-presets/package.json");
            if (existsSync(join(dirname(manifest), "presets"))) return [];
        } catch {
            // Try the next resolution anchor.
        }
    }
    throw new Error(
        "dsh-acp-plugin: cannot resolve the dsh shipped agent presets (looked for @deepseek-ai/dsh/config/agent-presets and a self-shipping @deepseek-ai/dsh-agent-presets)",
    );
}

async function mountService(
    ctx: Context,
    service: string,
    specifier: string,
    config?: unknown | (() => unknown),
): Promise<void> {
    if (ctx.get(service) !== undefined) return;
    // A config factory defers resolution to the mount that actually needs it:
    // a composition that already provides the service never pays for (or can
    // fail on) the fallback's preset-root discovery.
    const resolved = typeof config === "function" ? config() : config;
    const exports = await ctx.loader.import(resolvedHostModule(ctx, specifier));
    const plugin = ctx.loader.unwrapExports(exports);
    await ctx.plugin(plugin, resolved);
    if (ctx.get(service) === undefined) {
        throw new Error(`dsh-acp-plugin: ${specifier} did not provide ${service}`);
    }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
    if (ctx.get("acpServer") !== undefined) return;
    await mountService(ctx, "agentPresets", "@deepseek-ai/dsh-agent-presets", () => {
        const roots = shippedPresetRoots(ctx);
        return {
            default: "standard",
            // dsh 0.1.2's roster self-ships its presets (includeShippedRoot);
            // passing the legacy root there would duplicate the roster.
            ...(roots.length > 0 ? { roots } : {}),
        };
    });
    await mountService(ctx, "dynamicCordisRunner", "@deepseek-ai/dsh-cordis-host-runner");
    // Newer shipped presets require this Host settings owner; older hosts
    // do not export it and keep their existing delegation behavior.
    const modelSettings = "@deepseek-ai/dsh-tool-subagent/model-selection-settings";
    if (ctx.get("subagentModelSelection") === undefined && resolvedHostModule(ctx, modelSettings) !== modelSettings) {
        await mountService(ctx, "subagentModelSelection", modelSettings);
    }
    await ctx.plugin(server, config);
    if (ctx.get("acpServer") === undefined) {
        throw new Error("dsh-acp-plugin: ACP server did not activate");
    }
}
