/**
 * Standalone DeepSeek Harness runtime acquisition.
 *
 * The npm shell ships *without* the private runtime: a dsh plugin install
 * must stay light and must never download or load it. The standalone launcher
 * therefore acquires the pinned runtime on demand and caches it, exactly as
 * before, but from an explicit, ordered list of sources:
 *
 *   1. the materialized cache for the pinned sha256 — offline after the first
 *      successful start;
 *   2. `DSH_ACP_RUNTIME_TARBALL` — a local runtime archive (prefetch, CI, or
 *      an artifact that was never published);
 *   3. the archive still sitting in the installed package (`vendor/`), as
 *      produced by `npm run runtime:pack` or placed there by an operator;
 *   4. `DSH_ACP_RUNTIME_PACK` — a locally packed runtime package;
 *   5. the pinned `@openma/deepseek-harness-acp-runtime@<version>` npm
 *      package. Never `latest`, never an ambient install.
 *
 * The runtime is never taken from PATH, the invoking directory, or a global
 * npm install: an unrelated dsh must never hijack the runtime an embedder
 * pinned (Martty issue #157).
 *
 * The archive is verified against the sha256 recorded in `vendor/runtime.json`
 * before anything is written to the cache, and the native packages pruned
 * from the archive (libreoffice-kit, sherpa-onnx) are fetched for the host
 * platform only, at the exact locked versions.
 *
 * Plugin entrypoints never import this module, so a Host-installed ACP plugin
 * cannot load or register the private runtime.
 */

import { createHash } from "node:crypto";
import {
    closeSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

import { logDebug, logInfo, logWarn } from "./log.ts";

/** The npm package the standalone launcher acquires the runtime archive from. */
export const RUNTIME_PACKAGE_NAME = "@openma/deepseek-harness-acp-runtime";

/** The marker that identifies a completely materialized runtime tree. */
const MARKER = ".dsh-acp-runtime";

/** How long a first start may wait for another process to finish. */
const LOCK_TIMEOUT_MS = 20 * 60_000;
/** A lock older than this is considered abandoned and is broken. */
const LOCK_STALE_MS = 60 * 60_000;

/** A native package pruned from the runtime archive. */
export interface ExternalPackage {
    version: string;
    integrity?: string;
    os?: string[];
    cpu?: string[];
}

/** The pinned runtime manifest shipped with the shell (`vendor/runtime.json`). */
export interface RuntimeMetadata {
    /** File name of the runtime archive inside the runtime package. */
    archive: string;
    /** The exact `@deepseek-ai/dsh` version the runtime carries. */
    dsh: string;
    /** sha256 of the runtime archive. */
    sha256: string;
    /** Native packages pruned from the archive, per platform. */
    externalPackages?: Record<string, ExternalPackage>;
    /** The npm package the runtime archive is published as. */
    runtimePackage?: { name: string; version: string };
}

/** The runtime could not be acquired; the message says how to fix it. */
export class RuntimeUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RuntimeUnavailableError";
    }
}

function envString(name: string): string | undefined {
    const value = process.env[name];
    return value !== undefined && value.length > 0 ? value : undefined;
}

/** The installed package root (the directory carrying `package.json`). */
function packageRoot(): string {
    return dirname(dirname(fileURLToPath(import.meta.url)));
}

function readMetadata(root: string): RuntimeMetadata | undefined {
    try {
        const parsed = JSON.parse(readFileSync(join(root, "vendor/runtime.json"), "utf8")) as Partial<RuntimeMetadata>;
        if (
            typeof parsed.archive !== "string"
            || typeof parsed.dsh !== "string"
            || typeof parsed.sha256 !== "string"
        ) return undefined;
        return parsed as RuntimeMetadata;
    } catch {
        return undefined;
    }
}

/** The shell version, used when the manifest does not name the runtime package. */
function shellVersion(root: string): string | undefined {
    try {
        const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" ? parsed.version : undefined;
    } catch {
        return undefined;
    }
}

function cacheRoot(): string {
    const explicit = process.env["DSH_ACP_CACHE_DIR"];
    if (explicit !== undefined && explicit.length > 0) return explicit;
    if (process.platform === "win32") {
        const local = process.env["LOCALAPPDATA"];
        if (local !== undefined && local.length > 0) return join(local, "dsh-acp");
    }
    const xdg = process.env["XDG_CACHE_HOME"];
    return join(xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".cache"), "dsh-acp");
}

