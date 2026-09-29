import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const bridge = { inject: [] as string[] };
const server = { name: "acp-server" };

vi.mock("../src/bridge/index.ts", () => bridge);
vi.mock("../src/server.ts", () => server);

describe("embeddable ACP Host plugin", () => {
    it.each(["current", "legacy"] as const)("resolves %s Host preset capabilities", async (generation) => {
        const imports: string[] = [];
        const bases: string[] = [];
        const services = new Map<string, unknown>();
        const hostBase = generation === "current"
            ? new URL("../node_modules/@deepseek-ai/dsh/", import.meta.url).href
            : new URL("../../deepseek-harness-acp/node_modules/@deepseek-ai/dsh/", import.meta.url).href;
        services.set("dshAcpHostBaseUrl", hostBase);
        const agentPresets = { name: "agent-presets" };
        const dynamicCordisRunner = { name: "dynamic-cordis-runner" };
        const subagentModelSelection = { name: "subagent-model-selection-settings" };
        const preset = { name: "agent-preset" };
        const loaded = [agentPresets, dynamicCordisRunner, subagentModelSelection, preset];
        const ctx = {
            baseUrl: import.meta.url,
            extend(meta: Record<string, unknown>) {
                return Object.assign(Object.create(this), meta);
            },
            get(name: string) {
                return services.get(name);
            },
            loader: {
                async import(specifier: string) {
                    imports.push(specifier);
                    if (specifier.includes("dsh-tool-subagent")) return subagentModelSelection;
                    if (specifier.includes("dsh-cordis-host-runner")) return dynamicCordisRunner;
                    if (specifier.includes("dsh-agent-preset-registry") || specifier.includes("dsh-agent-presets")) return agentPresets;
                    if (specifier.includes("dsh-agent-preset/")) return preset;
                    if (specifier.includes("dsh-app-boot")) return import("@deepseek-ai/dsh-app-boot");
                    throw new Error(`unexpected import: ${specifier}`);
                },
                unwrapExports(exports: unknown) {
                    return exports;
                },
            },
            async plugin(plugin: unknown) {
                if (loaded.includes(plugin as never)) bases.push(this.baseUrl);
                if (plugin === agentPresets) services.set("agentPresets", {});
                if (plugin === dynamicCordisRunner) services.set("dynamicCordisRunner", {});
                if (plugin === subagentModelSelection) services.set("subagentModelSelection", {});
                if ((plugin as { name?: string }).name === "acp-server") services.set("acpServer", {});
            },
        };
        const plugin = await import("../src/plugin.ts");

        await plugin.apply(ctx as never);

        expect(imports.every((specifier) => specifier.startsWith("file:"))).toBe(true);
        const names = imports.map((specifier) => fileURLToPath(specifier).replaceAll("\\", "/"));
        expect(names).toEqual(expect.arrayContaining([
            expect.stringMatching(/\/dsh-cordis-host-runner\/lib\/index\.js$/),
            expect.stringMatching(generation === "current"
                ? /\/dsh-agent-preset-registry\/lib\/index\.js$/
                : /\/dsh-agent-presets\/lib\/index\.js$/),
        ]));
        expect(names.some((name) => name.includes("dsh-agent-preset-registry"))).toBe(generation === "current");
        expect(names.some((name) => name.includes("dsh-tool-subagent"))).toBe(generation === "current");
        expect(services.has("acpServer")).toBe(true);
        expect(bases).toEqual(Array(generation === "current" ? 7 : 2).fill(hostBase));
    });

    it("mounts only the ACP server when the surface already provides agentPresets and dynamicCordisRunner", async () => {
        // dsh 0.1.2-era surfaces (and profiles that carry the ACP bundle rows)
        // already supply both Host services; the fallback mount must be skipped
        // entirely so its preset-root discovery can never run or fail.
        const imports: string[] = [];
        const services = new Map<string, unknown>();
        const ctx = {
            baseUrl: import.meta.url,
            get(name: string) {
                return services.get(name);
            },
            loader: {
                async import(specifier: string) {
                    imports.push(specifier);
                    throw new Error(`unexpected fallback import of ${specifier}`);
                },
                unwrapExports(exports: unknown) {
                    return exports;
                },
            },
            async plugin(plugin: unknown) {
                if ((plugin as { name?: string }).name === "acp-server") services.set("acpServer", {});
            },
        };
        services.set("agentPresets", {});
        services.set("dynamicCordisRunner", {});
        services.set("subagentModelSelection", {});
        const plugin = await import("../src/plugin.ts");

        await plugin.apply(ctx as never);

        expect(imports).toEqual([]);
        expect(services.has("acpServer")).toBe(true);
    });
});
