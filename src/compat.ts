/**
 * Shared `@deepseek-ai/dsh` compatibility rules.
 *
 * The supported version range is declared once — as the real semver range in
 * `peerDependencies["@deepseek-ai/dsh"]` — and enforced in two places:
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

/** True when `version` falls inside `range`; unknown versions refuse. */
export function dshVersionSupported(version: string | undefined, range: string = supportedDshRange()): boolean {
    if (version === undefined) return false;
    return semver.satisfies(version, range);
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

/** Uniform refusal text: names the version found, where it came from, and the range. */
export function refusalMessage(found: string, source: string, supported: string): string {
    return `incompatible DeepSeek Harness: @deepseek-ai/dsh ${found} found at ${source} — supported versions: ${supported}`;
}