/** The materialized runtime tree for one pinned archive. */
function cacheTarget(metadata: RuntimeMetadata): string {
    return join(cacheRoot(), `${metadata.dsh}-${metadata.sha256.slice(0, 12)}`);
}

function isMaterialized(target: string): boolean {
    return existsSync(join(target, MARKER));
}

/**
 * Hash the large runtime archive in fixed-size chunks. `readFileSync` would
 * also work, but it materializes the whole tarball in memory on the cold boot
 * path that already competes with extraction for RAM.
 */
function sha256FileSync(path: string): string {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = openSync(path, "r");
    try {
        for (;;) {
            const read = readSync(fd, buffer, 0, buffer.length, null);
            if (read === 0) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        closeSync(fd);
    }
    return hash.digest("hex");
}

/** Verify a downloaded tarball against a registry/lockfile integrity string. */
function verifyIntegrity(bytes: Buffer, integrity: string): void {
    const valid = integrity.split(/\s+/).some((entry) => {
        const separator = entry.indexOf("-");
        if (separator < 0) return false;
        const algorithm = entry.slice(0, separator);
        if (!["sha512", "sha384", "sha256", "sha1"].includes(algorithm)) return false;
        return createHash(algorithm).update(bytes).digest("base64") === entry.slice(separator + 1);
    });
    if (!valid) throw new Error("integrity mismatch");
}

/** The registry the runtime package and the native packages are fetched from. */
function registryBase(): string {
    const explicit = envString("DSH_ACP_REGISTRY");
    if (explicit !== undefined) return explicit.replace(/\/+$/, "");
    const configured = envString("npm_config_registry");
    if (configured !== undefined) return configured.replace(/\/+$/, "");
    return "https://registry.npmjs.org";
}

/** The registry URL of one package version. */
function packumentUrl(name: string, version: string): string {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@").replace(/%2F/g, "%2f");
    return `${registryBase()}/${encoded}/${version}`;
}

/** The registry URL of one package tarball. */
function tarballUrl(name: string, version: string): string {
    const bare = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
    return `${registryBase()}/${name}/-/${bare}-${version}.tgz`;
}

function formatMiB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Take an exclusive lock around the download + verify + extract window.
 *
 * The lock is an exclusively created file: the first process to create it
 * owns the acquisition, the others wait and then reuse its cache. A lock
 * left behind by a killed process is broken once it goes stale.
 */
async function acquireLock(lockPath: string): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            const fd = openSync(lockPath, "wx");
            try {
                writeFileSync(fd, `${process.pid}\n`);
            } finally {
                closeSync(fd);
            }
            return;
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
                // The cache directory vanished under us: recreate it and retry.
                mkdirSync(dirname(lockPath), { recursive: true });
                continue;
            }
            if (code !== "EEXIST") throw error;
            try {
                if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
                    logWarn(`breaking a stale runtime lock: ${lockPath}`);
                    rmSync(lockPath, { force: true });
                    continue;
                }
            } catch {
                continue; // the lock vanished between the two calls
            }
            if (Date.now() > deadline) {
                throw new RuntimeUnavailableError(
                    `timed out after ${Math.round(LOCK_TIMEOUT_MS / 1000)}s waiting for another process to prepare the runtime (${lockPath})`,
                );
            }
            await sleep(250);
        }
    }
}

async function withRuntimeLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = join(dirname(target), `.${basename(target)}.lock`);
    await acquireLock(lockPath);
    try {
        return await fn();
    } finally {
        rmSync(lockPath, { force: true });
    }
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

/** A runtime archive on disk, plus the temporaries that produced it. */
interface ArchiveSource {
    path: string;
    cleanup: string[];
    origin: string;
}

/**
 * Check the manifest a runtime package carries against the pinned one.
 *
 * The two artifacts are paired by version; a mismatch means the wrong
 * artifact was handed over, which must not be booted.
 */
