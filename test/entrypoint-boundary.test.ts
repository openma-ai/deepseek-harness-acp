import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (name: string): string => readFileSync(
    join(import.meta.dirname, "../src", name),
    "utf8",
);

describe("standalone and plugin entrypoint boundary", () => {
    it("keeps host discovery and profile self-boot in the standalone bin", () => {
        const bootstrap = source("bin.ts");
        const standalone = source("index.ts");
        expect(bootstrap).toMatch(/from "\.\/harness\.ts"/);
        expect(bootstrap).toMatch(/resolveHost\(/);
        expect(bootstrap).toMatch(/registerHooks\(/);
        expect(standalone).toMatch(/from "\.\/profile-boot\.ts"/);
        expect(standalone).toMatch(/bootAcpProfile\(/);
    });

    it("keeps the embeddable plugin on the existing Host Cordis tree", () => {
        const plugin = source("plugin.ts");
        expect(plugin).not.toMatch(/from "\.\/harness\.ts"/);
        expect(plugin).not.toMatch(/from "\.\/profile-boot\.ts"/);
        expect(plugin).not.toMatch(/resolveHost\(/);
        expect(plugin).not.toMatch(/bootAcpProfile\(/);
        expect(plugin).not.toMatch(/from "\.\/runtime\.ts"/);
        expect(plugin).toMatch(/ctx\.plugin\(server, config\)/);
    });

    it("makes the private runtime a standalone-only fallback", () => {
        const harness = source("harness.ts");
        expect(harness).toMatch(/resolveVendoredRuntime\(/);
        expect(harness).toMatch(/bundled standalone runtime/);
    });

    it("keeps transport ownership outside the embeddable plugin", () => {
        const plugin = source("plugin.ts");
        expect(plugin).not.toMatch(/process\.(stdin|stdout)/);
        expect(plugin).not.toMatch(/nodeAcpStream/);
        expect(plugin).not.toMatch(/from "\.\/stdio\.ts"/);
    });
});
