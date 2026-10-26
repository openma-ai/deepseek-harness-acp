/**
 * Dialect widening: add additional roots to the profile arguments an upstream
 * kernel-sandbox provider already produced.
 *
 * Upstream `@deepseek-ai/dsh-sandbox-local` expresses `workspace-write` with a
 * singular policy root. Its profile builders are not exported from the
 * published package, so the only portable seam is the wrapped argv returned by
 * `confine()`: split at the separator, recognize the runner dialect from its
 * structural markers, clone the grant spelling upstream used for the primary
 * root, and append the additional roots.
 *
 * The parsing/insertion approach is adapted from
 * `@dsh-electron/dsh-plugin-multi-root-workspace` 0.1.10 (MIT, Copyright
 * (c) 2026 Cherry Chen). See NOTICE.md. The scope here is deliberately thin:
 * only `workspace-write` widening, no deny/restrict modes and no Windows ACL
 * runner.
 *
 * @module dsh-acp/multi-root/dialects
 */

import type { ConfinedArgv, SandboxPolicy } from "@deepseek-ai/dsh-sandbox";

/** Raised when a confined argv shape is not one this module can widen. */
export class DialectUnrecognizedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DialectUnrecognizedError";
    }
}

type Dialect = "seatbelt" | "bwrap" | "landlock" | "windows-acl";

interface SplitConfined {
    dialect: Dialect;
    profileArgs: string[];
    commandArgs: string[];
}

/** Quote one path as an SBPL string literal, matching upstream's spelling. */
function sbplString(path: string): string {
    return `"${path.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

/** One SBPL `(subpath "…")` token. */
const SBPL_SUBPATH_TOKEN = /\(subpath\s+("(?:[^"\\]|\\.)*")\)/gu;
/** The SBPL form that carries the upstream writable subpath grants. */
const SBPL_SUBPATH_FORM = /\(allow file-write\*\s*(?:\(subpath\s+"(?:[^"\\]|\\.)*"\)\s*)+\)/u;

/** Unquote one SBPL string literal (including its surrounding quotes). */
function sbplValue(literal: string): string {
    return literal.slice(1, -1).replaceAll(String.raw`\"`, '"').replaceAll(String.raw`\\`, "\\");
}

/**
 * Split the upstream wrap at the separator by arithmetic, then verify both
 * halves. The provider always builds `[...profileArgs, "--", ...argv]`; a
 * mismatch means the installed release no longer has the assumed shape.
 */
function splitConfined(confinedArgv: readonly string[], commandArgv: readonly string[]): SplitConfined {
    const separator = confinedArgv.length - commandArgv.length - 1;
    if (separator < 1 || confinedArgv[separator] !== "--") {
        throw new DialectUnrecognizedError(
            `confined argv is not "[...profile, --, ...argv]" (separator expected at ${separator}, got ${JSON.stringify(confinedArgv[separator])})`,
        );
    }
    const commandArgs = confinedArgv.slice(separator + 1);
    if (
        commandArgs.length !== commandArgv.length ||
        commandArgs.some((argument, index) => argument !== commandArgv[index])
    ) {
        throw new DialectUnrecognizedError("confined argv does not end with the caller's argv verbatim");
    }
    const profileArgs = confinedArgv.slice(0, separator);
    return { dialect: detectDialect(profileArgs), profileArgs, commandArgs };
}

/** Recognize exactly one runner dialect from the structural profile markers. */
function detectDialect(profileArgs: readonly string[]): Dialect {
    const matches: Dialect[] = [];
    if (profileArgs.length >= 2 && profileArgs[profileArgs.length - 2] === "-p") matches.push("seatbelt");
    if (profileArgs.includes("--mode")) matches.push("windows-acl");
    if (profileArgs.includes("--rw")) matches.push("landlock");
    if (profileArgs.includes("--ro-bind")) matches.push("bwrap");
    const [first, ...rest] = matches;
    if (first === undefined) {
        throw new DialectUnrecognizedError(`unrecognized sandbox profile arguments: ${JSON.stringify(profileArgs)}`);
    }
    if (rest.length > 0) {
        throw new DialectUnrecognizedError(
            `ambiguous sandbox profile arguments (${matches.join(", ")}): ${JSON.stringify(profileArgs)}`,
        );
    }
    return first;
}

/** Append the additional roots to the SBPL form that carries the subpath grants. */
function widenSeatbelt(profileArgs: string[], additionalRoots: readonly string[]): string[] {
    const profile = profileArgs[profileArgs.length - 1];
    if (profile === undefined || profileArgs[profileArgs.length - 2] !== "-p") {
        throw new DialectUnrecognizedError(
            `seatbelt profile is not "[<sandbox-exec>, …, -p, <SBPL>]": ${JSON.stringify(profileArgs)}`,
        );
    }
    const granted = new Set([...profile.matchAll(SBPL_SUBPATH_TOKEN)].map((token) => sbplValue(token[1] ?? '""')));
    const added = additionalRoots.filter((root) => !granted.has(root));
    if (added.length === 0) return [...profileArgs];
    const form = SBPL_SUBPATH_FORM.exec(profile);
    if (form === null) {
        // Last-match-wins: a trailing allow form overrides the blanket deny.
        const widened = `${profile} (allow file-write* ${added.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`;
        return [...profileArgs.slice(0, -1), widened];
    }
    const matched = form[0];
    const extra = added.map((root) => `(subpath ${sbplString(root)})`).join(" ");
    const widened =
        profile.slice(0, form.index) + matched.slice(0, -1) + ` ${extra})` + profile.slice(form.index + matched.length);
    return [...profileArgs.slice(0, -1), widened];
}

