import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    applyDedupe,
    assertNoRedundantCopies,
    compareVersions,
    findCopies,
    findRequirers,
    planDedupe,
    satisfiesRange,
    verifyResolution,
} from "../scripts/runtime-pack-zod.mjs";

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

/** The manifest of a zod copy. */
const zodManifest = (version) => ({
    name: "zod",
    version,
    type: "module",
    main: "./index.cjs",
    exports: {
        "./package.json": "./package.json",
        ".": "./index.js",
    },
});

/** The kind of symlink the platform creates without extra privileges. */
const linkType = process.platform === "win32" ? "junction" : "dir";

/**
 * Build a small tree that looks like the runtime tree: a root slot copy of
 * zod, nested copies under the packages that pin it, and the lockfiles that
 * describe both.
 *
 * @param {object} spec - the tree: the zod copies, the requirers, and the
 *   dependencies the tree root itself declares.
 * @param {string} [directory] - the directory to build the tree in; a fresh
 *   temporary directory is used when it is not given.
 * @returns {string} the tree root.
 */
const makeTree = (spec, directory) => {
    const root = directory ?? mkdtempSync(join(tmpdir(), "acp-runtime-zod-"));
    roots.push(root);
    const packages = {};
    const record = (dir, name, version) => {
        packages[dir] = {
            version,
            resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
            integrity: "sha512-fixture-digest",
            license: "MIT",
        };
    };
    const rootDependencies = spec.rootDependencies ?? {};
    write(root, "package.json", {
        name: "fixture-root",
        version: "1.0.0",
        dependencies: rootDependencies,
    });
    packages[""] = { name: "fixture-root", version: "1.0.0", dependencies: rootDependencies };
    for (const copy of spec.copies) {
        const dir = `node_modules/${copy.path}`;
        write(root, `${dir}/package.json`, zodManifest(copy.version));
        write(root, `${dir}/index.js`, "export const zod = 1;\n");
        record(dir, "zod", copy.version);
    }
    for (const parent of spec.parents) {
        const dir = `node_modules/${parent.name}`;
        write(root, `${dir}/package.json`, {
            name: parent.name,
            version: "1.0.0",
            main: "./index.js",
            dependencies: { zod: parent.range },
        });
        write(root, `${dir}/index.js`, "export const value = 1;\n");
        record(dir, parent.name, "1.0.0");
    }
    const lock = { name: "fixture-root", version: "1.0.0", lockfileVersion: 3, requires: true, packages };
    write(root, "package-lock.json", lock);
    write(root, "node_modules/.package-lock.json", lock);
    return root;
};

/** The version of the zod copy in the root slot of a tree. */
const rootVersion = (root) =>
    JSON.parse(readFileSync(join(root, "node_modules/zod/package.json"), "utf8")).version;

