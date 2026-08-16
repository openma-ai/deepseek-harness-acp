/**
 * Optional ACP extras that let a TUI Client advertise inspect providers and
 * answer Cordis Client jobs. Zed never registers or calls these methods.
 *
 * This is not a cordis-acp plugin-id / inject / fiber sync. The Client tree
 * stays in the TUI process; the agent only mirrors a serializable directory
 * and forwards query/run payloads already used by the web Client.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AcpRpc } from "./rpc.ts";

/** Serializable inspect provider directory (mirrors cordis-host-runner). */
interface InspectProviderManifest {
    id: string;
    description: string;
    methods: readonly unknown[];
}

interface InspectRegistry {
    syncClientManifest(providers: readonly InspectProviderManifest[]): void;
    resolveClientQuery(
        agent: Agent,
        requestId: string,
        resolution: unknown,
    ): { accepted: boolean };
}

interface DynamicRunner {
    runHostHalf(
        agent: Agent,
        pluginId: string,
        packageId: string,
        mode: string,
        requestId: string | null,
        approveFutureVersions: boolean,
    ): Promise<unknown>;
    getClientCode(agent: Agent, pluginId: string, pluginRunId: string): unknown;
    resolveRequestRun(requestId: string, resolution: unknown): Promise<unknown>;
    settleUserRun(agent: Agent, pluginId: string, resolution: unknown): Promise<unknown>;
    invoke(pluginId: string, pluginRunId: string, method: string, args: unknown): Promise<unknown>;
    listPlugins(agent: Agent): DynamicPluginInspection[];
    stopFromPanel(agent: Agent, pluginId: string): Promise<unknown>;
}

interface DynamicPackageSummary {
    packageId: string;
    name: string;
    purpose: string;
    hasHostHalf: boolean;
    hasClientHalf: boolean;
}

interface DynamicPluginInspection {
    pluginId: string;
    currentPackageId?: string;
    activeRun?: { pluginRunId: string; packageId: string };
    packages: DynamicPackageSummary[];
    [key: string]: unknown;
}

/** Mutable advertisement from `initialize` `_meta.tuiInspect`. */
export interface TuiClientAdvertisement {
    /** True after a client advertised TUI inspect extras. */
    advertised: boolean;
}

/**
 * Register TUI Client extras on the bridge-private ACP RPC seam when Cordis
 * inspect/run exist.
 * @param ctx - bridge context (optional cordisInspect / dynamicCordisRunner).
 * @param rpc - extra-method seam on the ACP stream.
 * @param opts - agent lookup and initialize advertisement.
 */
