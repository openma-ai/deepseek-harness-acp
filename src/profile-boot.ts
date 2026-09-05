/**
 * Self-hosted acp profile boot: replicate `dsh --profile acp` in-process.
 *
 * Instead of composing a hand-rolled agent spine, this engine drives the
 * harness's own profile machinery (`@deepseek-ai/dsh-app-boot`) against a
 * discovered installation — the user's `dsh` when present, this package's
 * npm-installed peer as the fallback — so the resulting tree is the same
 * product composition `dsh --profile acp` would build:
 *
 *   - the `@deepseek-ai/dsh-base` bundle patch (the full product baseline),
 *   - this package's bundle patch (ACP bridge row, preset plane split),
 *   - the user's real `$DSH_HOME/profiles/acp` layers when that profile
 *     exists (its bundles list and cordis.patch.yml take over),
 *   - the machine-level `$DSH_HOME/cordis.patch.yml` layer,
 *   - the shipped agent-presets root injection the dsh CLI performs.
 *
 * State (settings.yaml, .credentials.yaml, sessions, presets) lives in the
 * shared `$DSH_HOME`; concurrent access is safe by the harness's own design
 * (cross-process file locks + atomic writes for the config documents,
 * append-only per-session logs for the store).
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";

import type { HarnessHost } from "./harness.ts";
import { logDebug } from "./log.ts";

/** Loader patch entries (opaque to us; owned by the harness loader). */
type PatchEntry = { id?: unknown; config?: Record<string, unknown>; [key: string]: unknown };

interface AppBoot {
    boot(
        binName: string,
        absoluteConfigPath: string,
        patches?: PatchEntry[],
        prepare?: (ctx: unknown) => Promise<void> | void,
        bareModuleBaseUrl?: string,
    ): Promise<BootedContext>;
    loadProfile(
        binName: string,
        name: string,
        installAnchor: string,
    ): { dir: string; patches: PatchEntry[]; layers: { patches: PatchEntry[] }[] };
    loadOverlayPatches(binName: string, patchPath: string): PatchEntry[];
    loadOptionalPatches(binName: string, patchPath: string): PatchEntry[] | undefined;
    composeEntries(layers: PatchEntry[][]): PatchEntry[];
    loadLayeredEnv(binName: string): unknown;
    assertEntriesLoaded(ctx: unknown, binName: string): void;
    assertEntriesActivated(ctx: unknown, binName: string): Promise<void>;
    installFailLoud(binName: string, proc: NodeJS.Process, dispose: () => Promise<void>): void;
    healProfilesModuleFallback(installAnchor: string): void;
}

export interface BootedContext {
    fiber: { dispose(): Promise<void> };
    get(name: string): unknown;
    provide(name: string, value: unknown): void;
}

const BIN = "dsh-acp";

/** This package's own root (one level above dist/). */
function ownRoot(): string {
    return dirname(createRequire(import.meta.url).resolve("../package.json"));
}

const OWN_BRIDGE_SPECIFIER = "@openma/deepseek-harness-acp/bridge";
const OWN_SERVER_SPECIFIER = "@openma/deepseek-harness-acp/server";
const OWN_PLUGIN_SPECIFIER = "@openma/deepseek-harness-acp/plugin";
const OWN_STDIO_SPECIFIER = "@openma/deepseek-harness-acp/stdio";

/** Rewrite this package's rows (incl. nested inserts) to absolute entries. */
function rewriteOwnRows(
    row: PatchEntry,
    entries: { bridge: string; server: string; plugin: string; stdio: string },
): void {
    if (row["name"] === OWN_BRIDGE_SPECIFIER) row["name"] = entries.bridge;
    if (row["name"] === OWN_SERVER_SPECIFIER) row["name"] = entries.server;
    if (row["name"] === OWN_PLUGIN_SPECIFIER) row["name"] = entries.plugin;
    if (row["name"] === OWN_STDIO_SPECIFIER) row["name"] = entries.stdio;
    const insert = row["insert"];
    if (Array.isArray(insert)) {
        for (const nested of insert) {
            if (nested !== null && typeof nested === "object") {
                rewriteOwnRows(nested as PatchEntry, entries);
            }
        }
    }
}

/** Read a bundle package's declared patch layer (its `dsh.bundle.patch`). */
function bundlePatchPath(packageJsonPath: string): string {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        name?: string;
        dsh?: { bundle?: { patch?: string } };
    };
    const declared = pkg.dsh?.bundle?.patch;
    if (declared === undefined) {
        throw new Error(`${BIN}: bundle ${pkg.name ?? packageJsonPath} declares no dsh.bundle in its package.json`);
    }
    return join(dirname(packageJsonPath), declared);
}

interface BundleManifest {
    name?: string;
    main?: string;
    dsh?: { bundle?: { patch?: string } };
}

