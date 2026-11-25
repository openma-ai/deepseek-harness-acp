/**
 * Reference analysis for the standalone runtime tree.
 *
 * The runtime archive carries a whole `npm ci` tree of the DeepSeek Harness
 * and its dependencies. Most of that tree is not needed to *run* the harness:
 * type declarations, source maps, the packages' own test sources, and the
 * TypeScript sources a package publishes next to its compiled output.
 *
 * This module decides which files those are. The decision is made by
 * reference analysis, never by file-name pattern alone:
 *
 *   1. every package's runtime entry points (`main`, `bin`, and the `exports`
 *      targets that Node actually enables) are roots;
 *   2. the module graph is walked from those roots, resolving `import`,
 *      `export … from`, dynamic `import()`, `require()`, and
 *      `import.meta.resolve()` exactly the way Node would;
 *   3. resources that are loaded by path rather than by module — the
 *      `new URL("…", import.meta.url)` idiom, and path-like string literals —
 *      are collected as well;
 *   4. only what is left over *and* belongs to a build-only category is
 *      removed.
 *
 * Anything the analysis cannot prove to be unused stays in the archive: the
 * runtime must keep working, and a missing resource is a broken install while
 * a leftover source map is only a few bytes.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The export conditions Node enables in the runtime.
 *
 * A target that is only reachable through another condition (`browser`,
 * `development`, or a publisher-specific condition such as zod's
 * `@zod/source`) is not part of the runtime surface: the harness resolves
 * packages with Node's own default conditions.
 */
export const RUNTIME_CONDITIONS = new Set(["node", "import", "require", "node-addons"]);

/** A declaration file: type information only, never loaded at runtime. */
const DECLARATION = /\.d\.(ts|mts|cts)$/;

/** A TypeScript source: the input of a build, not the build output. */
const TYPESCRIPT_SOURCE = /\.(ts|tsx|mts|cts)$/;

/** A source file of a language the runtime never executes. */
const FOREIGN_SOURCE = /\.(c|cc|cpp|cxx|h|hh|hpp|py|pyi|rb|go|rs|sh|bash|zsh|bat|cmd|ps1)$/;

/** A test file: a package's own test material. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Windows debug symbols and macOS debug bundles. */
const DEBUG_SYMBOLS = /\.(pdb|dSYM)$/;

/**
 * Directories that hold runtime resources.
 *
 * A package may ship skills, prompts, catalogs, schemas, or translations that
 * the harness loads by path. Their content is never build material, so it is
 * never removed — only type declarations and source maps inside them are.
 */
const RESOURCE_SEGMENTS = new Set([
    "skill",
    "skills",
    "prompt",
    "prompts",
    "template",
    "templates",
    "catalog",
    "catalogs",
    "schema",
    "schemas",
    "locale",
    "locales",
    "i18n",
    "resource",
    "resources",
    "asset",
    "assets",
    "fixture",
    "fixtures",
    "__fixtures__",
    "example",
    "examples",
    "doc",
    "docs",
]);

/** Directories that hold a package's own test material. */
const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "__spec__"]);

/** Names that carry licence and notice material. */
const LICENSE_NAME = /^(licen[cs]e|notice|copying|authors|patents|credits)/i;