export function installTuiClientPlane(
    ctx: Context,
    rpc: AcpRpc,
    opts: {
        findAgent: (agentId: string) => Agent | undefined;
        advertisement: TuiClientAdvertisement;
    },
): void {
    const { findAgent, advertisement } = opts;

    ctx.effect(
        () =>
            rpc.registerMethod("tui/inspect-sync", (params) => {
                const inspect = optionalInspect(ctx);
                if (inspect === undefined) {
                    throw new Error("this agent has no Cordis inspect registry");
                }
                const providers = readProviders(params);
                inspect.syncClientManifest(providers);
                advertisement.advertised = true;
                return { ok: true };
            }),
        "acp-bridge: tui/inspect-sync",
    );

    ctx.effect(
        () =>
            rpc.registerMethod("tui/inspect-resolve", (params) => {
                const inspect = optionalInspect(ctx);
                if (inspect === undefined) {
                    throw new Error("this agent has no Cordis inspect registry");
                }
                const body = asObject(params);
                const agent = requireAgent(findAgent, readString(body, "agentId"));
                const requestId = readString(body, "requestId");
                return inspect.resolveClientQuery(agent, requestId, body["resolution"]);
            }),
        "acp-bridge: tui/inspect-resolve",
    );

    ctx.effect(
        () =>
            rpc.registerMethod("tui/run-host-half", async (params) => {
                const runner = optionalRunner(ctx);
                if (runner === undefined) {
                    throw new Error("this agent has no dynamic Cordis runner");
                }
                const body = asObject(params);
                const agent = requireAgent(findAgent, readString(body, "agentId"));
                const requestId = body["requestId"];
                return await runner.runHostHalf(
                    agent,
                    readString(body, "pluginId"),
                    readString(body, "packageId"),
                    readString(body, "mode"),
                    typeof requestId === "string" ? requestId : null,
                    body["approveFutureVersions"] === true,
                );
            }),
        "acp-bridge: tui/run-host-half",
    );

    ctx.effect(
        () =>
            rpc.registerMethod("tui/get-client-code", (params) => {
                const runner = optionalRunner(ctx);
                if (runner === undefined) {
                    throw new Error("this agent has no dynamic Cordis runner");
                }
                const body = asObject(params);
                const agent = requireAgent(findAgent, readString(body, "agentId"));
                return runner.getClientCode(
                    agent,
                    readString(body, "pluginId"),
                    readString(body, "pluginRunId"),
                );
            }),
        "acp-bridge: tui/get-client-code",
    );

    ctx.effect(
        () =>
            rpc.registerMethod("tui/resolve-request-run", async (params) => {
                const runner = optionalRunner(ctx);
                if (runner === undefined) {
                    throw new Error("this agent has no dynamic Cordis runner");
                }
                const body = asObject(params);
                return await runner.resolveRequestRun(
                    readString(body, "requestId"),
                    body["resolution"],
                );
            }),
        "acp-bridge: tui/resolve-request-run",
    );

    ctx.effect(
        () =>
            rpc.registerMethod("tui/invoke", async (params) => {
                const runner = optionalRunner(ctx);
                if (runner === undefined) {
                    throw new Error("this agent has no dynamic Cordis runner");
                }
                const body = asObject(params);
                requireAgent(findAgent, readString(body, "agentId"));
                return await runner.invoke(
                    readString(body, "pluginId"),
                    readString(body, "pluginRunId"),
                    readString(body, "method"),
                    body["args"] ?? null,
                );
            }),
        "acp-bridge: tui/invoke",
    );

    ctx.effect(
        () =>
            rpc.registerMethod("tui/list-plugins", (params) => {
                const runner = requireRunnerMethod(ctx, "listPlugins");
                const body = asObject(params);
                const agent = requireAgent(findAgent, readString(body, "agentId"));
                return runner.listPlugins(agent);
            }),
        "acp-bridge: tui/list-plugins",
    );

    ctx.effect(
        () =>
            rpc.registerMethod("tui/stop-plugin", async (params) => {
                const runner = requireRunnerMethod(ctx, "stopFromPanel");
                const body = asObject(params);
                const agent = requireAgent(findAgent, readString(body, "agentId"));
                return await runner.stopFromPanel(agent, readString(body, "pluginId"));
            }),
        "acp-bridge: tui/stop-plugin",
    );

    ctx.effect(
        () =>
            rpc.registerMethod("tui/start-plugin", async (params) => {
                const runner = requireRunnerMethod(ctx, "listPlugins");
                const body = asObject(params);
                const agentId = readString(body, "agentId");
                const agent = requireAgent(findAgent, agentId);
                const pluginId = readString(body, "pluginId");
                const plugin = runner.listPlugins(agent).find((row) => row.pluginId === pluginId);
                if (plugin === undefined) throw new Error(`dynamic plugin "${pluginId}" does not exist`);
                const packageId = plugin.currentPackageId;
                if (packageId === undefined) {
                    throw new Error(`dynamic plugin "${pluginId}" has no current package to restore`);
                }
                const pkg = plugin.packages.find((row) => row.packageId === packageId);
                if (pkg === undefined) {
                    throw new Error(`dynamic plugin "${pluginId}" current package "${packageId}" does not exist`);
                }
                const started = asObject(await runner.runHostHalf(
                    agent,
                    pluginId,
                    packageId,
                    "run",
                    null,
                    false,
                ));
                if (started["ok"] !== true) return started;
                const pluginRunId = readString(started, "pluginRunId");
                const startedHere = started["startedHere"] !== false;
                if (pkg.hasClientHalf) {
                    rpc.notify("tui/user-run", {
                        agentId,
                        pluginId,
                        packageId,
                        pluginRunId,
                        startedHere,
                        mode: "run",
                        hasClientHalf: true,
                    });
                }
                return { ok: true, status: "starting", pluginId, packageId, pluginRunId };
            }),
        "acp-bridge: tui/start-plugin",
    );

    ctx.effect(
        () =>
            rpc.registerMethod("tui/settle-user-run", async (params) => {
                const runner = requireRunnerMethod(ctx, "settleUserRun");
                const body = asObject(params);
                const agent = requireAgent(findAgent, readString(body, "agentId"));
                return await runner.settleUserRun(
                    agent,
                    readString(body, "pluginId"),
                    body["resolution"],
                );
            }),
        "acp-bridge: tui/settle-user-run",
    );

    ctx.on("cordis/inspect-query", (request: { requestId?: unknown }) => {
        if (!advertisement.advertised) return;
        rpc.notify("tui/inspect-query", request);
    });
    ctx.on("cordis/inspect-query-resolved", (resolved: { requestId?: unknown }) => {
        if (!advertisement.advertised) return;
        rpc.notify("tui/inspect-query-resolved", resolved);
    });
    ctx.on("cordis/request-run", (request: { requestId?: unknown }) => {
        if (!advertisement.advertised) return;
        rpc.notify("tui/request-run", request);
    });
    ctx.on("cordis/request-run-resolved", (resolved: { requestId?: unknown }) => {
        if (!advertisement.advertised) return;
        rpc.notify("tui/request-run-resolved", resolved);
    });
    ctx.on("cordis/dynamic-retract", (retracted: { pluginId?: unknown }) => {
        if (!advertisement.advertised) return;
        rpc.notify("tui/dynamic-retract", retracted);
    });
}

