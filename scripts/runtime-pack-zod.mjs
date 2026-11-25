/**
 * Compatible duplicate collapse for the standalone runtime tree.
 *
 * `npm ci` lays the runtime tree out the way npm resolves it: a package that
 * pins `zod` to an exact version gets its own copy when the hoisted version
 * is a different one. The DeepSeek Harness tree pins `zod` exactly in dozens
 * of packages, so the tree used to carry ~68 copies of the same zod release
 * — hundreds of megabytes of identical bytes.
 *
 * The collapse here is deliberately conservative:
 *
 *   1. every copy of zod in the tree is found, with its version;
 *   2. every package that declares a dependency on zod is collected, with the
 *      range it declares — including the tree root itself;
 *   3. a version may only survive when it satisfies *every* declared range;
 *   4. the survivor is the copy of that version — the one that is already
 *      hoisted when it qualifies, so the collapse never changes the version
 *      the tree resolved to — and every other copy is removed;
 *   5. the resolution is then re-checked with Node's own resolver, so the
 *      evidence is a real module resolution and not a simulation.
 *
 * Nothing is forced: a version that does not satisfy a declared range is
 * never hoisted, and a tree whose copies genuinely differ keeps them.
 */

import {
    cpSync,
    existsSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import semver from "semver";

import { scanRuntimeTree } from "./runtime-pack-tree.mjs";

/** The package the collapse applies to. */
export const DEDUPE_PACKAGE = "zod";

/**
 * Every installed copy of a package in the tree.
 *
 * @param {string} root - the staging root.
 * @param {string} name - the package name.
 * @returns {Array<{dir: string, version: string, manifest: object}>} the copies.
 */
export function findCopies(root, name = DEDUPE_PACKAGE) {
    const { packages } = scanRuntimeTree(root);
    const copies = [];
    for (const [dir, manifest] of packages) {
        if (manifest.name !== name) continue;
        if (typeof manifest.version !== "string") continue;
        copies.push({ dir, version: manifest.version, manifest });
    }
    return copies.sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/**
 * Every package that declares a dependency on a package.
 *
 * The tree root counts as a requirer: it is the package the archive carries,
 * and a collapse must never break the dependencies it declares itself.
 *
 * @param {string} root - the staging root.
 * @param {string} name - the dependency name.
 * @returns {Array<{dir: string, package: string, range: string, kind: string}>}
 *   the requirers, with the range each of them declares.
 */
export function findRequirers(root, name = DEDUPE_PACKAGE) {
    const { packages } = scanRuntimeTree(root);
    const requirers = [];
    const manifests = new Map(packages);
    try {
        manifests.set("", JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
    } catch {
        // A tree without a root manifest has no root-level dependency.
    }
    for (const [dir, manifest] of manifests) {
        if (manifest.name === name) continue;
        const kinds = [
            ["dependencies", manifest.dependencies],
            ["optionalDependencies", manifest.optionalDependencies],
            ["peerDependencies", manifest.peerDependencies],
        ];
        for (const [kind, group] of kinds) {
            const range = group?.[name];
            if (typeof range !== "string" || range.length === 0) continue;
            requirers.push({
                dir,
                package: typeof manifest.name === "string" ? manifest.name : dir,
                range,
                kind,
            });
        }
    }
    return requirers.sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/**
 * Whether a version satisfies a declared range.
 *
 * A range npm itself cannot parse — an alias, a tag, a workspace protocol —
 * is never guessed: the version is not accepted, so a tree that carries such
 * a range is never collapsed on its account.
 *
 * @param {string} version - the candidate version.
 * @param {string} range - the declared range.
 * @returns {boolean} whether the range accepts the version.
 */
export function satisfiesRange(version, range) {
    if (semver.validRange(range) === null) return false;
    try {
        return semver.satisfies(version, range, { includePrerelease: true });
    } catch {
        return false;
    }
}

/**
 * Compare two versions the way npm orders them.
 *
 * The comparison is a semantic one: a lexicographic order would rank
 * `4.10.0` below `4.9.0`, and the collapse must pick the version npm itself
 * would consider the newer one.
 *
 * @param {string} a - the first version.
 * @param {string} b - the second version.
 * @returns {number} a negative number when `a` is older.
 */
export function compareVersions(a, b) {
    try {
        return semver.compare(a, b);
    } catch {
        return a < b ? -1 : a > b ? 1 : 0;
    }
}

/**
 * Plan the collapse of the duplicate copies of a package.
 *
 * @param {string} root - the staging root.
 * @param {string} [name] - the package to collapse.
 * @returns {object} the plan: the copies, the requirers, the versions that
 *   satisfy every declared range, and the survivor that was chosen.
 */
export function planDedupe(root, name = DEDUPE_PACKAGE) {
    const copies = findCopies(root, name);
    const requirers = findRequirers(root, name);
    const versions = [...new Set(copies.map((copy) => copy.version))].sort(compareVersions);
    const acceptable = versions.filter((version) =>
        requirers.every((requirer) => satisfiesRange(version, requirer.range)));
    const rootSlot = `node_modules/${name}`;
    const rootCopy = copies.find((copy) => copy.dir === rootSlot) ?? null;
    // The copy that is already hoisted wins whenever it satisfies every
    // declared range: the collapse removes the redundant copies, it must not
    // change the version the tree resolved to. A hoisted version that no
    // requirer accepts (a tree where the root slot carries a different
    // release than the requirers pin) is replaced by the newest version every
    // requirer does accept — never by a forced one.
    const survivor = acceptable.length === 0
        ? null
        : rootCopy !== null && acceptable.includes(rootCopy.version)
            ? rootCopy
            : copies.find((copy) => copy.version === acceptable[acceptable.length - 1]) ?? null;
    const conflicts = requirers
        .filter((requirer) => !acceptable.some((version) => satisfiesRange(version, requirer.range)))
        .map((requirer) => ({ ...requirer, accepted: acceptable }));
    return {
        name,
        copies,
        requirers,
        versions,
        acceptable,
        survivor,
        conflicts,
        rootSlot,
        redundant: survivor === null ? copies.filter((copy) => copy.dir !== rootSlot) : [],
    };
}

/**
 * Apply the collapse plan to the tree.
 *
 * The surviving copy becomes the one in the root slot; every other copy is
 * removed. The lockfiles that travel with the archive are rewritten to
 * describe the tree that is actually shipped.
 *
 * @param {string} root - the staging root.
 * @param {object} plan - the plan from {@link planDedupe}.
 * @returns {object} the report of what changed.
 */
export function applyDedupe(root, plan) {
    if (plan.survivor === null) {
        return { applied: false, removed: [], survivor: null, locks: [] };
    }
    withLockEntries(root, plan);
    const rootSlot = join(root, plan.rootSlot);
    const survivorDir = join(root, plan.survivor.dir);
    const removed = [];
    if (plan.survivor.dir !== plan.rootSlot) {
        // Move the surviving copy into the root slot. The copy is first taken
        // aside, because the survivor can live inside a directory that the
        // removal below deletes.
        const parked = `${rootSlot}.dedupe-${process.pid}`;
        rmSync(parked, { recursive: true, force: true });
        cpSync(survivorDir, parked, { recursive: true });
        rmSync(rootSlot, { recursive: true, force: true });
        cpSync(parked, rootSlot, { recursive: true });
        rmSync(parked, { recursive: true, force: true });
    }
    for (const copy of plan.copies) {
        if (copy.dir === plan.rootSlot) continue;
        const absolute = join(root, copy.dir);
        if (!existsSync(absolute)) continue;
        removed.push({ dir: copy.dir, version: copy.version, bytes: directoryBytes(absolute) });
        rmSync(absolute, { recursive: true, force: true });
    }
    const locks = rewriteLocks(root, plan);
    return {
        applied: true,
        survivor: { dir: plan.rootSlot, version: plan.survivor.version },
        removed,
        removedBytes: removed.reduce((total, entry) => total + entry.bytes, 0),
        locks,
    };
}

/**
 * The size of a directory tree.
 *
 * @param {string} directory - the directory.
 * @returns {number} the size in bytes.
 */
function directoryBytes(directory) {
    let total = 0;
    const stack = [directory];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries = [];
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const path = join(current, entry.name);
            if (entry.isDirectory()) stack.push(path);
            else {
                try {
                    total += statSync(path).size;
                } catch {
                    // A file that vanished mid-scan does not count.
                }
            }
        }
    }
    return total;
}

/**
 * Rewrite the lockfiles so they describe the tree that is shipped.
 *
 * The archive carries the lockfile it was built from. After a collapse the
 * tree holds one copy where the lockfile records many, so the lockfile is
 * rewritten to match: `npm ci` in the extracted tree then reproduces exactly
 * the tree the archive carries.
 *
 * @param {string} root - the staging root.
 * @param {object} plan - the plan from {@link planDedupe}.
 * @returns {string[]} the lockfiles that were rewritten.
 */
export function rewriteLocks(root, plan) {
    const rewritten = [];
    const survivorEntry = plan.survivor === null
        ? null
        : plan.lockEntries?.[plan.survivor.dir] ?? null;
    for (const relative of ["package-lock.json", "node_modules/.package-lock.json"]) {
        const path = join(root, relative);
        if (!existsSync(path)) continue;
        const lock = JSON.parse(readFileSync(path, "utf8"));
        const packages = lock.packages ?? {};
        let changed = false;
        for (const key of Object.keys(packages)) {
            if (key === plan.rootSlot) continue;
            if (!key.endsWith(`node_modules/${plan.name}`)) continue;
            delete packages[key];
            changed = true;
        }
        if (survivorEntry !== null) {
            packages[plan.rootSlot] = survivorEntry;
            changed = true;
        }
        if (!changed) continue;
        writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
        rewritten.push(relative);
    }
    return rewritten;
}

/**
 * Attach the lock entries of the copies to a plan.
 *
 * The plan needs the recorded `resolved`/`integrity` of the surviving copy,
 * so that the rewritten lockfile keeps describing the exact artifact the
 * tree carries.
 *
 * @param {string} root - the staging root.
 * @param {object} plan - the plan from {@link planDedupe}.
 * @returns {object} the plan, with the lock entries attached.
 */
export function withLockEntries(root, plan) {
    const entries = {};
    const path = join(root, "package-lock.json");
    if (existsSync(path)) {
        const lock = JSON.parse(readFileSync(path, "utf8"));
        for (const copy of plan.copies) {
            const entry = lock.packages?.[copy.dir];
            if (entry !== undefined) entries[copy.dir] = entry;
        }
    }
    plan.lockEntries = entries;
    return plan;
}

/**
 * The real path of a file or a directory.
 *
 * A path that cannot be resolved is returned unchanged: the tree is then
 * examined as it is, and a tree that is broken is reported by the checks that
 * follow rather than by a missing path.
 *
 * @param {string} path - the path.
 * @returns {string} the real path.
 */
function realPath(path) {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/**
 * The path of a resolved file inside the tree root, in POSIX form.
 *
 * Both sides are compared through their real path: a root that is reached
 * through a symlink (`/var` vs `/private/var` on macOS) is the same tree, and
 * a resolver that answers with platform separators (Windows) is the same file.
 * The evidence therefore names the file the way the tree names it — a
 * POSIX-relative path from the root — on every platform.
 *
 * A file that lies outside the root is a broken tree, and is reported as such
 * instead of being described by a relative path that points nowhere.
 *
 * @param {string} base - the real path of the tree root.
 * @param {string} resolved - the resolved file.
 * @returns {string} the path relative to the root, in POSIX form.
 */
function relativeToRoot(base, resolved) {
    const target = realPath(resolved);
    const relativePath = relative(base, target);
    const outside = relativePath === ""
        || isAbsolute(relativePath)
        || relativePath === ".."
        || relativePath.startsWith(`..${sep}`);
    if (outside) {
        throw new Error(
            `the resolution ${resolved} lies outside the runtime tree ${base}`,
        );
    }
    return relativePath.split(sep).join("/");
}

/**
 * Check the resolution of the collapsed package with Node's own resolver.
 *
 * The evidence is a real module resolution: every requirer is asked where the
 * package resolves to, and the answer has to be the single surviving copy
 * whose version satisfies the declared range.
 *
 * @param {string} root - the staging root.
 * @param {string} [name] - the package to check.
 * @returns {Array<object>} the evidence, one entry per requirer.
 */
export function verifyResolution(root, name = DEDUPE_PACKAGE) {
    const requirers = findRequirers(root, name);
    // The root is compared through its real path, so that a root that is
    // reached through a symlink is still recognised as the tree it is.
    const base = realPath(resolve(root));
    const evidence = [];
    for (const requirer of requirers) {
        const anchor = join(base, requirer.dir, "package.json");
        const resolved = createRequire(anchor).resolve(`${name}/package.json`);
        const version = JSON.parse(readFileSync(resolved, "utf8")).version;
        if (!satisfiesRange(version, requirer.range)) {
            throw new Error(
                `${requirer.package} requires ${name}@${requirer.range} but resolves to ${version}`,
            );
        }
        evidence.push({
            package: requirer.package,
            range: requirer.range,
            kind: requirer.kind,
            resolved: relativeToRoot(base, resolved),
            version,
        });
    }
    return evidence;
}

/**
 * Refuse to pack a tree that still carries a redundant copy.
 *
 * A nested copy is redundant when the copy in the root slot would satisfy
 * the range its parent declares: the collapse could have removed it, so
 * leaving it behind means the pack silently shipped redundant bytes.
 *
 * @param {string} root - the staging root.
 * @param {string} [name] - the package to check.
 * @returns {object} the report of the copies that remain.
 */
export function assertNoRedundantCopies(root, name = DEDUPE_PACKAGE) {
    const copies = findCopies(root, name);
    const rootSlot = `node_modules/${name}`;
    const rootCopy = copies.find((copy) => copy.dir === rootSlot);
    const nested = copies.filter((copy) => copy.dir !== rootSlot);
    if (rootCopy === undefined) {
        return { copies: copies.length, nested: nested.length, redundant: [] };
    }
    const requirers = findRequirers(root, name);
    const redundant = [];
    for (const copy of nested) {
        const parent = copy.dir.slice(0, -(`/node_modules/${name}`).length);
        const requirer = requirers.find((entry) => entry.dir === parent);
        if (requirer === undefined) continue;
        if (!satisfiesRange(rootCopy.version, requirer.range)) continue;
        redundant.push({
            dir: copy.dir,
            version: copy.version,
            parent: requirer.package,
            range: requirer.range,
        });
    }
    if (redundant.length > 0) {
        const details = redundant.map((entry) => `${entry.dir}@${entry.version}`).join(", ");
        throw new Error(
            `the runtime tree still carries ${redundant.length} redundant ${name} copies (${details}); `
            + "they satisfy the range their parent declares and must be collapsed",
        );
    }
    return { copies: copies.length, nested: nested.length, redundant: [] };
}