function assertMatchingManifest(embedded: string | undefined, metadata: RuntimeMetadata, origin: string): void {
    if (embedded === undefined) return;
    let parsed: Partial<RuntimeMetadata>;
    try {
        parsed = JSON.parse(embedded) as Partial<RuntimeMetadata>;
    } catch {
        throw new RuntimeUnavailableError(`the runtime manifest in ${origin} is not valid JSON`);
    }
    if (parsed.dsh !== metadata.dsh || parsed.sha256 !== metadata.sha256) {
        throw new RuntimeUnavailableError(
            `the runtime package in ${origin} does not match the pinned runtime `
            + `(package: dsh ${String(parsed.dsh)} / sha256 ${String(parsed.sha256)}, `
            + `pinned: dsh ${metadata.dsh} / sha256 ${metadata.sha256})`,
        );
    }
}

/** Extract the runtime archive out of a packed runtime package. */
async function extractArchiveFromPackage(pack: string, metadata: RuntimeMetadata): Promise<{ archive: string; temporary?: string }> {
    // An unpacked runtime package directory.
    if (existsSync(join(pack, "package.json"))) {
        const direct = join(pack, metadata.archive);
        if (!existsSync(direct)) {
            throw new RuntimeUnavailableError(`the runtime package directory ${pack} does not contain ${metadata.archive}`);
        }
        const manifest = join(pack, "runtime.json");
        assertMatchingManifest(
            existsSync(manifest) ? readFileSync(manifest, "utf8") : undefined,
            metadata,
            pack,
        );
        return { archive: direct };
    }
    if (!existsSync(pack)) {
        throw new RuntimeUnavailableError(`DSH_ACP_RUNTIME_PACK does not exist: ${pack}`);
    }
    const staging = mkdtempSync(join(tmpdir(), "dsh-acp-runtime-pack-"));
    try {
        tar.x({
            cwd: staging,
            file: pack,
            sync: true,
            strict: true,
            filter: (path) => path === `package/${metadata.archive}` || path === "package/runtime.json",
        });
        const archive = join(staging, "package", metadata.archive);
        if (!existsSync(archive)) {
            throw new RuntimeUnavailableError(`the runtime package ${pack} does not contain ${metadata.archive}`);
        }
        const manifest = join(staging, "package", "runtime.json");
        assertMatchingManifest(
            existsSync(manifest) ? readFileSync(manifest, "utf8") : undefined,
            metadata,
            pack,
        );
        return { archive, temporary: staging };
    } catch (error: unknown) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
}

