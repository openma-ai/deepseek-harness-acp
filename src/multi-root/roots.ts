/**
 * Additional-root vocabulary: what makes an ACP `additionalDirectories` entry
 * legal, how it is canonicalized, and which roots actually widen one call's
 * writable set.
 *
 * The bridge validates client input here before any agent exists; the sandbox
 * and filesystem providers re-run the cheap parts per call because a root can
 * disappear (or be replaced by a symlink) between session creation and use.
 * All spellings that reach an enforcement layer are canonical, so the
 * containment comparisons and the argv/profile grants agree.
 *
 * @module dsh-acp/multi-root/roots
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

/** Stable reasons one additional-directory entry was refused. */
export type RootValidationCode =
    | "not-an-array"
    | "not-a-string"
    | "not-absolute"
    | "missing"
    | "not-a-directory"
    | "duplicate"
    | "equals-primary"
    | "unsupported-path";

/** A rejected additional-directory entry, with a message suitable for -32602. */
export class RootValidationError extends Error {
    readonly code: RootValidationCode;

    constructor(code: RootValidationCode, message: string) {
        super(message);
        this.name = "RootValidationError";
        this.code = code;
    }
}

/** Canonicalize a path the way the enforcement layers do (`realpath`). */
export function canonicalRoot(path: string): string {
    try {
        return realpathSync.native(path);
    } catch {
        return path;
    }
}

/**
 * Whether a Windows spelling names a network or device location. Windows ACL
 * confinement cannot be shown to cover UNC/device paths, so they are refused
 * lexically before any filesystem access.
 */
export function isWindowsNetworkOrDevicePath(path: string): boolean {
    return /^[\\/]{2}/u.test(path);
}

/** Compare two canonical spellings under the platform's case convention. */
function comparable(path: string, platform: NodeJS.Platform): string {
    return platform === "win32" ? path.toLowerCase() : path;
}

/**
 * Whether `candidate` is `root` itself or lies beneath it. Both sides must be
 * canonical (or at least spelled consistently); this is the cheap lexical test
 * the providers use after canonicalization.
 */
export function isCanonicallyUnder(
    candidate: string,
    root: string,
    platform: NodeJS.Platform = process.platform,
): boolean {
    const target = comparable(candidate, platform);
    const base = comparable(root, platform);
    if (target === base) return true;
    return target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Validate and canonicalize one ACP `additionalDirectories` value.
 *
 * Rules, in order:
 *  - omit / `null` / `[]` means no additional roots (single-root behavior);
 *  - every entry must be a non-empty absolute path (relative input is an
 *    Invalid-params error, never resolved against the process cwd);
 *  - on Windows, UNC/device paths are refused lexically;
 *  - the path must exist and be a directory;
 *  - the canonical path must not be the primary root and must not repeat.
 *
 * `primaryRoot` is optional so the bridge can validate before a session cwd is
 * known; session creation always passes it.
 *
 * @param input - the raw ACP field.
 * @param options - primary root and platform override (tests).
 * @returns canonical additional roots, in request order.
 * @throws {RootValidationError} when any entry violates a rule.
 */
export function normalizeAdditionalDirectories(
    input: unknown,
    options: { primaryRoot?: string; platform?: NodeJS.Platform } = {},
): string[] {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) {
        throw new RootValidationError(
            "not-an-array",
            "additionalDirectories must be an array of absolute directory paths",
        );
    }
    const platform = options.platform ?? process.platform;
    const primary = options.primaryRoot === undefined ? undefined : canonicalRoot(options.primaryRoot);
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const raw of input) {
        if (typeof raw !== "string") {
            throw new RootValidationError(
                "not-a-string",
                "additionalDirectories entries must be strings containing absolute directory paths",
            );
        }
        if (raw.trim().length === 0) {
            throw new RootValidationError(
                "not-absolute",
                "additionalDirectories entries must be non-empty absolute directory paths",
            );
        }
        if (!isAbsolute(raw)) {
            throw new RootValidationError(
                "not-absolute",
                `additionalDirectories entry must be an absolute path: ${raw}`,
            );
        }
        if (platform === "win32" && isWindowsNetworkOrDevicePath(raw)) {
            throw new RootValidationError(
                "unsupported-path",
                `additionalDirectories entry is a network or device path, which Windows ACL confinement cannot cover: ${raw}`,
            );
        }
        const canonical = canonicalRoot(raw);
        if (platform === "win32" && isWindowsNetworkOrDevicePath(canonical)) {
            throw new RootValidationError(
                "unsupported-path",
                `additionalDirectories entry resolves to a network or device path, which Windows ACL confinement cannot cover: ${raw}`,
            );
        }
        let stat;
        try {
            stat = statSync(canonical);
        } catch {
            throw new RootValidationError(
                "missing",
                `additionalDirectories entry does not exist: ${raw}`,
            );
        }
        if (!stat.isDirectory()) {
            throw new RootValidationError(
                "not-a-directory",
                `additionalDirectories entry is not a directory: ${raw}`,
            );
        }
        if (primary !== undefined && comparable(canonical, platform) === comparable(primary, platform)) {
            throw new RootValidationError(
                "equals-primary",
                `additionalDirectories entry is already the session workspace root: ${raw}`,
            );
        }
        const key = comparable(canonical, platform);
        if (seen.has(key)) {
            throw new RootValidationError(
                "duplicate",
                `additionalDirectories entry repeats another root: ${raw}`,
            );
        }
        seen.add(key);
        roots.push(canonical);
    }
    return roots;
}

/**
 * The additional roots that can widen one call: canonical, existing
 * directories, deduplicated, with the primary root and everything beneath it
 * removed (the upstream policy already grants those). Missing or non-directory
 * roots are silently withheld rather than failing an already-running session.
 *
 * @param primaryRoot - the call's canonical-ish workspace root.
 * @param roots - roots stored for the session.
 * @param platform - containment case convention (tests).
 * @returns canonical additional roots.
 */
export function effectiveAdditionalRoots(
    primaryRoot: string,
    roots: readonly string[],
    platform: NodeJS.Platform = process.platform,
): string[] {
    const primary = canonicalRoot(primaryRoot);
    const seen = new Set<string>([comparable(primary, platform)]);
    const effective: string[] = [];
    for (const raw of roots) {
        if (typeof raw !== "string" || !isAbsolute(raw)) continue;
        const canonical = canonicalRoot(raw);
        if (isCanonicallyUnder(canonical, primary, platform)) continue;
        const key = comparable(canonical, platform);
        if (seen.has(key)) continue;
        try {
            if (!statSync(canonical).isDirectory()) continue;
        } catch {
            continue;
        }
        seen.add(key);
        effective.push(canonical);
    }
    return effective;
}

/**
 * Read a persisted root list without throwing on records written by another
 * build (or entries whose directory has since disappeared). A malformed record
 * contributes no grants.
 *
 * @param input - the stored `additionalDirectories` payload.
 * @returns canonical roots that still validate; empty on any failure.
 */
export function storedAdditionalDirectories(input: unknown): string[] {
    try {
        return normalizeAdditionalDirectories(input);
    } catch {
        return [];
    }
}
