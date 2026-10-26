/**
 * Multi-root process-sandbox provider: the upstream local runner chain with
 * one change — a `workspace-write` profile also grants the session's
 * additional roots.
 *
 * The class extends the installed `LocalSandboxProvider`, so runner selection,
 * probing, denial dialects, enforcement reporting, and the Windows ACL grant
 * mechanics stay upstream. It replaces the `sandbox` row only because Cordis
 * refuses two providers for the same service key; its empty-scope path calls
 * `super.confine` unchanged.
 *
 * @module dsh-acp/multi-root/sandbox
 */

import type { Context } from "@deepseek-ai/cordis";
import {
    SandboxUnavailableError,
    type ConfinedArgv,
    type SandboxPolicy,
} from "@deepseek-ai/dsh-sandbox";
import { LocalSandboxProvider, type Config } from "@deepseek-ai/dsh-sandbox-local";

import { DialectUnrecognizedError, widenConfinedArgv } from "./dialects.ts";
import { canonicalRoot, effectiveAdditionalRoots } from "./roots.ts";
import type { AcpMultiRootScope } from "./scope.ts";

export const name = "acp-multi-root-sandbox";
export const inject = ["acpMultiRootScope"];

export class MultiRootSandboxProvider extends LocalSandboxProvider {
    static inject = ["acpMultiRootScope"];

    constructor(ctx: Context, config: Config) {
        super(ctx, config);
    }

    /**
     * Wrap `argv` through the upstream provider, then widen a
     * `workspace-write` profile with the session's additional roots. Under
     * `read-only` and `danger-full-access` — and for every session with no
     * extra roots — the upstream result is returned untouched.
     */
    override async confine(
        argv: readonly string[],
        policy: SandboxPolicy,
        signal?: AbortSignal,
    ): Promise<ConfinedArgv> {
        const canonicalPolicy: SandboxPolicy = {
            ...policy,
            workspaceRoot: canonicalRoot(policy.workspaceRoot),
        };
        const confined = await super.confine(argv, canonicalPolicy, signal);
        if (canonicalPolicy.mode !== "workspace-write") return confined;
        const scope = this.ctx.get("acpMultiRootScope") as AcpMultiRootScope | undefined;
        if (scope === undefined) return confined;
        const roots = effectiveAdditionalRoots(
            canonicalPolicy.workspaceRoot,
            scope.get(canonicalPolicy.sessionId === undefined ? undefined : String(canonicalPolicy.sessionId)),
        );
        if (roots.length === 0) return confined;
        try {
            return widenConfinedArgv(confined, argv, canonicalPolicy, roots);
        } catch (error: unknown) {
            if (error instanceof DialectUnrecognizedError) {
                throw new SandboxUnavailableError(canonicalPolicy.mode, error.message);
            }
            throw error;
        }
    }
}

export default MultiRootSandboxProvider;
