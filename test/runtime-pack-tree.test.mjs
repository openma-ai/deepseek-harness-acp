import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRuntimeTree, pruneReason, pruneRuntimeTree } from "../scripts/runtime-pack-tree.mjs";

const roots = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Write a file below the tree root, creating the directories it needs. */
const write = (root, path, content) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
};

/**
 * Build a small tree that looks like the runtime tree: a package with build
 * material next to its runtime output, a package that loads resources by
 * path, and a package that only publishes an export map.
 *
 * @returns {string} the tree root.
 */
const makeTree = () => {
    const root = mkdtempSync(join(tmpdir(), "acp-runtime-tree-"));
    roots.push(root);

    write(root, "node_modules/fixture-pkg/package.json", {
        name: "fixture-pkg",
        version: "1.0.0",
        main: "./index.js",
        exports: { ".": "./index.js", "./package.json": "./package.json" },
    });
    write(root, "node_modules/fixture-pkg/index.js", "import { helper } from './lib/helper.js';\nexport const value = helper();\n");
    write(root, "node_modules/fixture-pkg/lib/helper.js", "export const helper = () => 1;\n");
    // Build material: never loaded at runtime.
    write(root, "node_modules/fixture-pkg/index.d.ts", "export declare const value: number;\n");
    write(root, "node_modules/fixture-pkg/index.js.map", '{"version":3}\n');
    write(root, "node_modules/fixture-pkg/src/index.ts", "export const value = 1;\n");
    write(root, "node_modules/fixture-pkg/tests/helper.test.js", "export const test = 1;\n");
    write(root, "node_modules/fixture-pkg/tests/fixtures/data.json", { fixture: true });
    // Material the runtime keeps.
    write(root, "node_modules/fixture-pkg/LICENSE", "Apache-2.0\n");
    write(root, "node_modules/fixture-pkg/docs/guide.md", "# guide\n");
    write(root, "node_modules/fixture-pkg/skills/demo/SKILL.md", "# skill\n");
    write(root, "node_modules/fixture-pkg/skills/demo/helper.ts", "export const helper = 1;\n");
    write(root, "node_modules/fixture-pkg/schemas/thing.schema.json", { type: "object" });
    write(root, "node_modules/fixture-pkg/assets/icon.svg", "<svg/>\n");
    write(root, "node_modules/fixture-pkg/build/native.node", "native bytes");
    write(root, "node_modules/fixture-pkg/extra/data.json", { keep: true });

    // A package that loads resources by path instead of by import.
    write(root, "node_modules/asset-pkg/package.json", {
        name: "asset-pkg",
        version: "1.0.0",
        main: "./index.js",
    });
    write(root, "node_modules/asset-pkg/index.js", [
        "const logo = new URL('./resources/logo.svg', import.meta.url);",
        "const theme = readFileSync('./themes/dark.json');",
        "export const value = logo + theme;",
        "",
    ].join("\n"));
    write(root, "node_modules/asset-pkg/resources/logo.svg", "<svg/>\n");
    write(root, "node_modules/asset-pkg/themes/dark.json", { theme: "dark" });
    write(root, "node_modules/asset-pkg/themes/light.json", { theme: "light" });

    // A package that is only reachable through its export map.
    write(root, "node_modules/exports-pkg/package.json", {
        name: "exports-pkg",
        version: "1.0.0",
        exports: { ".": "./dist/entry.js", "./package.json": "./package.json" },
    });
    write(root, "node_modules/exports-pkg/dist/entry.js", "export const value = 1;\n");

    return root;
};

/** Whether a file survived the prune. */
const kept = (root, path) => existsSync(join(root, path));

