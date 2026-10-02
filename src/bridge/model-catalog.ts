/**
 * Live-catalog substitutions for model ids removed by a dsh upgrade.
 *
 * pi-ai 0.87.1 (dsh 0.2.0) dropped several ids, including
 * `deepseek-v4-flash`. The official DeepSeek adapter still describes an
 * unlisted id and passes it through; strict catalogs (pi-ai) reject them
 * with `UNKNOWN_MODEL`. Callers ask this helper after that probe.
 */

export interface CatalogModel {
    provider: string | undefined;
    model: string;
}

/**
 * Ids removed from the shipped catalogs, and the listed successor to use
 * when that provider still offers it.
 */
export const REMOVED_MODEL_SUCCESSORS: Readonly<Record<string, string>> = {
    "deepseek-v4-flash": "deepseek-flash",
};

export interface ModelSubstitution {
    model: string;
    replaced: boolean;
    /** Human-readable reason, present only when `replaced` is true. */
    reason?: string;
}

function listed(catalog: readonly CatalogModel[], provider: string, model: string): boolean {
    return catalog.some((entry) => entry.provider === provider && entry.model === model);
}

/**
 * Choose a model id the live catalog can actually run.
 *
 * A listed id is unchanged. A removed id with a listed successor uses that
 * successor. An unlisted id the adapter can still describe (official
 * pass-through) is kept. Anything else falls back to the provider's first
 * listed model so a persisted selection cannot wedge the session.
 */
export function substituteUnavailableModel(
    provider: string,
    model: string,
    catalog: readonly CatalogModel[],
    described: boolean,
): ModelSubstitution {
    if (listed(catalog, provider, model)) return { model, replaced: false };
    const successor = REMOVED_MODEL_SUCCESSORS[model];
    if (successor !== undefined && listed(catalog, provider, successor)) {
        return {
            model: successor,
            replaced: true,
            reason: `model "${model}" is no longer in the ${provider} catalog; using "${successor}"`,
        };
    }
    if (described) return { model, replaced: false };
    const fallback = catalog.find((entry) => entry.provider === provider)?.model;
    if (fallback !== undefined && fallback !== model) {
        return {
            model: fallback,
            replaced: true,
            reason: `model "${provider}/${model}" is not available; using "${fallback}"`,
        };
    }
    return { model, replaced: false };
}
