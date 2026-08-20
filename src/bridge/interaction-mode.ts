export type AcpInteractionMode = "interactive" | "rpc";

/** Read only the explicit DSH ACP extension; absence and unknown values stay absent. */
export function interactionModeFromClientMeta(meta: unknown): AcpInteractionMode | undefined {
    if (meta === null || typeof meta !== "object") return undefined;
    const dsh = (meta as Record<string, unknown>)["dsh"];
    if (dsh === null || typeof dsh !== "object") return undefined;
    const interaction = (dsh as Record<string, unknown>)["interaction"];
    if (interaction === null || typeof interaction !== "object") return undefined;
    const mode = (interaction as Record<string, unknown>)["mode"];
    return mode === "interactive" || mode === "rpc" ? mode : undefined;
}

/** Add the negotiated mode without manufacturing one for clients that omitted it. */
export function withInteractionMode<T extends object>(
    options: T,
    mode: AcpInteractionMode | undefined,
): T & { interactionMode?: AcpInteractionMode } {
    return mode === undefined ? options : { ...options, interactionMode: mode };
}
