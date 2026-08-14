/**
 * DeepSeek Harness host discovery and module loading.
 *
 * dsh-acp does not bundle the harness. The user installs DeepSeek Harness
 * themselves (`npm install -g @deepseek-ai/dsh`) and this adapter composes its
 * agent runtime from that installation — the way codex-acp runs the Codex
 * binary the user points it at via `CODEX_PATH`.
 *
 * Resolution order:
 *   1. `--dsh-path` / `DSH_PATH` — a `dsh` binary path, the `@deepseek-ai/dsh`
 *      package directory, an npm prefix, or any directory whose
 *      `node_modules` carries the `@deepseek-ai` scope.
 *   2. This package's own tree (a development checkout with dev dependencies,
 *      or a co-installation that carries the harness packages).
 *   3. `./node_modules` of the invoking directory.
 *   4. `dsh` on PATH — the normal case after `npm install -g @deepseek-ai/dsh`.
 *   5. The global npm root (`npm root -g`).
 *
 * Modules are imported from the resolved tree with Node's ascending
 * `node_modules` walk, honoring package `exports` maps (including subpaths
 * such as `@deepseek-ai/dsh-session/invariant`). Every runtime value comes
 * from the host tree — including cordis itself, so plugin/service identity is
 * never split across two cordis copies.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { logDebug } from "./log.ts";

/** A resolved DeepSeek Harness installation. */
export interface HarnessHost {
    /** Directory from which `@deepseek-ai/*` modules resolve (ascending walk). */
    base: string;
    /** Version of the anchor package the host was validated against. */
    version: string | undefined;
    /** How the host was found (for diagnostics). */
    source: string;
}

export class HarnessNotFoundError extends Error {
    constructor(probed: string[]) {
        super(
            [
                "could not find a DeepSeek Harness installation.",
                "",
                "Install it first:",
                "    npm install -g @deepseek-ai/dsh",
                "",
                "or point dsh-acp at an existing installation:",
                "    DSH_PATH=/path/to/dsh dsh-acp        (dsh binary, package dir, or npm root)",
                "",
                probed.length > 0 ? `Probed:\n${probed.map((p) => `    ${p}`).join("\n")}` : "",
            ]
                .join("\n")
                .trimEnd(),
        );
    }
}

/** The package whose presence marks a usable harness tree. */
const ANCHOR = "@deepseek-ai/dsh-agent";