describe("the compatible zod collapse", () => {
    it("keeps the copy that is already hoisted when it satisfies every declared range", () => {
        const root = makeTree({
            copies: [
                { path: "zod", version: "4.6.7" },
                { path: "parent-a/node_modules/zod", version: "4.6.6" },
            ],
            parents: [{ name: "parent-a", range: "^4.6.0" }],
        });
        const plan = planDedupe(root);
        expect(plan.acceptable).toEqual(["4.6.6", "4.6.7"]);
        // The hoisted version is not changed by the collapse.
        expect(plan.survivor.dir).toBe("node_modules/zod");
        expect(plan.survivor.version).toBe("4.6.7");
        const report = applyDedupe(root, plan);
        expect(report.applied).toBe(true);
        expect(rootVersion(root)).toBe("4.6.7");
        expect(findCopies(root)).toHaveLength(1);
        expect(existsSync(join(root, "node_modules/parent-a/node_modules/zod"))).toBe(false);
    });

    it("refuses to force a version that does not satisfy a declared range", () => {
        const root = makeTree({
            copies: [
                { path: "zod", version: "4.6.7" },
                { path: "parent-a/node_modules/zod", version: "4.6.6" },
            ],
            parents: [{ name: "parent-a", range: "4.6.6" }],
        });
        const plan = planDedupe(root);
        // The hoisted 4.6.7 does not satisfy the exact pin, so it is not the
        // version that may survive.
        expect(plan.acceptable).toEqual(["4.6.6"]);
        expect(plan.survivor.version).toBe("4.6.6");
        expect(plan.survivor.dir).not.toBe("node_modules/zod");
        expect(plan.conflicts).toEqual([]);
        applyDedupe(root, plan);
        expect(rootVersion(root)).toBe("4.6.6");
        expect(findCopies(root)).toHaveLength(1);
    });

    it("does not collapse when no version satisfies every declared range", () => {
        const root = makeTree({
            copies: [
                { path: "zod", version: "4.6.7" },
                { path: "parent-a/node_modules/zod", version: "4.6.6" },
            ],
            parents: [
                { name: "parent-a", range: "4.6.6" },
                { name: "parent-b", range: "4.6.7" },
            ],
        });
        const plan = planDedupe(root);
        expect(plan.acceptable).toEqual([]);
        expect(plan.survivor).toBeNull();
        expect(plan.conflicts).toHaveLength(2);
        const report = applyDedupe(root, plan);
        expect(report.applied).toBe(false);
        // Nothing was touched: the tree still carries both copies.
        expect(findCopies(root)).toHaveLength(2);
        expect(rootVersion(root)).toBe("4.6.7");
    });

    it("resolves every requirer to the surviving copy", () => {
        const root = makeTree({
            copies: [
                { path: "zod", version: "4.6.7" },
                { path: "parent-a/node_modules/zod", version: "4.6.6" },
                { path: "parent-b/node_modules/zod", version: "4.6.6" },
            ],
            parents: [
                { name: "parent-a", range: "4.6.6" },
                { name: "parent-b", range: "^4.0.0" },
            ],
        });
        applyDedupe(root, planDedupe(root));
        const evidence = verifyResolution(root);
        expect(evidence).toHaveLength(2);
        for (const entry of evidence) {
            expect(entry.resolved).toBe("node_modules/zod/package.json");
            expect(entry.version).toBe("4.6.6");
            expect(satisfiesRange(entry.version, entry.range)).toBe(true);
        }
    });

    it("reports the same path when the root is reached through a symlink", () => {
        // The tree lives in a directory that is reached through a symlink, the
        // way macOS reaches `/var/...` through `/private/var/...`: it is the
        // same tree, and the evidence has to name the file the way the tree
        // names it.
        const real = mkdtempSync(join(tmpdir(), "acp-runtime-zod-real-"));
        const link = join(tmpdir(), `acp-runtime-zod-link-${basename(real)}`);
        symlinkSync(real, link, linkType);
        // The links are removed before the directories they point at.
        roots.unshift(link);
        roots.push(real);
        const root = makeTree({
            copies: [
                { path: "zod", version: "4.6.6" },
                { path: "parent-a/node_modules/zod", version: "4.6.6" },
            ],
            parents: [{ name: "parent-a", range: "4.6.6" }],
        }, join(real, "tree"));
        applyDedupe(root, planDedupe(root));

        // The root is reached through the symlinked parent directory.
        const throughParent = verifyResolution(join(link, "tree"));
        expect(throughParent).toHaveLength(1);
        expect(throughParent[0].resolved).toBe("node_modules/zod/package.json");
        expect(throughParent[0].version).toBe("4.6.6");
        expect(satisfiesRange(throughParent[0].version, throughParent[0].range)).toBe(true);

        // The root itself is the symlink.
        const selfLink = join(dirname(root), `${basename(root)}-link`);
        symlinkSync(root, selfLink, linkType);
        roots.unshift(selfLink);
        const throughSelf = verifyResolution(selfLink);
        expect(throughSelf).toHaveLength(1);
        expect(throughSelf[0].resolved).toBe("node_modules/zod/package.json");
        expect(throughSelf[0].version).toBe("4.6.6");
        expect(satisfiesRange(throughSelf[0].version, throughSelf[0].range)).toBe(true);
    });

    it("refuses to report a resolution that lies outside the tree", () => {
        const root = makeTree({
            copies: [{ path: "zod", version: "4.6.6" }],
            parents: [{ name: "parent-a", range: "4.6.6" }],
        });
        // The copy the requirer resolves to lives outside the tree, so the
        // evidence cannot name it relative to the root.
        const outside = mkdtempSync(join(tmpdir(), "acp-runtime-zod-outside-"));
        roots.push(outside);
        write(outside, "zod/package.json", zodManifest("4.6.6"));
        const slot = join(root, "node_modules/zod");
        rmSync(slot, { recursive: true, force: true });
        symlinkSync(join(outside, "zod"), slot, linkType);
        expect(() => verifyResolution(root)).toThrow(/lies outside the runtime tree/);
    });

    it("refuses to pack a tree that still carries a redundant copy", () => {
        const root = makeTree({
            copies: [
                { path: "zod", version: "4.6.6" },
                { path: "parent-a/node_modules/zod", version: "4.6.6" },
            ],
            parents: [{ name: "parent-a", range: "4.6.6" }],
        });
        expect(() => assertNoRedundantCopies(root)).toThrow(/redundant zod copies/);
        applyDedupe(root, planDedupe(root));
        expect(assertNoRedundantCopies(root)).toEqual({ copies: 1, nested: 0, redundant: [] });
    });

    it("rewrites the lockfiles so they describe the shipped tree", () => {
        const root = makeTree({
            copies: [
                { path: "zod", version: "4.6.7" },
                { path: "parent-a/node_modules/zod", version: "4.6.6" },
            ],
            parents: [{ name: "parent-a", range: "4.6.6" }],
        });
        const report = applyDedupe(root, planDedupe(root));
        expect(report.locks).toEqual(["package-lock.json", "node_modules/.package-lock.json"]);
        for (const relative of report.locks) {
            const lock = JSON.parse(readFileSync(join(root, relative), "utf8"));
            const zodEntries = Object.keys(lock.packages).filter((key) => key.endsWith("node_modules/zod"));
            expect(zodEntries).toEqual(["node_modules/zod"]);
            expect(lock.packages["node_modules/zod"].version).toBe("4.6.6");
            expect(lock.packages["node_modules/zod"].resolved).toContain("zod-4.6.6.tgz");
        }
    });

    it("counts the tree root as a requirer", () => {
        const root = makeTree({
            rootDependencies: { zod: "4.6.7" },
            copies: [
                { path: "zod", version: "4.6.7" },
                { path: "parent-a/node_modules/zod", version: "4.6.6" },
            ],
            parents: [{ name: "parent-a", range: "^4.6.0" }],
        });
        expect(findRequirers(root).some((requirer) => requirer.dir === "")).toBe(true);
        const plan = planDedupe(root);
        // The root pins 4.6.7, so the nested 4.6.6 copy may not survive.
        expect(plan.acceptable).toEqual(["4.6.7"]);
        expect(plan.survivor.dir).toBe("node_modules/zod");
    });

    it("orders versions the way npm orders them", () => {
        expect(compareVersions("4.10.0", "4.9.0")).toBeGreaterThan(0);
        expect(compareVersions("4.6.6", "4.6.7")).toBeLessThan(0);
        expect(compareVersions("4.6.6", "4.6.6")).toBe(0);
    });

    it("keeps the newest acceptable copy when the root slot holds none", () => {
        const root = makeTree({
            copies: [
                { path: "parent-a/node_modules/zod", version: "4.9.0" },
                { path: "parent-b/node_modules/zod", version: "4.10.0" },
            ],
            parents: [
                { name: "parent-a", range: "^4.0.0" },
                { name: "parent-b", range: "^4.0.0" },
            ],
        });
        const plan = planDedupe(root);
        expect(plan.survivor.version).toBe("4.10.0");
    });

    it("refuses to guess a range npm cannot parse", () => {
        expect(satisfiesRange("4.6.6", "workspace:*")).toBe(false);
        expect(satisfiesRange("4.6.6", "npm:zod@4.6.6")).toBe(false);
        expect(satisfiesRange("4.6.6", "latest")).toBe(false);
        expect(satisfiesRange("4.6.6", "^4.6.0")).toBe(true);
        expect(satisfiesRange("4.6.6", "4.6.6")).toBe(true);
    });

    it("does not collapse a tree that carries a range npm cannot parse", () => {
        const root = makeTree({
            copies: [
                { path: "zod", version: "4.6.7" },
                { path: "parent-a/node_modules/zod", version: "4.6.6" },
            ],
            parents: [{ name: "parent-a", range: "workspace:*" }],
        });
        const plan = planDedupe(root);
        expect(plan.acceptable).toEqual([]);
        expect(plan.survivor).toBeNull();
        expect(applyDedupe(root, plan).applied).toBe(false);
        expect(findCopies(root)).toHaveLength(2);
    });
});