/** Download the pinned runtime package and extract the archive it carries. */
async function fetchRuntimeArchive(metadata: RuntimeMetadata, root: string): Promise<ArchiveSource> {
    const name = metadata.runtimePackage?.name ?? RUNTIME_PACKAGE_NAME;
    const version = metadata.runtimePackage?.version ?? shellVersion(root);
    if (version === undefined) {
        throw new RuntimeUnavailableError(
            "the pinned runtime package version is unknown; reinstall @openma/deepseek-harness-acp",
        );
    }
    const url = packumentUrl(name, version);
    logInfo(`standalone runtime: fetching ${name}@${version}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        throw new RuntimeUnavailableError(`cannot fetch ${name}@${version} from ${registryBase()}: HTTP ${response.status}`);
    }
    const packument = await response.json() as {
        dist?: { tarball?: string; integrity?: string };
    };
    const tarball = packument.dist?.tarball;
    if (typeof tarball !== "string") {
        throw new RuntimeUnavailableError(`${name}@${version} has no published tarball`);
    }
    const archiveResponse = await fetch(tarball, { signal: AbortSignal.timeout(300_000) });
    if (!archiveResponse.ok) {
        throw new RuntimeUnavailableError(
            `cannot download ${name}@${version} from ${tarball}: HTTP ${archiveResponse.status}`,
        );
    }
    const bytes = Buffer.from(await archiveResponse.arrayBuffer());
    if (typeof packument.dist?.integrity === "string") {
        verifyIntegrity(bytes, packument.dist.integrity);
    }
    const staging = mkdtempSync(join(tmpdir(), "dsh-acp-runtime-fetch-"));
    try {
        const packageArchive = join(staging, "package.tgz");
        writeFileSync(packageArchive, bytes);
        tar.x({
            cwd: staging,
            file: packageArchive,
            sync: true,
            strict: true,
            filter: (path) => path === `package/${metadata.archive}` || path === "package/runtime.json",
        });
        const archive = join(staging, "package", metadata.archive);
        if (!existsSync(archive)) {
            throw new RuntimeUnavailableError(`${name}@${version} does not contain ${metadata.archive}`);
        }
        const manifest = join(staging, "package", "runtime.json");
        assertMatchingManifest(
            existsSync(manifest) ? readFileSync(manifest, "utf8") : undefined,
            metadata,
            `${name}@${version}`,
        );
        return { path: archive, cleanup: [staging], origin: `${name}@${version}` };
    } catch (error: unknown) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
}

/** Locate the runtime archive, in the documented order of preference. */
async function acquireArchive(metadata: RuntimeMetadata, root: string): Promise<ArchiveSource> {
    // 1. An explicit local archive always wins: it is how a prefetch, a CI
    //    run, or an operator hands over an artifact that was never published.
    const local = envString("DSH_ACP_RUNTIME_TARBALL");
    if (local !== undefined) {
        if (!existsSync(local)) {
            throw new RuntimeUnavailableError(`DSH_ACP_RUNTIME_TARBALL does not exist: ${local}`);
        }
        return { path: resolve(local), cleanup: [], origin: `DSH_ACP_RUNTIME_TARBALL (${local})` };
    }
    // 2. The archive still shipped in the installed package.
    const inTree = join(root, "vendor", metadata.archive);
    if (existsSync(inTree)) {
        return { path: inTree, cleanup: [], origin: `the installed package (${inTree})` };
    }
    // 3. A locally packed runtime package.
    const pack = envString("DSH_ACP_RUNTIME_PACK");
    if (pack !== undefined) {
        const extracted = await extractArchiveFromPackage(resolve(pack), metadata);
        return {
            path: extracted.archive,
            cleanup: extracted.temporary !== undefined ? [extracted.temporary] : [],
            origin: `DSH_ACP_RUNTIME_PACK (${pack})`,
        };
    }
    // 4. The pinned runtime package from the registry.
    return await fetchRuntimeArchive(metadata, root);
}

// ---------------------------------------------------------------------------
// Native packages
// ---------------------------------------------------------------------------

/** Whether a pruned native package applies to the host platform. */
function matchesPlatform(pkg: ExternalPackage): boolean {
    if (pkg.os !== undefined && !pkg.os.includes(process.platform)) return false;
    if (pkg.cpu !== undefined && !pkg.cpu.includes(process.arch)) return false;
    return true;
}

/** Install one pruned native package into the runtime tree. */
async function installExternalPackage(name: string, pkg: ExternalPackage, runtimeRoot: string): Promise<void> {
    const response = await fetch(tarballUrl(name, pkg.version), { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (pkg.integrity !== undefined) {
        verifyIntegrity(bytes, pkg.integrity);
    } else {
        logWarn(`no locked integrity for ${name}@${pkg.version}; installing it unverified`);
    }
    const destination = join(runtimeRoot, "node_modules", ...name.split("/"));
    mkdirSync(destination, { recursive: true });
    const staging = mkdtempSync(join(tmpdir(), "dsh-acp-native-"));
    try {
        const archive = join(staging, "package.tgz");
        writeFileSync(archive, bytes);
        tar.x({ cwd: destination, file: archive, strip: 1, sync: true, strict: true });
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
    const installed = JSON.parse(readFileSync(join(destination, "package.json"), "utf8")) as { version?: string };
    if (installed.version !== pkg.version) {
        throw new Error(`installed ${String(installed.version)}, expected ${pkg.version}`);
    }
}

/**
 * Install the native packages the host platform needs.
 *
 * They are pruned from the runtime archive so the artifact stays small and
 * platform-neutral; npm used to provide them as optional dependencies of the
 * shell, which a plugin install would have downloaded. The standalone
 * launcher now fetches the matching ones itself, at the exact locked
 * versions. A failure is a warning, not a fatal error: the runtime boots
 * without the optional office and speech binaries.
 */
async function installExternalPackages(metadata: RuntimeMetadata, runtimeRoot: string): Promise<void> {
    for (const [name, pkg] of Object.entries(metadata.externalPackages ?? {})) {
        // A manifest written before the split recorded only the version; the
        // platform is unknown then, and installing every platform's binary
        // would be worse than skipping it.
        const record = pkg as ExternalPackage | string;
        if (typeof record === "string") {
            logWarn(`native package ${name} has no platform information in the pinned manifest; skipping it`);
            continue;
        }
        if (!matchesPlatform(record)) continue;
        try {
            await installExternalPackage(name, record, runtimeRoot);
        } catch (error: unknown) {
            logWarn(`native package ${name}@${record.version} could not be installed: ${String(error)}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

/** Verify, extract, and mark the runtime tree. */
async function materialize(metadata: RuntimeMetadata, source: ArchiveSource, target: string): Promise<void> {
    const started = Date.now();
    const elapsed = () => `${Date.now() - started}ms`;
    logInfo(
        `standalone runtime: preparing @deepseek-ai/dsh ${metadata.dsh} from ${source.origin} `
        + `(${formatMiB(statSync(source.path).size)})`,
    );
    const actual = sha256FileSync(source.path);
    if (actual !== metadata.sha256) {
        throw new RuntimeUnavailableError(
            `integrity check failed for the standalone runtime archive (${source.origin}): `
            + `expected sha256 ${metadata.sha256}, got ${actual}`,
        );
    }
    logInfo(`standalone runtime: integrity verified in ${elapsed()}`);

    const parent = dirname(target);
    mkdirSync(parent, { recursive: true });
    // Recover from an interrupted extraction: drop the leftovers and any
    // target that was never marked as complete.
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    for (const entry of readdirSync(parent)) {
        if (entry.startsWith(".extract-")) rmSync(join(parent, entry), { recursive: true, force: true });
    }
    const temporary = mkdtempSync(join(parent, ".extract-"));
    try {
        logInfo(`standalone runtime: extracting in ${elapsed()}`);
        tar.x({ cwd: temporary, file: source.path, sync: true, strict: true });
        if (!existsSync(join(temporary, "node_modules", "@deepseek-ai", "dsh", "package.json"))) {
            throw new RuntimeUnavailableError(
                `the runtime archive from ${source.origin} does not contain a DeepSeek Harness tree; `
                + "DSH_ACP_RUNTIME_TARBALL expects the runtime archive, not a packed runtime package "
                + "(use DSH_ACP_RUNTIME_PACK for that)",
            );
        }
        logInfo(`standalone runtime: archive extracted in ${elapsed()}`);
        await installExternalPackages(metadata, temporary);
        writeFileSync(join(temporary, MARKER), `${metadata.dsh}\n`);
        try {
            renameSync(temporary, target);
        } catch (error: unknown) {
            // A concurrent process may have completed the same runtime.
            if (!existsSync(join(target, MARKER))) throw error;
        }
        logInfo(`standalone runtime: ready at ${target} after ${elapsed()}`);
    } finally {
        if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    }
}

/**
 * Materialize the pinned standalone runtime and return its tree.
 *
 * The result is cached under `DSH_ACP_CACHE_DIR` (or the platform cache) as
 * `<dsh>-<sha256 prefix>`, marked with `.dsh-acp-runtime`. A warm cache is
 * reused without any network access.
 *
 * @param root - the package root carrying `vendor/runtime.json`; defaults to
 *   the installed package. Tests point it at a fixture tree.
 * @throws RuntimeUnavailableError when the runtime cannot be acquired.
 */
export async function resolveStandaloneRuntime(root: string = packageRoot()): Promise<string> {
    const metadata = readMetadata(root);
    if (metadata === undefined) {
        throw new RuntimeUnavailableError(
            "the pinned runtime manifest (vendor/runtime.json) is missing from this package; "
            + "reinstall @openma/deepseek-harness-acp",
        );
    }
    const target = cacheTarget(metadata);
    if (isMaterialized(target)) {
        logDebug(`standalone runtime: reusing ${target}`);
        return target;
    }
    // The lock lives next to the cache tree: the directory must exist first.
    mkdirSync(dirname(target), { recursive: true });
    return await withRuntimeLock(target, async () => {
        // Another process may have finished while we waited for the lock.
        if (isMaterialized(target)) {
            logDebug(`standalone runtime: reusing ${target} (prepared by another process)`);
            return target;
        }
        const source = await acquireArchive(metadata, root);
        try {
            await materialize(metadata, source, target);
        } finally {
            for (const path of source.cleanup) rmSync(path, { recursive: true, force: true });
        }
        return target;
    });
}

/**
 * Acquire the runtime ahead of the first start (`dsh-acp --prefetch-runtime`).
 *
 * It never boots a host: it only warms the cache, so that the first real
 * start works without network access.
 */
export async function prefetchStandaloneRuntime(): Promise<string> {
    const target = await resolveStandaloneRuntime();
    logInfo(`standalone runtime ready: ${target}`);
    return target;
}
