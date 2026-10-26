/**
 * Multi-root filesystem provider: the upstream sandbox-enforcing filesystem
 * with the per-call writable set widened by the session's additional roots.
 *
 * It extends `LocalFileSystem` (all text-storage mechanics are inherited) and
 * re-implements the upstream `SandboxedFileSystem` write/edit fence on top of
 * the shared `writableRoots(policy)` derivation plus this session's extra
 * roots. Reads stay unfenced, exactly as upstream. With no extra roots the
 * fence is byte-for-byte the upstream one: same writable roots, same denial
 * messages, same atomic-mutation path.
 *
 * @module dsh-acp/multi-root/fs
 */

import { stat } from "node:fs/promises";
import { dirname, sep } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";
import type {
    FsEditOutcome,
    FsEditRequest,
    FsTarget,
    FsVersion,
    FsWriteIntent,
    FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import { LocalFileSystem, type Config } from "@deepseek-ai/dsh-fs-local";
import { canonicalPath, writableRoots } from "@deepseek-ai/dsh-sandbox";
import type { SandboxExecutionPolicy, SandboxMode } from "@deepseek-ai/dsh-sandbox";

import { effectiveAdditionalRoots } from "./roots.ts";
import type { AcpMultiRootScope } from "./scope.ts";

export const name = "acp-multi-root-fs";
export const inject = ["sandboxPolicy", "acpMultiRootScope"];

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

type StatResult = NonNullable<Awaited<ReturnType<typeof stat>>>;

function isMissing(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code !== undefined && MISSING_CODES.has(code);
}

function comparablePath(path: string, caseSensitive: boolean): string {
    return caseSensitive ? path : path.toLowerCase();
}

function isLexicallyUnder(path: string, root: string, caseSensitive: boolean): boolean {
    const comparableTarget = comparablePath(path, caseSensitive);
    const comparableRoot = comparablePath(root, caseSensitive);
    if (comparableTarget === comparableRoot) return true;
    const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    return comparableTarget.startsWith(prefix);
}

async function statIfPresent(path: string): Promise<StatResult | undefined> {
    try {
        return await stat(path, { bigint: true });
    } catch (error: unknown) {
        if (isMissing(error)) return undefined;
        throw error;
    }
}

function sameIdentity(
    left: StatResult,
    right: StatResult,
): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Whether a canonical target is a writable root or lies beneath it.
 *
 * The lexical fast path handles normal canonical spellings; when spellings
 * differ, walk the target's existing ancestors and compare filesystem identity
 * with the root (Windows long-name/8.3 aliases and casing).
 */
async function isPathUnder(
    path: string,
    root: string,
    caseSensitive = process.platform !== "win32",
): Promise<boolean> {
    if (isLexicallyUnder(path, root, caseSensitive)) return true;
    const rootInfo = await statIfPresent(root);
    if (rootInfo === undefined) return false;
    let ancestor = path;
    for (;;) {
        const ancestorInfo = await statIfPresent(ancestor);
        if (ancestorInfo !== undefined && sameIdentity(ancestorInfo, rootInfo)) return true;
        const parent = dirname(ancestor);
        if (parent === ancestor) return false;
        ancestor = parent;
    }
}

export class MultiRootFileSystem extends LocalFileSystem {
    static inject = ["sandboxPolicy", "acpMultiRootScope"];

    private readonly defaultMode: SandboxMode;

    constructor(ctx: Context, config: Config) {
        super(ctx, config);
        this.defaultMode = ctx.sandboxPolicy.defaultMode;
    }

    /** The deployment default mode — the capability fact the tool layer reads. */
    override get sandboxMode(): SandboxMode {
        return this.defaultMode;
    }

    override async writeText(
        target: FsTarget,
        content: string,
        expected?: FsWriteIntent,
        signal?: AbortSignal,
        sandboxPolicy?: SandboxExecutionPolicy,
    ): Promise<FsWriteOutcome> {
        return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal);
    }

    override async editText(
        target: FsTarget,
        edit: FsEditRequest,
        expected?: { version: FsVersion },
        signal?: AbortSignal,
        sandboxPolicy?: SandboxExecutionPolicy,
    ): Promise<FsEditOutcome> {
        return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal);
    }

    /**
     * Fence one mutation: `read-only` denies; `workspace-write` re-resolves the
     * target now and requires containment under the upstream writable roots or
     * one of this session's additional roots; `danger-full-access` delegates
     * unfenced. With no additional roots this is the upstream fence exactly.
     */
    private async checkedTarget(
        target: FsTarget,
        sandboxPolicy?: SandboxExecutionPolicy,
    ): Promise<FsTarget> {
        const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
        const { mode } = policy;
        if (mode === "danger-full-access") return target;
        if (mode === "read-only") {
            throw new FsError(
                `cannot write "${target.displayPath}": file access denied under read-only mode`,
                "FS_SANDBOX_DENIED",
            );
        }
        const fresh = await this.resolve(target.displayPath);
        const roots = writableRoots(policy);
        const scope = this.ctx.get("acpMultiRootScope") as AcpMultiRootScope | undefined;
        if (scope !== undefined) {
            const extra = effectiveAdditionalRoots(
                policy.workspaceRoot,
                scope.get(policy.sessionId === undefined ? undefined : String(policy.sessionId)),
            );
            for (const root of extra) if (!roots.includes(root)) roots.push(root);
        }
        for (const root of roots) {
            if (await isPathUnder(fresh.targetKey, root)) return fresh;
        }
        throw new FsError(
            `cannot write "${target.displayPath}": file access denied under workspace-write mode`,
            "FS_SANDBOX_DENIED",
        );
    }
}

export default MultiRootFileSystem;