function packageDirFrom(base: string, name: string): string | undefined {
    // Node's ascending node_modules walk, starting at `base`.
    let dir = resolve(base);
    for (;;) {
        const candidate = join(dir, "node_modules", ...name.split("/"));
        if (existsSync(join(candidate, "package.json"))) return candidate;
        // `base` may itself be a node_modules root or a scope parent.
        const direct = join(dir, ...name.split("/"));
        if (dir.endsWith(`${sep}node_modules`) && existsSync(join(direct, "package.json"))) return direct;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

function versionOf(packageDir: string): string | undefined {
    try {
        const parsed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
            version?: unknown;
        };
        return typeof parsed.version === "string" ? parsed.version : undefined;
    } catch {
        return undefined;
    }
}

function hostAt(base: string, source: string): HarnessHost | undefined {
    const anchor = packageDirFrom(base, ANCHOR);
    if (anchor === undefined) return undefined;
    return { base: resolve(base), version: versionOf(anchor), source };
}

/** Interpret an explicit --dsh-path/DSH_PATH value (binary, package dir, prefix…). */
function hostFromExplicit(explicit: string): HarnessHost | undefined {
    const path = resolve(explicit);
    const bases: string[] = [];
    let stat: "file" | "dir" | undefined;
    try {
        stat = realpathSync(path) !== undefined && existsSync(join(path, ".")) ? "dir" : "file";
    } catch {
        stat = undefined;
    }
    if (existsSync(path)) {
        // A file is taken to be the dsh launcher: resolve symlinks (npm bin
        // links live outside the package) and walk up from the real script.
        try {
            const real = realpathSync(path);
            stat = real === path && existsSync(join(path, "package.json")) ? "dir" : stat;
            bases.push(dirname(real));
        } catch {
            bases.push(dirname(path));
        }
        bases.push(path, join(path, "node_modules"), join(path, "lib", "node_modules"));
    }
    for (const base of bases) {
        const host = hostAt(base, `--dsh-path/DSH_PATH (${explicit})`);
        if (host !== undefined) return host;
    }
    return undefined;
}

function hostFromPathLookup(): HarnessHost | undefined {
    const pathEnv = process.env["PATH"] ?? "";
    for (const dir of pathEnv.split(delimiter)) {
        if (dir.length === 0) continue;
        const candidate = join(dir, "dsh");
        if (!existsSync(candidate)) continue;
        try {
            const real = realpathSync(candidate);
            const host = hostAt(dirname(real), `dsh on PATH (${candidate})`);
            if (host !== undefined) return host;
        } catch {
            continue;
        }
    }
    return undefined;
}

function hostFromGlobalNpm(): HarnessHost | undefined {
    try {
        const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim();
        if (root.length > 0 && isAbsolute(root)) return hostAt(root, `npm root -g (${root})`);
    } catch {
        // npm unavailable; fine.
    }
    return undefined;
}

/**
 * Find a harness installation.
 *
 * @throws HarnessNotFoundError with the probed locations when nothing matches.
 */
export function resolveHost(explicit?: string): HarnessHost {
    const probed: string[] = [];
    if (explicit !== undefined) {
        const host = hostFromExplicit(explicit);
        if (host !== undefined) return host;
        probed.push(`--dsh-path/DSH_PATH: ${explicit}`);
        // An explicit path that does not resolve is an error, not a fallback:
        // silently using another installation would be worse than failing.
        throw new HarnessNotFoundError(probed);
    }
    const local = hostAt(process.cwd(), `invoking directory (${process.cwd()})`);
    if (local !== undefined) return local;
    probed.push(`invoking directory: ${process.cwd()}`);
    const onPath = hostFromPathLookup();
    if (onPath !== undefined) return onPath;
    probed.push("dsh on PATH");
    const globalNpm = hostFromGlobalNpm();
    if (globalNpm !== undefined) return globalNpm;
    probed.push("npm root -g");
    // Last: this package's own tree — the vendored @deepseek-ai/dsh
    // dependency. A dsh the user installed always wins (their Web UI and
    // this server then run the same code over the shared $DSH_HOME); the
    // vendored copy makes a machine without dsh work out of the box.
    const own = hostAt(dirname(fileURLToPath(import.meta.url)), "dsh-acp package tree (vendored)");
    if (own !== undefined) return own;
    probed.push("dsh-acp package tree (vendored)");
    throw new HarnessNotFoundError(probed);
}

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

type ModuleNamespace = Record<string, unknown>;

function entryFile(packageDir: string, subpath: string | undefined): string {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
        exports?: unknown;
        main?: unknown;
    };
    const key = subpath === undefined ? "." : `./${subpath}`;
    const exportsMap = manifest.exports;
    let target: unknown;
    if (typeof exportsMap === "string") {
        if (key === ".") target = exportsMap;
    } else if (exportsMap !== null && typeof exportsMap === "object") {
        const entry = (exportsMap as Record<string, unknown>)[key];
        target = entry;
    }
    // Conditional exports: prefer import > default.
    if (target !== null && typeof target === "object") {
        const conditions = target as Record<string, unknown>;
        target = conditions["import"] ?? conditions["default"] ?? conditions["node"];
        if (target !== null && typeof target === "object") {
            const nested = target as Record<string, unknown>;
            target = nested["default"] ?? nested["import"];
        }
    }
    if (typeof target !== "string" && key === "." && typeof manifest.main === "string") {
        target = manifest.main;
    }
    if (typeof target !== "string") {
        throw new Error(`cannot resolve entry ${key} of ${packageDir}`);
    }
    return join(packageDir, target);
}

/**
 * Import one module from the host installation.
 *
 * @param specifier - e.g. `@deepseek-ai/dsh-llm` or `@deepseek-ai/dsh-session/invariant`.
 */
export async function loadHostModule(host: HarnessHost, specifier: string): Promise<ModuleNamespace> {
    const [scope, packageName, ...rest] = specifier.split("/");
    if (scope === undefined || packageName === undefined) throw new Error(`invalid specifier: ${specifier}`);
    const name = `${scope}/${packageName}`;
    const packageDir = packageDirFrom(host.base, name);
    if (packageDir === undefined) {
        throw new Error(
            `the DeepSeek Harness installation at ${host.base} (${host.source}) does not provide ${name}; ` +
                "update it with: npm install -g @deepseek-ai/dsh",
        );
    }
    const file = entryFile(packageDir, rest.length > 0 ? rest.join("/") : undefined);
    logDebug(`loading ${specifier} from ${file}`);
    return (await import(pathToFileURL(file).href)) as ModuleNamespace;
}

// ---------------------------------------------------------------------------
// The kit: every harness module the composition and bridge need
// ---------------------------------------------------------------------------

/** Type-only views of the host modules (erased at build; values are dynamic). */
export interface HarnessKit {
    host: HarnessHost;
    /** Host cordis: `new kit.cordis.Context()`. */
    cordis: typeof import("@deepseek-ai/cordis");
    llm: typeof import("@deepseek-ai/dsh-llm");
    session: typeof import("@deepseek-ai/dsh-session");
    sessionTitle: typeof import("@deepseek-ai/dsh-session-title");
    sandboxPolicy: typeof import("@deepseek-ai/dsh-sandbox-policy");
    /** Plugin modules keyed by short name; passed to `ctx.plugin` as-is or via `.default`. */
    plugins: Record<string, ModuleNamespace>;
}

