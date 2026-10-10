/**
 * Standalone profile boot coverage: `bootAcpProfile` drives the host's own
 * `dsh-app-boot` machinery in-process. A generated fixture host tree ships
 * stub `dsh-*` packages (app-boot, home-paths, base, launch-environment) so
 * the prepare callback — which provides `dshAcpHost`, the runtime identity
 * projected to `_meta.dsh.runtime` (issue #157) — really executes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { bootAcpProfile } from "../src/profile-boot.ts";
import type { HarnessHost } from "../src/harness.ts";

interface ProvidedCtx {
    provided: Map<string, unknown>;
    listeners: Map<string, (entry: { options: { name: string }; ctx: Record<string, unknown> }, next: () => Promise<void>) => Promise<void>>;
    fiber: { dispose(): Promise<void> };
}

const APP_BOOT_STUB = `
export function loadOverlayPatches() {
    return [{ id: "stub-overlay" }];
}
export function loadOptionalPatches() {
    return [{ id: "stub-home" }];
}
export function composeEntries() {
    return [
        { id: "acp-bridge", config: {} },
        { id: "acp-plugin", config: {} },
        { id: "agent-presets", config: {} },
        { id: "permission", config: { defaultPreset: "old" } },
        { id: "agent-default-model", config: {} },
        { id: "session-telemetry-otel", config: {} },
    ];
}
export function loadLayeredEnv() {
    return { STUB_ENV: true };
}
export async function auditStartupEntries() {}
export function assertEntriesLoaded() {}
export async function assertEntriesActivated() {}
export function installFailLoud() {}
export function healProfilesModuleFallback() {}
export async function boot(_bin, _configPath, _patches, prepare) {
    const ctx = {
        provided: new Map(),
        listeners: new Map(),
        provide(name, value) { this.provided.set(name, value); },
        get(name) { return this.provided.get(name); },
        on(name, fn) { this.listeners.set(name, fn); return () => {}; },
        extend(input) { return Object.assign(Object.create(Object.getPrototypeOf(this)), this, input); },
        fiber: { async dispose() {} },
    };
    await prepare?.(ctx);
    return ctx;
}
`;

const HOME_PATHS_STUB = `
export function resolveDshHome() {
    return process.env.DSH_ACP_FAKE_HOME;
}
`;

const LAUNCH_ENV_STUB = `
export const DSH_LAUNCH_ENVIRONMENT_KEY = "dshLaunchEnvironment";
`;

function writePackage(dir: string, manifest: Record<string, unknown>, entry?: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.2.0-rc.2", ...manifest }));
    if (entry !== undefined) writeFileSync(join(dir, "index.mjs"), entry);
}

let host: HarnessHost;
let home: string;

beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "dsh-acp-boot-host-"));
    const scope = join(base, "node_modules", "@deepseek-ai");
    writePackage(join(scope, "dsh"), { name: "@deepseek-ai/dsh" });
    // The CLI's shipped preset root overlay only applies when present.
    mkdirSync(join(scope, "dsh", "config", "agent-presets"), { recursive: true });
    writePackage(join(scope, "dsh-app-boot"), { name: "@deepseek-ai/dsh-app-boot", type: "module", main: "./index.mjs" }, APP_BOOT_STUB);
    writePackage(join(scope, "dsh-home-paths"), { name: "@deepseek-ai/dsh-home-paths", type: "module", main: "./index.mjs" }, HOME_PATHS_STUB);
    writePackage(join(scope, "dsh-base"), { name: "@deepseek-ai/dsh-base", dsh: { bundle: { patch: "cordis.patch.yml" } } });
    writeFileSync(join(scope, "dsh-base", "cordis.patch.yml"), "# stub base patch\n");
    writePackage(join(scope, "dsh-launch-environment"), { name: "@deepseek-ai/dsh-launch-environment", type: "module", main: "./index.mjs" }, LAUNCH_ENV_STUB);
    host = { base, version: "9.9.9-fallback", dshVersion: "0.2.0-rc.2", source: "test host" };

    home = mkdtempSync(join(tmpdir(), "dsh-acp-boot-home-"));
    writeFileSync(join(home, "acp-standalone-permission.json"), JSON.stringify({ permissionMode: "workspace-write" }));
    writeFileSync(join(home, "acp-standalone-model.json"), JSON.stringify({ provider: "p", model: "m", reasoningEffort: "high" }));
    process.env["DSH_ACP_FAKE_HOME"] = home;
});

afterAll(() => {
    delete process.env["DSH_ACP_FAKE_HOME"];
    rmSync(host.base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

describe("bootAcpProfile", () => {
    it("provides the resolved runtime identity for _meta.dsh.runtime", async () => {
        const ctx = (await bootAcpProfile(host)) as unknown as ProvidedCtx;

        const dshDir = join(host.base, "node_modules", "@deepseek-ai", "dsh");
        expect(ctx.provided.get("dshLaunchEnvironment")).toEqual({ STUB_ENV: true });
        expect(ctx.provided.get("dshAcpHostBaseUrl")).toBe(pathToFileURL(dshDir + sep).href);
        expect(ctx.provided.get("dshAcpHost")).toEqual({
            base: host.base,
            version: "0.2.0-rc.2",
            source: "test host",
        });
        expect(typeof ctx.provided.get("dshAcpSavePermission")).toBe("function");
        expect(typeof ctx.provided.get("dshAcpSaveModel")).toBe("function");
    });

    it("falls back to the anchor version when no dsh version is known", async () => {
        const unversioned = { ...host, dshVersion: undefined };
        const ctx = (await bootAcpProfile(unversioned)) as unknown as ProvidedCtx;
        expect(ctx.provided.get("dshAcpHost")).toEqual({
            base: host.base,
            version: "9.9.9-fallback",
            source: "test host",
        });
    });

    it("applies CLI and telemetry overlays and disables transport for tooling boots", async () => {
        vi.stubEnv("DSH_TELEMETRY_DISABLED", "1");
        try {
            const ctx = (await bootAcpProfile(host, {
                provider: "p2",
                model: "m2",
                permissionMode: "danger-full-access",
                maxTokens: 128,
                serve: false,
            })) as unknown as ProvidedCtx;
            expect((ctx.provided.get("dshAcpHost") as Record<string, unknown> | undefined)?.["base"]).toBe(host.base);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("points preset checks at the bare module base via loader/patch-context", async () => {
        const ctx = (await bootAcpProfile(host)) as unknown as ProvidedCtx;
        const patchContext = ctx.listeners.get("loader/patch-context");
        expect(patchContext).toBeDefined();
        const dshDir = join(host.base, "node_modules", "@deepseek-ai", "dsh");

        const entry = { options: { name: "@deepseek-ai/dsh-agent-presets" }, ctx: {} as Record<string, unknown> };
        let nextCalled = false;
        await patchContext?.(entry, async () => {
            nextCalled = true;
        });
        expect(entry.ctx["baseUrl"]).toBe(pathToFileURL(dshDir + sep).href);
        expect(nextCalled).toBe(true);

        const other = { options: { name: "other-plugin" }, ctx: {} as Record<string, unknown> };
        await patchContext?.(other, async () => {});
        expect(other.ctx["baseUrl"]).toBeUndefined();
    });
});