describe("the runtime tree prune", () => {
    it("removes the build material the runtime cannot reach", () => {
        const root = makeTree();
        const report = pruneRuntimeTree(root);
        expect(report.removedFiles).toBeGreaterThan(0);
        expect(kept(root, "node_modules/fixture-pkg/index.d.ts")).toBe(false);
        expect(kept(root, "node_modules/fixture-pkg/index.js.map")).toBe(false);
        expect(kept(root, "node_modules/fixture-pkg/src/index.ts")).toBe(false);
        expect(kept(root, "node_modules/fixture-pkg/tests/helper.test.js")).toBe(false);
    });

    it("keeps a resource directory whole, even where it holds test material", () => {
        const root = makeTree();
        pruneRuntimeTree(root);
        // `tests/fixtures/` is a resource directory: the harness may load
        // fixtures by path, so the whole directory is kept.
        expect(kept(root, "node_modules/fixture-pkg/tests/fixtures/data.json")).toBe(true);
    });

    it("keeps the runtime code of every package", () => {
        const root = makeTree();
        pruneRuntimeTree(root);
        expect(kept(root, "node_modules/fixture-pkg/index.js")).toBe(true);
        expect(kept(root, "node_modules/fixture-pkg/lib/helper.js")).toBe(true);
        expect(kept(root, "node_modules/fixture-pkg/package.json")).toBe(true);
        // The export target is part of the public surface even when nothing
        // imports it.
        expect(kept(root, "node_modules/exports-pkg/dist/entry.js")).toBe(true);
    });

    it("keeps the resources a package loads by path", () => {
        const root = makeTree();
        pruneRuntimeTree(root);
        expect(kept(root, "node_modules/asset-pkg/resources/logo.svg")).toBe(true);
        // `themes/` is not a resource directory: only the file the runtime
        // actually loads survives.
        expect(kept(root, "node_modules/asset-pkg/themes/dark.json")).toBe(true);
        expect(kept(root, "node_modules/asset-pkg/themes/light.json")).toBe(true);
    });

    it("keeps licences, schemas, skills, assets and platform binaries", () => {
        const root = makeTree();
        pruneRuntimeTree(root);
        expect(kept(root, "node_modules/fixture-pkg/LICENSE")).toBe(true);
        expect(kept(root, "node_modules/fixture-pkg/docs/guide.md")).toBe(true);
        expect(kept(root, "node_modules/fixture-pkg/skills/demo/SKILL.md")).toBe(true);
        expect(kept(root, "node_modules/fixture-pkg/schemas/thing.schema.json")).toBe(true);
        expect(kept(root, "node_modules/fixture-pkg/assets/icon.svg")).toBe(true);
        expect(kept(root, "node_modules/fixture-pkg/build/native.node")).toBe(true);
    });

    it("keeps a source file that a resource directory holds", () => {
        const root = makeTree();
        pruneRuntimeTree(root);
        expect(kept(root, "node_modules/fixture-pkg/skills/demo/helper.ts")).toBe(true);
    });

    it("keeps the files it cannot classify as build material", () => {
        const root = makeTree();
        pruneRuntimeTree(root);
        expect(kept(root, "node_modules/fixture-pkg/extra/data.json")).toBe(true);
    });

    it("never removes a file the runtime can reach", () => {
        const root = makeTree();
        const analysis = analyzeRuntimeTree(root);
        expect(analysis.protectedFiles.has("node_modules/fixture-pkg/index.js")).toBe(true);
        expect(analysis.protectedFiles.has("node_modules/fixture-pkg/lib/helper.js")).toBe(true);
        expect(analysis.protectedFiles.has("node_modules/exports-pkg/dist/entry.js")).toBe(true);
        expect(analysis.protectedFiles.has("node_modules/asset-pkg/resources/logo.svg")).toBe(true);
        expect(analysis.protectedFiles.has("node_modules/asset-pkg/themes/dark.json")).toBe(true);
    });

    it("keeps a file the analysis has already marked as reachable", () => {
        const reachable = new Set(["node_modules/fixture-pkg/index.d.ts"]);
        expect(pruneReason("node_modules/fixture-pkg/index.d.ts", reachable)).toBeNull();
        expect(pruneReason("node_modules/fixture-pkg/index.d.ts", new Set())).toBe("declaration");
    });

    it("reports what it removed", () => {
        const root = makeTree();
        const report = pruneRuntimeTree(root, { dryRun: true });
        expect(report.dryRun).toBe(true);
        expect(report.byReason.declaration.files).toBeGreaterThan(0);
        expect(report.byReason.sourcemap.files).toBeGreaterThan(0);
        expect(report.byReason["typescript-source"].files).toBeGreaterThan(0);
        expect(report.byReason["test-file"].files).toBeGreaterThan(0);
        // A dry run touches nothing.
        expect(kept(root, "node_modules/fixture-pkg/index.d.ts")).toBe(true);
    });
});
