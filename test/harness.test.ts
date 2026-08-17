import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HarnessNotFoundError, resolveHost } from "../src/harness.ts";

const roots: string[] = [];

function makeTree(): string {
    const root = mkdtempSync(join(tmpdir(), "dsh-acp-host-"));
    roots.push(root);
    return root;
}

function writePackage(dir: string, name: string, extra: Record<string, unknown> = {}): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "9.9.9-test", ...extra }));
}

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("resolveHost", () => {
    it("accepts a directory whose node_modules carries the harness", () => {
        const root = makeTree();
        writePackage(join(root, "node_modules", "@deepseek-ai", "dsh-agent"), "@deepseek-ai/dsh-agent");
        const host = resolveHost(root);
        expect(host.base).toBe(root);
        expect(host.version).toBe("9.9.9-test");
        expect(host.source).toContain(root);
    });

    it("accepts an npm prefix (lib/node_modules layout)", () => {
        const root = makeTree();
        writePackage(
            join(root, "lib", "node_modules", "@deepseek-ai", "dsh-agent"),
            "@deepseek-ai/dsh-agent",
        );
        const host = resolveHost(root);
        expect(host.base).toBe(join(root, "lib", "node_modules"));
    });

    it("accepts the dsh launcher path and walks up through symlinks", () => {
        const root = makeTree();
        const dshDir = join(root, "lib", "node_modules", "@deepseek-ai", "dsh");
        writePackage(dshDir, "@deepseek-ai/dsh", { bin: { dsh: "lib/bin.js" } });
        mkdirSync(join(dshDir, "lib"), { recursive: true });
        writeFileSync(join(dshDir, "lib", "bin.js"), "// launcher");
        // Hoisted sibling in the shared scope dir, like a real npm install.
        writePackage(
            join(root, "lib", "node_modules", "@deepseek-ai", "dsh-agent"),
            "@deepseek-ai/dsh-agent",
        );
        mkdirSync(join(root, "bin"), { recursive: true });
        symlinkSync(join(dshDir, "lib", "bin.js"), join(root, "bin", "dsh"));
        const host = resolveHost(join(root, "bin", "dsh"));
        expect(host.version).toBe("9.9.9-test");
    });

    it("fails loudly with installation guidance when the explicit path has no harness", () => {
        const root = makeTree();
        expect(() => resolveHost(root)).toThrow(HarnessNotFoundError);
        expect(() => resolveHost(root)).toThrow(/npm install -g @deepseek-ai\/dsh/);
    });

    it("auto-detects a harness from the checkout when no path is given", () => {
        // The dev checkout carries the harness (dependencies + devDependencies);
        // user-installation probes (cwd, PATH, npm -g) rank before the
        // npm-installed peer fallback, and in this checkout the cwd probe hits first.
        const host = resolveHost();
        expect(host.source).toMatch(/invoking directory|dsh-acp package tree/);
    });
});