function optionalInspect(ctx: Context): InspectRegistry | undefined {
    try {
        const value = ctx.get("cordisInspect") as InspectRegistry | undefined;
        return value !== undefined && typeof value.syncClientManifest === "function"
            ? value
            : undefined;
    } catch {
        // Optional: compositions without cordis-host-runner have no Client directory.
        return undefined;
    }
}

function optionalRunner(ctx: Context): DynamicRunner | undefined {
    try {
        const value = ctx.get("dynamicCordisRunner") as DynamicRunner | undefined;
        return value !== undefined && typeof value.runHostHalf === "function" ? value : undefined;
    } catch {
        // Optional: compositions without cordis-host-runner cannot run a Client half.
        return undefined;
    }
}

function requireRunnerMethod<K extends keyof DynamicRunner>(
    ctx: Context,
    method: K,
): DynamicRunner & Required<Pick<DynamicRunner, K>> {
    const runner = optionalRunner(ctx);
    if (runner === undefined || typeof runner[method] !== "function") {
        throw new Error(`this agent has no dynamic Cordis runner method ${String(method)}`);
    }
    return runner as DynamicRunner & Required<Pick<DynamicRunner, K>>;
}

function requireAgent(
    findAgent: (agentId: string) => Agent | undefined,
    agentId: string,
): Agent {
    const agent = findAgent(agentId);
    if (agent === undefined) throw new Error(`unknown agent: ${agentId}`);
    return agent;
}

function asObject(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("params must be an object");
    }
    return value as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value;
}

function readProviders(params: unknown): InspectProviderManifest[] {
    const body = asObject(params);
    const providers = body["providers"];
    if (!Array.isArray(providers)) throw new Error("providers must be an array");
    return providers.map((provider, index) => {
        if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
            throw new Error(`providers[${index}] must be an object`);
        }
        const row = provider as Record<string, unknown>;
        if (typeof row["id"] !== "string" || row["id"].trim() === "") {
            throw new Error(`providers[${index}].id must be a non-empty string`);
        }
        if (typeof row["description"] !== "string" || row["description"].trim() === "") {
            throw new Error(`providers[${index}].description must be a non-empty string`);
        }
        if (!Array.isArray(row["methods"])) {
            throw new Error(`providers[${index}].methods must be an array`);
        }
        return provider as InspectProviderManifest;
    });
}

declare module "@deepseek-ai/cordis" {
    interface Events {
        "cordis/inspect-query"(request: unknown): void;
        "cordis/inspect-query-resolved"(resolved: unknown): void;
        "cordis/request-run"(request: unknown): void;
        "cordis/request-run-resolved"(resolved: unknown): void;
        "cordis/dynamic-retract"(retracted: unknown): void;
    }
}
