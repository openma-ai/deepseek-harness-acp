/**
 * Self-hosted acp profile boot: replicate `dsh --profile acp` in-process.
 *
 * Instead of composing a hand-rolled agent spine, this engine drives the
 * harness's own profile machinery (`@deepseek-ai/dsh-app-boot`) against a
 * discovered installation — the user's `dsh` when present, this package's
 * vendored dependency as the fallback — so the resulting tree is the same
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
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

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

/** Rewrite this package's bridge rows (incl. nested inserts) to an absolute entry. */
function rewriteBridgeRows(row: PatchEntry, absoluteEntry: string): void {
    if (row["name"] === OWN_BRIDGE_SPECIFIER) row["name"] = absoluteEntry;
    const insert = row["insert"];
    if (Array.isArray(insert)) {
        for (const nested of insert) {
            if (nested !== null && typeof nested === "object") {
                rewriteBridgeRows(nested as PatchEntry, absoluteEntry);
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

    // ---- Profile layers -------------------------------------------------
    // A real $DSH_HOME/profiles/acp owns the composition when present (its
    // bundles and user patch layer); otherwise compose the virtual profile:
    // dsh-base + this package, with no per-profile user layer.
    let bundlePatches: PatchEntry[];
    let profilePatches: PatchEntry[] = [];
    let profilePatchPath: string | undefined;
    let rootConfigPath = join(ownRoot(), "profile-root.cordis.yml");
    let bareModuleBaseUrl: string | undefined = pathToFileURL(dshDir + sep).href;
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
    const realProfileDir = join(home, "profiles", "acp");
    if (existsSync(join(realProfileDir, "package.json"))) {
        // Exactly the dsh CLI's path: the profile directory is the module
        // base (its node_modules carries out-of-tree bundles), with the
        // shared fallback link healing dsh-system resolution.
        appBoot.healProfilesModuleFallback(dshPkgPath);
        const profile = appBoot.loadProfile(BIN, "acp", dshPkgPath);
        bundlePatches = profile.layers.flatMap((layer) => layer.patches);
        profilePatches = profile.patches;
        profilePatchPath = join(profile.dir, "cordis.patch.yml");
        const realRoot = join(profile.dir, "cordis.yml");
        if (existsSync(realRoot)) rootConfigPath = realRoot;
        bareModuleBaseUrl = undefined;
        logDebug(`profile: real (${profile.dir})`);
    } else {
        const basePatch = bundlePatchPath(req.resolve("@deepseek-ai/dsh-base/package.json"));
        const ownPatch = bundlePatchPath(join(ownRoot(), "package.json"));
        bundlePatches = [
            ...appBoot.loadOverlayPatches(BIN, basePatch),
            ...appBoot.loadOverlayPatches(BIN, ownPatch),
        ];
        logDebug(`profile: virtual (dsh-base + ${ownRoot()})`);
    }
    for (const row of bundlePatches) rewriteBridgeRows(row, bridgeEntry);

    // ---- Home layer and CLI-equivalent overlays -------------------------
    const homePatchPath = join(home, "cordis.patch.yml");
    const homePatches = appBoot.loadOptionalPatches(BIN, homePatchPath) ?? [];
    const rows = new Map<string, PatchEntry>();
    for (const row of appBoot.composeEntries([bundlePatches, profilePatches, homePatches])) {
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
    const bridgeRow = rows.get("acp-bridge");
    if (overrides?.serve === false && bridgeRow !== undefined) {
        // Tooling boots (login) need the composition without the stdio server.
        overlays.push({ id: "acp-bridge", disabled: true });
    }
    if (overrides !== undefined && bridgeRow !== undefined) {
        const patch: Record<string, unknown> = {};
        if (overrides.provider !== undefined) patch["provider"] = overrides.provider;
        if (overrides.model !== undefined) patch["model"] = overrides.model;
        if (overrides.permissionMode !== undefined) patch["permissionMode"] = overrides.permissionMode;
        if (overrides.maxTokens !== undefined) patch["maxTokens"] = overrides.maxTokens;
        if (Object.keys(patch).length > 0) {
            overlays.push({ id: "acp-bridge", config: { ...(bridgeRow.config ?? {}), ...patch } });
        }
    }

    const allPatches = [...bundlePatches, ...profilePatches, ...homePatches, ...overlays];

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
    if (profilePatchPath !== undefined) {
        logDebug(`user patch layers are read at boot; edit ${profilePatchPath} and restart to apply`);
    }
    return ctx;
}