/** Resolve a named or filesystem bundle to its package manifest. */
function resolveBundlePackageJson(specifier: string): string {
    const candidate = resolve(specifier);
    if (existsSync(candidate)) {
        return candidate.endsWith("package.json") ? candidate : join(candidate, "package.json");
    }
    const req = createRequire(join(process.cwd(), "noop.js"));
    try {
        return req.resolve(`${specifier}/package.json`);
    } catch (cause: unknown) {
        throw new Error(`${BIN}: cannot resolve bundle ${JSON.stringify(specifier)}`, { cause });
    }
}

/**
 * Make every plugin named by a bundle resolve from that bundle's own npm
 * dependency graph. The root Loader may belong to another profile, so bare
 * names cannot safely be left relative to it.
 */
function rewriteBundleRows(
    row: PatchEntry,
    packageJsonPath: string,
    manifest: BundleManifest,
): void {
    const name = row["name"];
    if (typeof name === "string" && !name.startsWith("cordis:") && !isAbsolute(name)) {
        const req = createRequire(packageJsonPath);
        try {
            row["name"] = req.resolve(name);
        } catch (cause: unknown) {
            if (name === manifest.name && manifest.main !== undefined) {
                const entry = resolve(dirname(packageJsonPath), manifest.main);
                if (existsSync(entry)) row["name"] = entry;
                else throw new Error(`${BIN}: bundle entry does not exist: ${entry}`, { cause });
            } else {
                throw new Error(
                    `${BIN}: bundle ${manifest.name ?? packageJsonPath} cannot resolve plugin ${JSON.stringify(name)}`,
                    { cause },
                );
            }
        }
    }
    const insert = row["insert"];
    if (Array.isArray(insert)) {
        for (const nested of insert) {
            if (nested !== null && typeof nested === "object") {
                rewriteBundleRows(nested as PatchEntry, packageJsonPath, manifest);
            }
        }
    }
}

/** Load one additional bundle layer and bind its plugin names to its graph. */
function loadBundleLayer(appBoot: AppBoot, specifier: string): PatchEntry[] {
    const packageJsonPath = resolveBundlePackageJson(specifier);
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as BundleManifest;
    const patches = appBoot.loadOverlayPatches(BIN, bundlePatchPath(packageJsonPath));
    for (const row of patches) rewriteBundleRows(row, packageJsonPath, manifest);
    return patches;
}

/**
 * Boot the acp profile composition against `host` and return the root
 * context. The caller owns disposal.
 */