/** The bwrap bind flag upstream used for the policy root's `[flag, root, root]` triple. */
function bwrapBindFlag(profileArgs: readonly string[], workspaceRoot: string): string {
    for (let index = 2; index < profileArgs.length; index += 1) {
        if (profileArgs[index] !== workspaceRoot || profileArgs[index - 1] !== workspaceRoot) continue;
        const flag = profileArgs[index - 2];
        if (flag === undefined || !flag.startsWith("--") || flag.startsWith("--ro")) continue;
        return flag;
    }
    throw new DialectUnrecognizedError(
        `bwrap profile has no writable bind of the policy root ${JSON.stringify(workspaceRoot)}: ${JSON.stringify(profileArgs)}`,
    );
}

/** Append the additional roots as binds, after upstream's own root bind. */
function widenBwrap(profileArgs: string[], workspaceRoot: string, additionalRoots: readonly string[]): string[] {
    const flag = bwrapBindFlag(profileArgs, workspaceRoot);
    const granted = new Set<string>();
    for (let index = 0; index + 2 < profileArgs.length; index += 1) {
        if (profileArgs[index] === flag && profileArgs[index + 1] === profileArgs[index + 2]) {
            granted.add(profileArgs[index + 2] as string);
        }
    }
    for (let index = 0; index + 1 < profileArgs.length; index += 1) {
        if (profileArgs[index] === "--tmpfs") granted.add(profileArgs[index + 1] as string);
    }
    const added = additionalRoots.filter((root) => !granted.has(root)).flatMap((root) => [flag, root, root]);
    return [...profileArgs, ...added];
}

/** The Landlock read-write flag upstream used for the policy root. */
function landlockReadWriteFlag(profileArgs: readonly string[], workspaceRoot: string): string {
    for (let index = 1; index < profileArgs.length; index += 1) {
        if (profileArgs[index] !== workspaceRoot) continue;
        const flag = profileArgs[index - 1];
        if (flag === undefined || !flag.startsWith("--") || flag.startsWith("--ro")) continue;
        return flag;
    }
    throw new DialectUnrecognizedError(
        `landlock profile has no read-write grant of the policy root ${JSON.stringify(workspaceRoot)}: ${JSON.stringify(profileArgs)}`,
    );
}

/** Append the additional roots as read-write grants, after upstream's own root grant. */
function widenLandlock(profileArgs: string[], workspaceRoot: string, additionalRoots: readonly string[]): string[] {
    const flag = landlockReadWriteFlag(profileArgs, workspaceRoot);
    const granted = new Set<string>();
    for (let index = 0; index + 1 < profileArgs.length; index += 1) {
        if (profileArgs[index] === flag) granted.add(profileArgs[index + 1] as string);
    }
    const added = additionalRoots.filter((root) => !granted.has(root)).flatMap((root) => [flag, root]);
    return [...profileArgs, ...added];
}

/**
 * Widen one kernel-sandbox profile with additional writable roots.
 *
 * Only `workspace-write` grants anything: `read-only` already denies every
 * write, and `danger-full-access` never reaches the provider. An empty root
 * list returns the upstream result element for element (same argv reference
 * semantics), so single-root sessions take today's exact path.
 *
 * @param confined - the upstream `confine()` result.
 * @param commandArgv - the caller's argv, used to verify the split.
 * @param policy - the per-call policy; its root is the primary grant.
 * @param additionalRoots - canonical additional roots.
 * @returns the upstream result with only `argv` widened when needed.
 * @throws {DialectUnrecognizedError} when the profile cannot be widened.
 */
export function widenConfinedArgv(
    confined: ConfinedArgv,
    commandArgv: readonly string[],
    policy: SandboxPolicy,
    additionalRoots: readonly string[],
): ConfinedArgv {
    if (additionalRoots.length === 0 || policy.mode !== "workspace-write") return confined;
    const { dialect, profileArgs, commandArgs } = splitConfined(confined.argv, commandArgv);
    let widened: string[];
    switch (dialect) {
        case "seatbelt":
            widened = widenSeatbelt(profileArgs, additionalRoots);
            break;
        case "bwrap":
            widened = widenBwrap(profileArgs, policy.workspaceRoot, additionalRoots);
            break;
        case "landlock":
            widened = widenLandlock(profileArgs, policy.workspaceRoot, additionalRoots);
            break;
        case "windows-acl":
            throw new DialectUnrecognizedError(
                "Windows ACL widening requires an out-of-tree runner; additional-directory writes are unsupported on this backend",
            );
    }
    return { ...confined, argv: [...widened, "--", ...commandArgs] };
}
