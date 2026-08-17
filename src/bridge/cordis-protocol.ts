/** ACP extension contract for the DSH Cordis client plane. */

export const CORDIS_PROTOCOL = 0;

export const CORDIS_CAPABILITY = Object.freeze({ protocol: CORDIS_PROTOCOL });

export const CORDIS_METHODS = Object.freeze({
    inspectSync: "_dsh/cordis/inspect/sync",
    inspectResolve: "_dsh/cordis/inspect/resolve",
    inspectQuery: "_dsh/cordis/inspect/query",
    inspectQueryResolved: "_dsh/cordis/inspect/query-resolved",
    runHost: "_dsh/cordis/run/host",
    getClientCode: "_dsh/cordis/run/client-code",
    resolveRequestRun: "_dsh/cordis/run/resolve",
    requestRun: "_dsh/cordis/run/request",
    requestRunResolved: "_dsh/cordis/run/request-resolved",
    userRun: "_dsh/cordis/run/user",
    settleUserRun: "_dsh/cordis/run/settle",
    pluginInvoke: "_dsh/cordis/plugin/invoke",
    pluginsList: "_dsh/cordis/plugins/list",
    pluginStart: "_dsh/cordis/plugins/start",
    pluginStop: "_dsh/cordis/plugins/stop",
    pluginRetract: "_dsh/cordis/plugins/retract",
});

export function advertisesCordis(meta: unknown): boolean {
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return false;
    const dsh = (meta as Record<string, unknown>)["dsh"];
    if (dsh === null || typeof dsh !== "object" || Array.isArray(dsh)) return false;
    const cordis = (dsh as Record<string, unknown>)["cordis"];
    if (cordis === null || typeof cordis !== "object" || Array.isArray(cordis)) return false;
    return (cordis as Record<string, unknown>)["protocol"] === CORDIS_PROTOCOL;
}
