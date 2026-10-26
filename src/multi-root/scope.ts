/**
 * The ACP multi-root scope: the single owner of "which additional directories
 * belong to this session".
 *
 * The primary root is never stored here — it is the session's immutable cwd as
 * resolved by the upstream `ctx.sandboxPolicy` service. This service stores
 * only the extra roots the ACP bridge accepted on `session/new`, `load`,
 * `resume`, or `fork`, keyed by session id. Both replacement providers (the
 * sandbox and the filesystem fence) read the same table, so one session can
 * never see another session's grants, and an empty table is the single-root
 * pass-through path.
 *
 * @module dsh-acp/multi-root/scope
 */

import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";

import { canonicalRoot } from "./roots.ts";

/** The structural API the bridge and providers consume. */
export interface AcpMultiRootScopeApi {
    /**
     * Replace one session's additional roots. An empty list removes the entry;
     * the providers then run their upstream single-root path verbatim.
     */
    set(sessionId: string, roots: readonly string[]): void;
    /** The canonical additional roots for one session (empty when none). */
    get(sessionId: string | undefined): readonly string[];
    /** Drop one session's roots when its ACP session closes. */
    delete(sessionId: string): void;
}

declare module "@deepseek-ai/cordis" {
    interface Context {
        acpMultiRootScope: AcpMultiRootScope;
    }
}

/**
 * Register as `ctx.acpMultiRootScope`. The bridge feature-detects this service
 * to advertise `sessionCapabilities.additionalDirectories`; the fs and sandbox
 * replacements inject it so they never mount without their scope owner.
 */
export class AcpMultiRootScope extends Service implements AcpMultiRootScopeApi {
    private readonly rootsBySession = new Map<string, readonly string[]>();

    constructor(ctx: Context) {
        super(ctx, "acpMultiRootScope");
    }

    set(sessionId: string, roots: readonly string[]): void {
        const canonical = [
            ...new Set(roots.filter((root): root is string => typeof root === "string").map(canonicalRoot)),
        ];
        if (canonical.length === 0) {
            this.rootsBySession.delete(sessionId);
            return;
        }
        this.rootsBySession.set(sessionId, canonical);
    }

    get(sessionId: string | undefined): readonly string[] {
        if (sessionId === undefined || sessionId.length === 0) return [];
        return this.rootsBySession.get(sessionId) ?? [];
    }

    delete(sessionId: string): void {
        this.rootsBySession.delete(sessionId);
    }
}

export default AcpMultiRootScope;