export async function bootAcpProfile(
    host: HarnessHost,
    overrides?: {
        provider?: string;
        model?: string;
        permissionMode?: string;
        maxTokens?: number;
        /** Additional bundle layers, in the same order as profile bundles. */
        bundles?: string[];
        /** Compose without the ACP stdio server (credential tooling etc.). */
        serve?: boolean;
    },
): Promise<BootedContext> {
    const req = createRequire(join(host.base, "noop.js"));
    const dshPkgPath = req.resolve("@deepseek-ai/dsh/package.json");
    const dshDir = dirname(dshPkgPath);
    const appBoot = (await import(pathToFileURL(req.resolve("@deepseek-ai/dsh-app-boot")).href)) as AppBoot;
    const homePaths = (await import(pathToFileURL(req.resolve("@deepseek-ai/dsh-home-paths")).href)) as {
        resolveDshHome(): string;
    };
    const home = homePaths.resolveDshHome();

    // ---- Standalone layers ----------------------------------------------
    // This function is the standalone dsh-acp entrypoint. A dsh-managed
    // profile runs the embeddable plugin on the profile's existing tree and
    // never calls this function. Reusing $DSH_HOME/profiles/acp here would
    // let an arbitrarily old profile dependency graph override the current
    // standalone package (the exact failure npx clients hit after upgrading).
    // Compose the selected Host's current dsh-base + this running package,
    // then layer the shared home patch and explicit --bundle additions.
    const rootConfigPath = join(ownRoot(), "profile-root.cordis.yml");
    const bareModuleBaseUrl = pathToFileURL(dshDir + sep).href;
    // The bridge ships with THIS binary: whatever composition source names
    // it (the virtual bundle list or a real profile's), the row must load
    // the running package's entry, never an older copy installed elsewhere.
    // In a source run (tsx — this module's URL ends in .ts) prefer the live
    // sources over a possibly stale dist/ build.
    const distBridge = join(ownRoot(), "dist", "bridge.js");
    const bridgeEntry =
        import.meta.url.endsWith(".ts") || !existsSync(distBridge)
            ? join(ownRoot(), "src", "bundle.ts")
            : distBridge;
    const distServer = join(ownRoot(), "dist", "server.js");
    const serverEntry =
        import.meta.url.endsWith(".ts") || !existsSync(distServer)
            ? join(ownRoot(), "src", "server.ts")
            : distServer;
    const distPlugin = join(ownRoot(), "dist", "plugin.js");
    const pluginEntry =
        import.meta.url.endsWith(".ts") || !existsSync(distPlugin)
            ? join(ownRoot(), "src", "plugin.ts")
            : distPlugin;
    const distStdio = join(ownRoot(), "dist", "stdio.js");
    const stdioEntry =
        import.meta.url.endsWith(".ts") || !existsSync(distStdio)
            ? join(ownRoot(), "src", "stdio.ts")
            : distStdio;
    const basePatch = bundlePatchPath(req.resolve("@deepseek-ai/dsh-base/package.json"));
    const ownPatch = bundlePatchPath(join(ownRoot(), "package.json"));
    const bundlePatches: PatchEntry[] = [
        ...appBoot.loadOverlayPatches(BIN, basePatch),
        ...appBoot.loadOverlayPatches(BIN, ownPatch),
    ];
    logDebug(`profile: standalone (dsh-base + ${ownRoot()})`);
    for (const bundle of overrides?.bundles ?? []) {
        bundlePatches.push(...loadBundleLayer(appBoot, bundle));
        logDebug(`profile: added bundle ${bundle}`);
    }
    for (const row of bundlePatches) {
        rewriteOwnRows(row, {
            bridge: bridgeEntry,
            server: serverEntry,
            plugin: pluginEntry,
            stdio: stdioEntry,
        });
    }

    // ---- Home layer and CLI-equivalent overlays -------------------------
    const homePatchPath = join(home, "cordis.patch.yml");
    const homePatches = appBoot.loadOptionalPatches(BIN, homePatchPath) ?? [];
    const rows = new Map<string, PatchEntry>();
    for (const row of appBoot.composeEntries([bundlePatches, homePatches])) {
        if (typeof row.id === "string") rows.set(row.id, row);
    }
    const overlays: PatchEntry[] = [];
    // The dsh CLI injects its shipped preset root into any agent-presets row.
    const shippedPresets = join(dshDir, "config", "agent-presets") + sep;
    if (rows.has("agent-presets") && existsSync(shippedPresets)) {
        overlays.push({
            id: "agent-presets",
            config: {
                ...(rows.get("agent-presets")?.config ?? {}),
                roots: [{ path: shippedPresets, trust: "system" }],
            },
        });
    }
    // The CLI's telemetry switch, reduced to its observable effect.
    if (process.env["DSH_TELEMETRY_DISABLED"] !== undefined && rows.has("session-telemetry-otel")) {
        overlays.push({ id: "session-telemetry-otel", disabled: true });
    }

    // The CLI-argument layer: an overlay over the acp-bridge row, the same
    // id-targeted override a user patch would express.
    const transportRow = rows.get("acp-bridge");
    if (overrides?.serve === false && transportRow !== undefined) {
        // Tooling boots (login) need the composition without the stdio server.
        overlays.push({ id: "acp-bridge", disabled: true });
    }
    // Current profiles put runtime configuration on the Host plugin; older
    // profiles mounted only the transport/bridge row, which remains the
    // compatibility fallback.
    const configRowId = rows.has("acp-plugin") ? "acp-plugin" : "acp-bridge";
    const configRow = rows.get(configRowId);
    if (overrides !== undefined && configRow !== undefined) {
        const patch: Record<string, unknown> = {};
        if (overrides.provider !== undefined) patch["provider"] = overrides.provider;
        if (overrides.model !== undefined) patch["model"] = overrides.model;
        if (overrides.permissionMode !== undefined) patch["permissionMode"] = overrides.permissionMode;
        if (overrides.maxTokens !== undefined) patch["maxTokens"] = overrides.maxTokens;
        if (Object.keys(patch).length > 0) {
            overlays.push({ id: configRowId, config: { ...(configRow.config ?? {}), ...patch } });
        }
    }

    const allPatches = [...bundlePatches, ...homePatches, ...overlays];

    // ---- Boot ------------------------------------------------------------
    const launchEnvironment = appBoot.loadLayeredEnv("dsh");
    const launchEnvKey = (
        (await import(pathToFileURL(req.resolve("@deepseek-ai/dsh-launch-environment")).href)) as {
            DSH_LAUNCH_ENVIRONMENT_KEY: string;
        }
    ).DSH_LAUNCH_ENVIRONMENT_KEY;
    const ctx = await appBoot.boot(
        BIN,
        rootConfigPath,
        structuredClone(allPatches) as PatchEntry[],
        (hostCtx) => {
            (hostCtx as BootedContext).provide(launchEnvKey, launchEnvironment);
            (hostCtx as BootedContext).provide("dshAcpHostBaseUrl", bareModuleBaseUrl);
            // Explicit Host-service rows bypass the ACP plugin's fallback mount.
            // Preserve their configuration, but give filesystem-based preset
            // checks the same Host base used by the loader's package imports.
            (hostCtx as Context).on("loader/patch-context", async (entry, next) => {
                if (entry.options.name === "@deepseek-ai/dsh-agent-presets"
                    || entry.options.name === "@deepseek-ai/dsh-cordis-host-runner") {
                    entry.ctx.baseUrl = bareModuleBaseUrl;
                }
                await next();
            });
        },
        bareModuleBaseUrl,
    );
    try {
        appBoot.assertEntriesLoaded(ctx, BIN);
        await appBoot.assertEntriesActivated(ctx, BIN);
    } catch (error: unknown) {
        await ctx.fiber.dispose().catch(() => {});
        throw error;
    }
    return ctx;
}
