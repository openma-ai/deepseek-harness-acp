/**
 * Session title resolution shared by `session/list` and the restored-session
 * `session_info_update` paths.
 */

export interface SessionTitleSources {
    /** The `title` projection from the persisted projection cache, when cached. */
    readonly projcacheTitle?: unknown;
    /** The latest `session/title` text folded from the stored log, when present. */
    readonly logTitle?: unknown;
}

/** Only a non-empty string is a title; null/empty means the source missed. */
function nonEmptyTitle(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve one session title from the projection cache and the log fold.
 * The cache wins because it carries explicit renames; the log is the
 * self-generated fallback. An unknown title stays omitted, never null.
 */
export function resolveSessionTitle({ projcacheTitle, logTitle }: SessionTitleSources): string | undefined {
    return nonEmptyTitle(projcacheTitle) ?? nonEmptyTitle(logTitle);
}