/** Module specifiers, as they appear in the sources. */
const SPECIFIER_PATTERNS = [
    /\bimport\s+[^;'"()]*?\bfrom\s*["']([^"'\n]+)["']/g,
    /\bexport\s+[^;'"()]*?\bfrom\s*["']([^"'\n]+)["']/g,
    /\bimport\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\bimport\.meta\.resolve\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

/** A resource loaded by URL relative to the importing module. */
const URL_RESOURCE = /\bnew\s+URL\s*\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)/g;

/** A path-like literal that may point at a resource loaded at runtime. */
const PATH_LITERAL = /["'`]([^"'`\n]*\/[^"'`\n]*)["'`]/g;

/** The file extensions Node tries for an extensionless specifier. */
const EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".json", ".node", ".ts", ".tsx", ".mts", ".cts"];

/** The file extensions Node tries for an extensionless directory import. */
const INDEX_FILES = ["/index.js", "/index.mjs", "/index.cjs", "/index.json", "/index.ts"];

/** Normalize a path to the POSIX form used inside the tree. */
const toPosix = (path) => path.split(sep).join("/");

/** The parent directory of a POSIX path inside the tree. */
const parentOf = (path) => {
    const index = path.lastIndexOf("/");
    if (index < 0) return "";
    return path.slice(0, index);
};

/** Join a POSIX path onto a POSIX base, resolving `.` and `..`. */
const joinPosix = (base, target) => {
    const parts = (base === "" ? [] : base.split("/")).concat(target.split("/"));
    const out = [];
    for (const part of parts) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return out.join("/");
};

/**
 * Collect every file and every package of a runtime tree.
 *
 * @param {string} root - the staging root; it holds the `node_modules` tree.
 * @returns {{files: string[], packages: Map<string, object>}} the tree files
 *   (POSIX paths relative to the root) and the manifests of every installed
 *   package, keyed by the package directory.
 */
export function scanRuntimeTree(root) {
    const files = [];
    const packages = new Map();
    const modules = join(root, "node_modules");
    if (!existsSync(modules)) return { files, packages };
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const absolute = join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(absolute);
                continue;
            }
            if (!entry.isFile()) continue;
            const path = toPosix(relative(root, absolute));
            files.push(path);
            if (entry.name !== "package.json") continue;
            const dir = path === "package.json" ? "" : path.slice(0, -"/package.json".length);
            try {
                packages.set(dir, JSON.parse(readFileSync(absolute, "utf8")));
            } catch {
                // A malformed manifest is not a package; it stays in the tree.
            }
        }
    };
    walk(modules);
    return { files, packages };
}

/**
 * The export targets of a manifest that Node enables in the runtime.
 *
 * @param {unknown} value - an `exports` value: a string, a condition map, or
 *   a subpath map.
 * @returns {string[]} the enabled targets.
 */
export function runtimeExportTargets(value) {
    if (typeof value === "string") return [value];
    if (value === null || typeof value !== "object") return [];
    const targets = [];
    for (const [condition, child] of Object.entries(value)) {
        // `types`/`typings` describe the type surface, not the runtime one.
        if (condition === "types" || condition === "typings") continue;
        // `default` always matches; every other condition has to be enabled.
        if (condition === "default" || RUNTIME_CONDITIONS.has(condition)) {
            targets.push(...runtimeExportTargets(child));
        }
    }
    return targets;
}

/**
 * The export targets of a manifest, as the files the package publishes.
 *
 * An `exports` map is either a condition map (`{".": {"import": …}}`) or a
 * subpath map (`{".": …, "./sub": …}`). A subpath map publishes every one of
 * its subpaths, so every one of them is part of the runtime surface — a
 * package that only publishes an export map has no other entry point.
 *
 * @param {object} manifest - the package manifest.
 * @returns {string[]} the targets, relative to the package directory.
 */
export function packageExportTargets(manifest) {
    const exportsField = manifest.exports;
    if (exportsField === undefined) return [];
    if (typeof exportsField === "string") return [exportsField];
    if (exportsField === null || typeof exportsField !== "object") return [];
    const keys = Object.keys(exportsField);
    const isSubpathMap = keys.length > 0 && keys.every((key) => key === "." || key.startsWith("./"));
    if (!isSubpathMap) return runtimeExportTargets(exportsField);
    const targets = [];
    for (const key of keys) targets.push(...runtimeExportTargets(exportsField[key]));
    return targets;
}

/**
 * The runtime entry points of one package.
 *
 * @param {string} dir - the package directory inside the tree.
 * @param {object} manifest - the package manifest.
 * @returns {string[]} the entry points, relative to the package directory.
 */
export function packageEntryPoints(dir, manifest) {
    const entries = [];
    if (typeof manifest.main === "string") entries.push(manifest.main);
    if (manifest.exports !== undefined) entries.push(...packageExportTargets(manifest));
    if (typeof manifest.bin === "string") entries.push(manifest.bin);
    else if (manifest.bin !== null && typeof manifest.bin === "object") {
        for (const value of Object.values(manifest.bin)) {
            if (typeof value === "string") entries.push(value);
        }
    }
    return entries;
}

