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
    const anchors = [ctx.baseUrl ?? import.meta.url];
    for (const anchor of anchors) {
        try {
            return pathToFileURL(createRequire(anchor).resolve(specifier)).href;
        } catch (error) {
            // A resolved Host package without this export is authoritative.
            if ((error as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return specifier;
            // The selected Host is authoritative; do not mix its packages
            // with this adapter's development dependency tree.
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
    const anchors = [ctx.baseUrl ?? import.meta.url];
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

async function mountAgentPresets(ctx: Context): Promise<void> {
    if (ctx.get("agentPresets") !== undefined) return;
    const registry = "@deepseek-ai/dsh-agent-preset-registry";
    if (resolvedHostModule(ctx, registry) === registry) {
        await mountService(ctx, "agentPresets", "@deepseek-ai/dsh-agent-presets", () => {
            const roots = shippedPresetRoots(ctx);
            return { default: "standard", ...(roots.length > 0 ? { roots } : {}) };
        });
        return;
    }

    await mountService(ctx, "agentPresets", registry, { default: "standard" });
    const boot = await ctx.loader.import(resolvedHostModule(ctx, "@deepseek-ai/dsh-app-boot")) as {
        loadOverlayPatches(bin: string, path: string): Array<{ insert?: Array<{ name?: string; config?: unknown }> }>;
    };
    const preset = await ctx.loader.import(resolvedHostModule(ctx, "@deepseek-ai/dsh-agent-preset"));
    const plugin = ctx.loader.unwrapExports(preset);
    const webPackage = createRequire(ctx.baseUrl ?? import.meta.url).resolve("@deepseek-ai/dsh-web-app/package.json");
    for (const name of ["standard", "ptc", "minimal", "cordis"]) {
        const path = join(dirname(webPackage), "presets", `${name}.patch.yml`);
        const declaration = boot.loadOverlayPatches("dsh-acp", path)[0]?.insert?.[0];
        if (declaration?.name !== "@deepseek-ai/dsh-agent-preset") {
            throw new Error(`dsh-acp-plugin: invalid shipped ${name} preset`);
        }
        await ctx.plugin(plugin, declaration.config);
    }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
    if (ctx.get("acpServer") !== undefined) return;
    // A standalone runtime is outside the ACP package's node_modules tree.
    // Preset health checks walk ctx.baseUrl on disk, bypassing import hooks.
    const hostBase = ctx.get("dshAcpHostBaseUrl");
    const hostCtx = typeof hostBase === "string" ? ctx.extend({ baseUrl: hostBase }) : ctx;
    // Newer shipped presets require this Host settings owner; older hosts
    // do not export it and keep their existing delegation behavior.
    const modelSettings = "@deepseek-ai/dsh-tool-subagent/model-selection-settings";
    if (ctx.get("subagentModelSelection") === undefined && resolvedHostModule(hostCtx, modelSettings) !== modelSettings) {
        await mountService(hostCtx, "subagentModelSelection", modelSettings);
    }
    await mountService(hostCtx, "dynamicCordisRunner", "@deepseek-ai/dsh-cordis-host-runner");
    await mountAgentPresets(hostCtx);
    await ctx.plugin(server, config);
    if (ctx.get("acpServer") === undefined) {
        throw new Error("dsh-acp-plugin: ACP server did not activate");
    }
}
