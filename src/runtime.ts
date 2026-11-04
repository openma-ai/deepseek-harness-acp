import { createHash } from "node:crypto";
import {
    closeSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

import { logInfo } from "./log.ts";

interface RuntimeMetadata {
    archive: string;
    dsh: string;
    sha256: string;
    externalPackages?: Record<string, string>;
}

export function copyExternalPackages(packageRoot: string, runtimeRoot: string, packages: Record<string, string>): void {
    for (const [name, version] of Object.entries(packages)) {
        if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name)) throw new Error(`Invalid external package: ${name}`);
        let parent = resolve(packageRoot);
        let source: string | undefined;
        for (;;) {
            const candidate = join(parent, "node_modules", name);
            if (existsSync(join(candidate, "package.json"))) {
                source = candidate;
                break;
            }
            const next = dirname(parent);
            if (next === parent) break;
            parent = next;
        }
        if (source === undefined) continue; // npm may omit an unsupported optional platform package.
        const installed = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { version?: string };
        if (installed.version !== version) throw new Error(`External package version mismatch: ${name}`);
        cpSync(source, join(runtimeRoot, "node_modules", name), { recursive: true });
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

function readMetadata(packageRoot: string): RuntimeMetadata | undefined {
    try {
        const parsed = JSON.parse(readFileSync(join(packageRoot, "vendor/runtime.json"), "utf8")) as Partial<RuntimeMetadata>;
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

/**
 * Hash the large vendored archive in fixed-size chunks. `readFileSync` would
 * also work, but it materializes the whole tarball in memory on the cold boot
 * path that already competes with extraction for RAM. The caller is
 * synchronous (`resolveHost` runs before ACP listen), so chunked `readSync`
 * is used instead of `createReadStream`; peak memory is the same.
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

function formatMiB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Materialize the immutable standalone DSH runtime shipped inside the npm
 * tarball. Plugin entrypoints never import this module, so a Host-installed
 * ACP plugin cannot load or register the private runtime.
 */
export function resolveVendoredRuntime(): string | undefined {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const metadata = readMetadata(packageRoot);
    if (metadata === undefined) return undefined;
    const archive = join(packageRoot, "vendor", metadata.archive);
    if (!existsSync(archive)) return undefined;

    const target = join(cacheRoot(), `${metadata.dsh}-${metadata.sha256.slice(0, 12)}`);
    const marker = join(target, ".dsh-acp-runtime");
    if (existsSync(marker)) return target;

    const started = Date.now();
    const elapsed = () => `${Date.now() - started}ms`;
    mkdirSync(dirname(target), { recursive: true });
    logInfo(`bundled runtime: materializing @deepseek-ai/dsh ${metadata.dsh} (archive ${formatMiB(statSync(archive).size)})`);
    const actual = sha256FileSync(archive);
    if (actual !== metadata.sha256) throw new Error(`bundled DSH runtime integrity check failed: ${archive}`);
    logInfo(`bundled runtime: integrity verified in ${elapsed()}`);

    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    const temporary = mkdtempSync(join(dirname(target), ".extract-"));
    try {
        logInfo(`bundled runtime: extracting bundle archive in ${elapsed()}`);
        tar.x({ cwd: temporary, file: archive, sync: true, strict: true });
        logInfo(`bundled runtime: archive extracted in ${elapsed()}`);
        copyExternalPackages(packageRoot, temporary, metadata.externalPackages ?? {});
        logInfo(`bundled runtime: external packages copied in ${elapsed()}`);
        writeFileSync(join(temporary, ".dsh-acp-runtime"), `${metadata.dsh}\n`);
        try {
            renameSync(temporary, target);
        } catch (error: unknown) {
            if (!existsSync(marker)) throw error;
        }
        logInfo(`bundled runtime: cache ready at ${target} after ${elapsed()}`);
    } finally {
        if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    }
    return target;
}
