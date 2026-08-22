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
        const loaded = [agentPresets, dynamicCordisRunner];
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
                if ((plugin as { name?: string }).name === "acp-server") services.set("acpServer", {});
            },
        };
        const plugin = await import("../src/plugin.ts");

        await plugin.apply(ctx as never);

        expect(imports).toHaveLength(2);
        expect(imports.map((specifier) => specifier.startsWith("file:"))).toEqual([true, true]);
        expect(imports.map((specifier) => fileURLToPath(specifier).replaceAll("\\", "/"))).toEqual([
            expect.stringMatching(/\/@deepseek-ai\/dsh-agent-presets\/lib\/index\.js$/),
            expect.stringMatching(/\/@deepseek-ai\/dsh-cordis-host-runner\/lib\/index\.js$/),
        ]);
        expect(services.has("acpServer")).toBe(true);
    });
});