/**
 * Expand one export target into the files of the package it covers.
 *
 * A wildcard target (`./src/*`) covers every file of the package that
 * matches it: those files are part of the package's public surface, so they
 * are runtime material even when nothing imports them today.
 *
 * @param {string} dir - the package directory inside the tree.
 * @param {string} target - the export target.
 * @param {string[]} files - every file of the tree.
 * @returns {string[]} the covered files.
 */
export function expandExportTarget(dir, target, files) {
    if (!target.includes("*")) return [joinPosix(dir, target.replace(/^\.\//, ""))];
    const star = target.indexOf("*");
    const prefix = joinPosix(dir, target.slice(0, star).replace(/^\.\//, ""));
    const suffix = target.slice(star + 1);
    const covered = [];
    for (const file of files) {
        if (!file.startsWith(`${prefix}/`)) continue;
        if (suffix !== "" && !file.endsWith(suffix)) continue;
        covered.push(file);
    }
    return covered;
}

/**
 * Resolve a package subpath against the package's `exports` map.
 *
 * @param {object} manifest - the package manifest.
 * @param {string} subpath - the requested subpath, `.` for the package root.
 * @returns {string | null} the target, relative to the package directory.
 */
export function resolveExports(manifest, subpath) {
    const exportsField = manifest.exports;
    if (exportsField === undefined) return null;
    if (typeof exportsField === "string") return subpath === "." ? exportsField : null;
    if (exportsField === null || typeof exportsField !== "object") return null;
    const keys = Object.keys(exportsField);
    const isSubpathMap = keys.length > 0 && keys.every((key) => key === "." || key.startsWith("./"));
    if (!isSubpathMap) return runtimeExportTargets(exportsField)[0] ?? null;
    if (Object.hasOwn(exportsField, subpath)) return runtimeExportTargets(exportsField[subpath])[0] ?? null;
    for (const key of keys) {
        const star = key.indexOf("*");
        if (star < 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
        if (subpath.length < prefix.length + suffix.length) continue;
        const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
        const target = runtimeExportTargets(exportsField[key])[0];
        if (target === undefined) continue;
        return target.replace(/\*/g, matched);
    }
    return null;
}

/**
 * Split a bare specifier into its package name and subpath.
 *
 * @param {string} specifier - the bare specifier.
 * @returns {{name: string, subpath: string}} the package name and subpath.
 */
export function splitBareSpecifier(specifier) {
    if (specifier.startsWith("@")) {
        const parts = specifier.split("/");
        const name = parts.slice(0, 2).join("/");
        const rest = parts.slice(2).join("/");
        return { name, subpath: rest === "" ? "." : `./${rest}` };
    }
    const slash = specifier.indexOf("/");
    if (slash < 0) return { name: specifier, subpath: "." };
    return { name: specifier.slice(0, slash), subpath: `.${specifier.slice(slash)}` };
}

/**
 * Find the installed copy of a package that a module resolves to.
 *
 * @param {string} from - the importing file inside the tree.
 * @param {string} name - the package name.
 * @param {Map<string, object>} packages - the installed packages.
 * @returns {string | null} the package directory, or null when it is absent.
 */
export function findPackageDir(from, name, packages) {
    let dir = parentOf(from);
    for (;;) {
        const candidate = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
        if (packages.has(candidate)) return candidate;
        if (dir === "") return null;
        dir = parentOf(dir);
    }
}

/**
 * Resolve a module specifier the way Node would.
 *
 * @param {string} specifier - the specifier.
 * @param {string} from - the importing file inside the tree.
 * @param {Map<string, object>} packages - the installed packages.
 * @param {Set<string>} files - every file of the tree.
 * @returns {string[]} the files the specifier can resolve to.
 */
export function resolveSpecifier(specifier, from, packages, files) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const base = specifier.startsWith("/")
            ? specifier.slice(1)
            : joinPosix(parentOf(from), specifier);
        return resolveFileCandidates(base, files);
    }
    if (specifier.startsWith("#")) return [];
    const { name, subpath } = splitBareSpecifier(specifier);
    const dir = findPackageDir(from, name, packages);
    if (dir === null) return [];
    const manifest = packages.get(dir);
    const target = resolveExports(manifest, subpath);
    if (target !== null) return resolveFileCandidates(joinPosix(dir, target.replace(/^\.\//, "")), files);
    if (subpath === ".") {
        if (typeof manifest.main === "string") {
            return resolveFileCandidates(joinPosix(dir, manifest.main.replace(/^\.\//, "")), files);
        }
        return resolveFileCandidates(joinPosix(dir, "index"), files);
    }
    return resolveFileCandidates(joinPosix(dir, subpath.replace(/^\.\//, "")), files);
}

/**
 * The files a path may point at, following Node's extension rules.
 *
 * @param {string} base - the path without extension.
 * @param {Set<string>} files - every file of the tree.
 * @returns {string[]} the existing candidates.
 */
export function resolveFileCandidates(base, files) {
    const found = [];
    for (const extension of EXTENSIONS) {
        const candidate = `${base}${extension}`;
        if (files.has(candidate)) found.push(candidate);
    }
    for (const index of INDEX_FILES) {
        const candidate = `${base}${index}`;
        if (files.has(candidate)) found.push(candidate);
    }
    return found;
}

/**
 * The path-like literals of a source file.
 *
 * @param {string} source - the file content.
 * @returns {string[]} the literals that look like a path.
 */
export function pathLiterals(source) {
    const literals = new Set();
    for (const match of source.matchAll(PATH_LITERAL)) {
        if (match[1].length > 0 && match[1].length < 512) literals.add(match[1]);
    }
    return [...literals];
}

/**
 * The module specifiers of a source file.
 *
 * @param {string} source - the file content.
 * @returns {string[]} the specifiers.
 */
export function moduleSpecifiers(source) {
    const specifiers = new Set();
    for (const pattern of SPECIFIER_PATTERNS) {
        for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
    }
    return [...specifiers];
}

/**
 * The resources a source file loads by URL.
 *
 * @param {string} source - the file content.
 * @returns {string[]} the relative resource paths.
 */
export function urlResources(source) {
    const resources = new Set();
    for (const match of source.matchAll(URL_RESOURCE)) resources.add(match[1]);
    return [...resources];
}

/**
 * The package a file belongs to.
 *
 * @param {string} file - the file inside the tree.
 * @param {Map<string, object>} packages - the installed packages.
 * @returns {string} the package directory.
 */
export function packageOf(file, packages) {
    let dir = parentOf(file);
    for (;;) {
        if (packages.has(dir)) return dir;
        if (dir === "") return "";
        dir = parentOf(dir);
    }
}

/**
 * Analyse a runtime tree: what the runtime can reach, and what it cannot.
 *
 * @param {string} root - the staging root.
 * @returns {object} the analysis: the reachable files, the protected files,
 *   and the files that are provably build material.
 */
export function analyzeRuntimeTree(root) {
    const { files: fileList, packages } = scanRuntimeTree(root);
    const files = new Set(fileList);
    const fileSet = files;

    // The runtime surface: entry points and the files an export target covers.
    const surface = new Set();
    for (const [dir, manifest] of packages) {
        for (const entry of packageEntryPoints(dir, manifest)) {
            for (const file of expandExportTarget(dir, entry, fileList)) surface.add(file);
        }
    }

    // Walk the module graph from the surface.
    const reachable = new Set();
    const queue = [...surface].filter((file) => fileSet.has(file));
    for (const file of queue) reachable.add(file);
    const referenced = new Set();

    while (queue.length > 0) {
        const file = queue.pop();
        if (!/\.(js|mjs|cjs|ts|tsx|mts|cts)$/.test(file)) continue;
        let source = "";
        try {
            source = readFileSync(join(root, file), "utf8");
        } catch {
            source = "";
        }
        const enqueue = (candidate) => {
            if (!fileSet.has(candidate)) return;
            referenced.add(candidate);
            if (reachable.has(candidate)) return;
            reachable.add(candidate);
            queue.push(candidate);
        };
        for (const specifier of moduleSpecifiers(source)) {
            for (const candidate of resolveSpecifier(specifier, file, packages, fileSet)) enqueue(candidate);
        }
        // Resources loaded by URL relative to the module.
        for (const resource of urlResources(source)) {
            if (!resource.startsWith(".")) continue;
            for (const candidate of resolveFileCandidates(joinPosix(parentOf(file), resource), fileSet)) {
                referenced.add(candidate);
            }
        }
        // Resources named by a path-like literal, resolved against the module
        // and against every directory above it.
        const pkgDir = packageOf(file, packages);
        for (const literal of pathLiterals(source)) {
            if (literal.includes("\0")) continue;
            const bases = [parentOf(file)];
            let dir = pkgDir;
            while (dir !== "") {
                bases.push(dir);
                dir = parentOf(dir);
            }
            bases.push("");
            for (const base of bases) {
                const candidate = joinPosix(base, literal.replace(/^\//, ""));
                if (fileSet.has(candidate)) {
                    referenced.add(candidate);
                    break;
                }
            }
        }
    }

    const protectedFiles = new Set([...surface, ...reachable, ...referenced]);
    const removable = new Map();
    for (const file of fileList) {
        const reason = pruneReason(file, protectedFiles);
        if (reason !== null) removable.set(file, reason);
    }

    return { files: fileList, packages, surface, reachable, referenced, protectedFiles, removable };
}

/**
 * Decide whether a file is build material that the runtime never needs.
 *
 * The decision is conservative: a file is only removable when it is
 * unreachable, unreferenced, and belongs to a category that cannot hold
 * runtime data.
 *
 * @param {string} file - the file inside the tree.
 * @param {Set<string>} protectedFiles - the files the runtime can reach.
 * @returns {string | null} the reason the file may be removed, or null.
 */
export function pruneReason(file, protectedFiles) {
    if (protectedFiles.has(file)) return null;
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (name === "package.json") return null;
    if (LICENSE_NAME.test(name)) return null;
    const segments = file.split("/");
    const inResource = segments.slice(0, -1).some((segment) => RESOURCE_SEGMENTS.has(segment));
    const inTest = segments.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment));
    // Type declarations and source maps never carry runtime data, not even
    // inside a directory that holds runtime resources.
    if (DECLARATION.test(file)) return "declaration";
    if (file.endsWith(".map")) return "sourcemap";
    // A directory that holds runtime resources wins over the test
    // classification: a `fixtures`, `locales` or `docs` directory is kept
    // whole, because the harness may load application resources from it by
    // path — a reference the analysis cannot always see. The cost of that
    // choice is a few megabytes of test material; the cost of getting it
    // wrong is a broken install.
    if (inResource) return null;
    if (TEST_FILE.test(file)) return "test-file";
    if (inTest) return "test-directory";
    if (TYPESCRIPT_SOURCE.test(file)) return "typescript-source";
    if (DEBUG_SYMBOLS.test(file)) return "debug-symbols";
    if (FOREIGN_SOURCE.test(file)) return "foreign-source";
    return null;
}

/**
 * Remove the build material of a runtime tree.
 *
 * @param {string} root - the staging root.
 * @param {object} [options] - the options.
 * @param {boolean} [options.dryRun] - report the removals without touching
 *   the tree.
 * @returns {object} the report: the removals per reason, the freed bytes, and
 *   the files that were kept.
 */
export function pruneRuntimeTree(root, options = {}) {
    const dryRun = options.dryRun === true;
    const analysis = analyzeRuntimeTree(root);
    const removals = [];
    let bytes = 0;
    for (const [file, reason] of analysis.removable) {
        const absolute = join(root, file);
        let size = 0;
        try {
            size = lstatSync(absolute).size;
        } catch {
            continue;
        }
        bytes += size;
        removals.push({ file, reason, bytes: size });
        if (!dryRun) rmSync(absolute, { force: true });
    }
    const byReason = new Map();
    for (const removal of removals) {
        const current = byReason.get(removal.reason) ?? { files: 0, bytes: 0 };
        current.files += 1;
        current.bytes += removal.bytes;
        byReason.set(removal.reason, current);
    }
    return {
        dryRun,
        analyzedFiles: analysis.files.length,
        reachableFiles: analysis.reachable.size,
        protectedFiles: analysis.protectedFiles.size,
        removedFiles: removals.length,
        removedBytes: bytes,
        byReason: Object.fromEntries([...byReason].sort((a, b) => b[1].bytes - a[1].bytes)),
        removals,
    };
}