/** Plugin modules loaded for the composition, keyed by short name. */
export const PLUGIN_SPECIFIERS = {
    timer: "@deepseek-ai/cordis-plugin-timer",
    llmRuntime: "@deepseek-ai/dsh-llm",
    sessionStore: "@deepseek-ai/dsh-session",
    sessionTitle: "@deepseek-ai/dsh-session-title",
    systemPrompt: "@deepseek-ai/dsh-system-prompt",
    tools: "@deepseek-ai/dsh-tools",
    agents: "@deepseek-ai/dsh-agent",
    agentLoop: "@deepseek-ai/dsh-agent-loop",
    llmRetry: "@deepseek-ai/dsh-llm-retry",
    jobs: "@deepseek-ai/dsh-jobs-local",
    invariants: "@deepseek-ai/dsh-invariants",
    sessionInvariant: "@deepseek-ai/dsh-session/invariant",
    agentInvariant: "@deepseek-ai/dsh-agent/invariant",
    scopeInvariant: "@deepseek-ai/dsh-scope/invariant",
    agentLoopInvariant: "@deepseek-ai/dsh-agent-loop/invariant",
    homePaths: "@deepseek-ai/dsh-home-paths",
    bashEnv: "@deepseek-ai/dsh-shell-env",
    toolBash: "@deepseek-ai/dsh-tool-bash",
    workspaceContext: "@deepseek-ai/dsh-agent-instructions",
    llmDeepseek: "@deepseek-ai/dsh-llm-deepseek",
    persistence: "@deepseek-ai/dsh-session-persistence-jsonl",
    checkpoints: "@deepseek-ai/dsh-session-checkpoint-policy",
    sandbox: "@deepseek-ai/dsh-sandbox-local",
    sandboxPolicy: "@deepseek-ai/dsh-sandbox-policy",
    subprocess: "@deepseek-ai/dsh-subprocess-local",
    bash: "@deepseek-ai/dsh-bash-sandbox",
    approval: "@deepseek-ai/dsh-user-approval",
    fs: "@deepseek-ai/dsh-fs-sandbox",
    fsObservationPolicy: "@deepseek-ai/dsh-fs-observation-policy",
    toolFs: "@deepseek-ai/dsh-tool-fs",
    toolTodo: "@deepseek-ai/dsh-tool-todo",
    tokenMeter: "@deepseek-ai/dsh-token-meter",
    compaction: "@deepseek-ai/dsh-compaction-basic",
} as const;

/** Optional host modules: mounted when the installation provides them. */
export const OPTIONAL_PLUGIN_SPECIFIERS = {
    credentials: "@deepseek-ai/dsh-credentials-local",
    credentialsSeam: "@deepseek-ai/dsh-credentials",
    mcpClient: "@deepseek-ai/dsh-mcp-client",
} as const;

export type PluginKey = keyof typeof PLUGIN_SPECIFIERS;

/**
 * Load every module the composition needs from the host, in parallel.
 */
export async function loadKit(host: HarnessHost): Promise<HarnessKit> {
    const keys = Object.keys(PLUGIN_SPECIFIERS) as PluginKey[];
    const optionalKeys = Object.keys(OPTIONAL_PLUGIN_SPECIFIERS) as (keyof typeof OPTIONAL_PLUGIN_SPECIFIERS)[];
    const [cordis, ...pluginModules] = await Promise.all([
        loadHostModule(host, "@deepseek-ai/cordis"),
        ...keys.map((key) => loadHostModule(host, PLUGIN_SPECIFIERS[key])),
        ...optionalKeys.map((key) =>
            loadHostModule(host, OPTIONAL_PLUGIN_SPECIFIERS[key]).catch((error: unknown) => {
                logDebug(`optional module ${OPTIONAL_PLUGIN_SPECIFIERS[key]} unavailable: ${String(error)}`);
                return undefined;
            }),
        ),
    ]);
    const plugins: Record<string, ModuleNamespace> = {};
    [...keys, ...optionalKeys].forEach((key, index) => {
        const module = pluginModules[index];
        if (module !== undefined) plugins[key] = module;
    });
    return {
        host,
        cordis: cordis as unknown as HarnessKit["cordis"],
        llm: plugins["llmRuntime"] as unknown as HarnessKit["llm"],
        session: plugins["sessionStore"] as unknown as HarnessKit["session"],
        sessionTitle: plugins["sessionTitle"] as unknown as HarnessKit["sessionTitle"],
        sandboxPolicy: plugins["sandboxPolicy"] as unknown as HarnessKit["sandboxPolicy"],
        plugins,
    };
}

/** `.default` when present (class/service plugins), else the namespace. */
export function pluginOf(module: ModuleNamespace): unknown {
    return module["default"] ?? module;
}
