import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const bridge = { inject: [] as string[] };
const server = { name: "acp-server" };

vi.mock("../src/bridge/index.ts", () => bridge);
vi.mock("../src/server.ts", () => server);

describe("embeddable ACP Host plugin", () => {
    it("resolves Host service modules to file URLs before Cordis imports them", async () => {
        const imports: string[] = [];
        const services = new Map<string, unknown>();
        const agentPresets = { name: "agent-presets" };
        const dynamicCordisRunner = { name: "dynamic-cordis-runner" };
        const subagentModelSelection = { name: "subagent-model-selection-settings" };
        const loaded = [agentPresets, dynamicCordisRunner, subagentModelSelection];
        const ctx = {
            baseUrl: import.meta.url,
            get(name: string) {
                return services.get(name);
            },
            loader: {
                async import(specifier: string) {
                    imports.push(specifier);
                    return loaded[imports.length - 1];
                },
                unwrapExports(exports: unknown) {
                    return exports;
                },
            },
            async plugin(plugin: unknown) {
                if (plugin === agentPresets) services.set("agentPresets", {});
                if (plugin === dynamicCordisRunner) services.set("dynamicCordisRunner", {});
                if (plugin === subagentModelSelection) services.set("subagentModelSelection", {});
                if ((plugin as { name?: string }).name === "acp-server") services.set("acpServer", {});
            },
        };
        const plugin = await import("../src/plugin.ts");

        await plugin.apply(ctx as never);

        expect(imports).toHaveLength(3);
        expect(imports.map((specifier) => specifier.startsWith("file:"))).toEqual([true, true, true]);
        expect(imports.map((specifier) => fileURLToPath(specifier).replaceAll("\\", "/"))).toEqual([
            expect.stringMatching(/\/@deepseek-ai\/dsh-agent-presets\/lib\/index\.js$/),
            expect.stringMatching(/\/@deepseek-ai\/dsh-cordis-host-runner\/lib\/index\.js$/),
            expect.stringMatching(/\/@deepseek-ai\/dsh-tool-subagent\/lib\/model-selection-settings\.js$/),
        ]);
        expect(services.has("acpServer")).toBe(true);
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
