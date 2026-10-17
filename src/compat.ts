/**
 * Shared `@deepseek-ai/dsh` compatibility rules.
 *
 * Compatibility is a minimum-version floor, never an allow-list: newer dsh
 * releases are attempted, and API differences are handled by feature
 * detection where they are used. A dsh newer than the highest version CI
 * exercises ({@link TESTED_DSH_THROUGH}: the newest of the
 * runtime/compatibility.json matrix and the `next` host CI job) only earns a
 * warning. Only a dsh below the
 * floor is refused.
 *
 * The floor is declared once — as `peerDependencies["@deepseek-ai/dsh"]`
 * (mirrored in `engines.dsh`, which dsh's own plugin loader reads) — and
 * enforced in two places:
 * `src/harness.ts` for every resolution source the standalone launcher
 * probes, and `src/plugin.ts` for the host dsh that mounts this package as a
 * Cordis plugin. This module carries only the manifest read and the message
 * formatting so the plugin path never loads the standalone-only modules
 * (src/runtime.ts, src/harness.ts).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import semver from "semver";

/** Peer-declared package whose version bounds compatibility. */
export const COMPAT_PACKAGE = "@deepseek-ai/dsh";

/** The supported range declared by a manifest's `peerDependencies` ("*" when absent). */
export function dshRangeOf(manifest: { peerDependencies?: Record<string, string> }): string {
    return manifest.peerDependencies?.[COMPAT_PACKAGE] ?? "*";
}

/** The `@deepseek-ai/dsh` versions this release supports (from `peerDependencies`). */
export function supportedDshRange(): string {
    const manifest = createRequire(import.meta.url)("../package.json") as {
        peerDependencies?: Record<string, string>;
    };
    return dshRangeOf(manifest);
}

/**
 * Highest `@deepseek-ai/dsh` version CI exercises (the `dsh-next` job pins
 * it). test/compat.test.ts keeps it at or above every
 * runtime/compatibility.json entry.
 */
export const TESTED_DSH_THROUGH = "0.2.1-rc.2";

/**
 * True when `version` meets the floor `range`; unknown versions refuse.
 * Prereleases participate, matching dsh's own plugin compatibility rule.
 */
export function dshVersionSupported(version: string | undefined, range: string = supportedDshRange()): boolean {
    if (version === undefined || semver.valid(version) === null) return false;
    return semver.satisfies(version, range, { includePrerelease: true });
}

/** True when `version` is newer than any dsh this release was tested with. */
export function dshVersionUntested(version: string | undefined, testedThrough: string = TESTED_DSH_THROUGH): boolean {
    if (version === undefined || semver.valid(version) === null) return false;
    return semver.gt(version, testedThrough);
}

/** One-line warning for a dsh above {@link TESTED_DSH_THROUGH}; the caller proceeds. */
export function untestedMessage(found: string, source: string, testedThrough: string = TESTED_DSH_THROUGH): string {
    return `@deepseek-ai/dsh ${found} at ${source} is newer than the newest version this dsh-acp was tested with (${testedThrough}); continuing — report problems at https://github.com/openma-ai/deepseek-harness-acp/issues`;
}

/** Version of the `@deepseek-ai/dsh` launcher resolvable from `anchor`. */
export function dshVersionAt(anchor: string): { version: string | undefined; base: string } | undefined {
    try {
        const manifestPath = createRequire(anchor).resolve(`${COMPAT_PACKAGE}/package.json`);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
        return {
            version: typeof manifest.version === "string" ? manifest.version : undefined,
            base: dirname(manifestPath),
        };
    } catch {
        return undefined;
    }
}

/** Uniform refusal text: names the version found, where it came from, and the floor. */
export function refusalMessage(found: string, source: string, supported: string): string {
    return `incompatible DeepSeek Harness: @deepseek-ai/dsh ${found} found at ${source} — supported versions: ${supported}`;
}
