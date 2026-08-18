/**
 * The DeepSeek Harness ACP bridge — an editor-grade Agent Client Protocol
 * server over JSON-RPC stdio, mounted as a cordis plugin inside a booted
 * harness composition.
 *
 * Where the in-repo `@deepseek-ai/dsh-acp` bridge is automation-only
 * (committed text, nothing else), this bridge maps the full session-event
 * stream onto the ACP vocabulary:
 *
 * - streamed assistant text and reasoning (`agent_message_chunk` /
 *   `agent_thought_chunk`), with assembled-message fallback
 * - tool calls with kinds, titles, file locations, raw I/O, and fs diffs
 * - `todo_write` plans, token usage, session titles
 * - real cancellation (`agent.cancel`), permission requests, sandbox-mode
 *   session modes, model switching via session config options
 * - `session/load` with full history replay from JSONL persistence,
 *   `session/list` from the same store
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import {
    AgentSideConnection,
    ndJsonStream,
    PROTOCOL_VERSION,
    RequestError,
    type Agent as AcpAgent,
    type AuthenticateRequest,
    type AuthMethod,
    type CancelNotification,
    type CloseSessionRequest,
    type InitializeRequest,
    type InitializeResponse,
    type ListSessionsRequest,
    type ListSessionsResponse,
    type LoadSessionRequest,
    type LoadSessionResponse,
    type LogoutRequest,
    type NewSessionRequest,
    type NewSessionResponse,
    type PromptRequest,
    type PromptResponse,
    type SessionConfigOption,
    type SessionInfo,
    type SessionModeState,
    type SetSessionConfigOptionRequest,
    type SetSessionConfigOptionResponse,
    type SetSessionModeRequest,
    type SetSessionModeResponse,
    type StopReason,
    type Stream,
} from "@agentclientprotocol/sdk";
import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import type { SessionId, SessionEvent } from "@deepseek-ai/dsh-session";
import type { foldSessionTitle } from "@deepseek-ai/dsh-session-title";
import type { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
// Side-effect type imports: declaration-merge the approval waterfall and agent events.
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-agent-presets";
import type { SubagentRunEndInfo, SubagentRunInfo } from "@deepseek-ai/dsh-subagent";

import { VERSION } from "../version.ts";
import {
    advertisedAuthMethods,
    apiKeyFromAuthenticate,
    credentialBaseUrlName,
    credentialEnvNames,
    gatewayFromAuthenticate,
    isBrowserAuthMethod,
    isGatewayAuthMethod,
    primaryCredentialName,
    providerFromAuthMethodId,
    shouldOfferLocalAuthPage,
    type ClientAuthCapabilities,
    type ProviderRoute,
} from "../auth.ts";
import { openLocalAuthPage, startLocalAuthPage } from "../auth-page.ts";
import { logDebug, logWarn } from "../log.ts";
import { buildReplay } from "./history.ts";
import {
    attachmentIngestOf,
    convertPrompt,
    deliverPrompt,
    PromptImageError,
    UnsupportedPromptContentError,
} from "./prompt.ts";
import { SessionProjection, turnEndToStopReason, type HarnessEvent, type SessionUpdate } from "./translate.ts";
import { advertisesCordis, CORDIS_CAPABILITY } from "./cordis-protocol.ts";
import { AcpRpc, muxAcpStream } from "./rpc.ts";
import type { TuiClientAdvertisement } from "./tui-client.ts";
import * as tuiClientPlugin from "./tui-client-plugin.ts";
import * as userQuestionsPlugin from "./user-questions-plugin.ts";
import { presetDisplayName, type PresetRow } from "./presets.ts";
export {
    answerFromElicitation,
    askUserQuestionsOverAcp,
    installAcpUserQuestionProvider,
    questionsToElicitation,
} from "./user-questions.ts";

export const name = "acp-bridge";
/** Wait for the dsh-base services this bridge captures during apply. */
export const inject = ["agents", "credentials", "llm", "agentDefaultModel", "sessionPersistence", "approval", "permissionPresets", "commands", "agentPresets", "skills", "subagents", "userQuestions"];

/** Host functions the bridge needs beyond the plugin tree (see loadKit). */
export interface BridgeHarness {
    createUserMessage: typeof createUserMessage;
    errorChain: typeof errorChain;
    sessionId: typeof SessionId;
    foldSessionTitle: typeof foldSessionTitle;
    setSandboxMode: typeof setSandboxMode;
    sandboxModes: readonly SandboxMode[];
    /**
     * `installModelSelection` from `@deepseek-ai/dsh-agent` (optional seam):
     * couples one mutable selection to the agent's prompt assembly so
     * provider/model/reasoning-effort switches apply on the next step without
     * recreating the agent. Older hosts may not export it; the bridge then
     * hides the effort option and keeps resume-based model switching only.
     */
    installModelSelection?: (agentCtx: unknown, selection: ModelSelectionRef) => () => void;
    /**
     * The `@deepseek-ai/dsh-mcp-client` plugin module (optional seam). One
     * mounted instance connects to one MCP server and registers its tools on
     * `ctx.tools` as `mcp__<serverName>__<rawName>`; disposal disconnects and
     * unregisters. Absent on installations that predate the plugin.
     */
    mcpClient?: { apply: (ctx: never, config: never) => void };
}

export interface AcpBridgeConfig {
    /** Provider route for ACP-created agents; omitted = the composition's default. */
    provider?: string;
    /** Default model for ACP-created agents; omitted = the composition's default. */
    model?: string;
    /** Selectable model candidates surfaced as a session config option. */
    models?: string[];
    /** Optional per-request output-token cap. */
    maxTokens?: number;
    /** Initial sandbox mode advertised as the current ACP session mode. */
    permissionMode?: SandboxMode;
    /** Runtime-only transport override; production uses stdio. */
    stream?: Stream;
    /**
     * Host functions resolved from the DeepSeek Harness installation. The
     * standalone CLI injects these; bundle/profile mounts omit them and the
     * bridge imports its own copies (src/bridge/self-harness.ts).
     */
    harness?: BridgeHarness;
}

interface Inflight {
    resolve: (reason: StopReason) => void;
    reject: (error: Error) => void;
    messageId: string;
    turn: number | undefined;
}

/** One live model selection: provider route, model id, optional adapter-owned effort. */
export interface ModelSelectionValue {
    provider: string;
    model: string;
    reasoningEffort?: string;
}

/** Mutable selection snapshotted by prompt assembly (dsh-agent model-selection seam). */
export interface ModelSelectionRef {
    current: ModelSelectionValue | undefined;
    assembled: ModelSelectionValue | undefined;
}

type ApprovalPolicy = "ask" | "never";

interface SessionRecord {
    agent: Agent;
    dispose: () => Promise<void>;
    projection: SessionProjection;
    modeId: SandboxMode;
    /** Selected model; undefined = the composition's default route. */
    model: string | undefined;
    /** Selected provider route; undefined = the configured default. */
    provider?: string;
    /** User-picked reasoning effort for this session; undefined = adapter/default behavior. */
    effort?: string;
    /** Current permission policy: "ask" prompts, "never" auto-approves. */
    approvals: ApprovalPolicy;
    /** Installed model-selection ref (lazy; created on the first effort/model pick). */
    selection?: ModelSelectionRef;
    /** Agent preset joined at creation; undefined = deployment without a roster. */
    preset?: string;
    cancelled: boolean;
    inflight: Inflight | undefined;
}

function invalidParams(detail: string): RequestError {
    // Detail travels in the wire error message (second arg); the first is data.
    return RequestError.invalidParams(undefined, detail);
}

function internalError(detail: string): RequestError {
    return RequestError.internalError(undefined, detail);
}

function authRequired(detail: string): RequestError {
    return RequestError.authRequired(undefined, detail);
}

const MODE_LABELS: Record<SandboxMode, { name: string; description: string }> = {
    "read-only": { name: "Read-only", description: "Bash and file mutations are denied by the sandbox" },
    "workspace-write": {
        name: "Workspace write",
        description: "Writes are confined to the session workspace; wider access asks for permission",
    },
    "danger-full-access": {
        name: "Full access",
        description: "No sandbox confinement and no permission prompts",
    },
};

/**
 * Mount the ACP bridge.
 *
 * @param ctx - cordis context carrying the injected dsh-base services.
 * @param config - provider/model selection and optional test transport.
 */
export async function apply(ctx: Context, config: AcpBridgeConfig = {}): Promise<void> {
    // Capture injected services during apply; handlers run outside the scope.
    const agents = ctx.agents;
    const credentials = ctx.credentials;
    const llm = ctx.llm;
    const agentDefaultModel = ctx.agentDefaultModel;
    const sessionPersistence = ctx.sessionPersistence;
    const approval = ctx.approval;
    const permissionPresets = ctx.permissionPresets;
    const commandRuntime = ctx.commands;
    const agentPresets = ctx.agentPresets;
    const skillRegistry = ctx.skills;
    const subagents = ctx.subagents;
    const harness = config.harness ?? (await import("./self-harness.ts")).selfHarness();
    const { createUserMessage, errorChain, sessionId: SessionId, foldSessionTitle, setSandboxMode } = harness;
    const SANDBOX_MODES = harness.sandboxModes;
    const sessions = new Map<string, SessionRecord>();
    interface LiveSubagent {
        rootSessionId: string;
        childSessionId: string;
        runId: string;
        provider: string;
        toolCallId: string;
        projection: SessionProjection;
    }
    const subagentByChild = new Map<string, LiveSubagent>();
    const subagentByRun = new Map<string, LiveSubagent>();
    const watchedSubagentParents = new WeakSet<object>();
    let closed = false;
    let conn: AgentSideConnection;
    /** Whether the client renders `_meta.terminal_output` display terminals. */
    let clientTerminalOutput = false;
    /** Whether the client wants nested child text/thought/tool updates. */
    let clientSubagentTranscript = false;
    /** Whether the client can render standard ACP form elicitation. */
    let clientElicitationForm = false;
    const tuiClient: TuiClientAdvertisement = { advertised: false };
    const rpc = new AcpRpc();
    const findAgent = (agentId: string): Agent | undefined => {
        const fromRegistry = agents.get(agentId as never);
        if (fromRegistry !== undefined) return fromRegistry;
        for (const record of sessions.values()) {
            if (record.agent.id === agentId) return record.agent;
        }
        return undefined;
    };
    await ctx.plugin(tuiClientPlugin, { rpc, findAgent, advertisement: tuiClient });

    const modelCandidates = (): string[] => {
        const seen = new Set<string>();
        if (config.model !== undefined) seen.add(config.model);
        for (const model of config.models ?? []) if (model.trim().length > 0) seen.add(model.trim());
        return [...seen];
    };

    // ------------------------------------------------------------------ //
    // Model catalog (static config ∪ live adapter directory)              //
    // ------------------------------------------------------------------ //

    /**
     * One selectable model. Values are encoded as the bare model id on the
     * default provider (stable for existing clients) and `provider::model`
     * on any other route — which is how third-party providers configured in
     * the dsh Web UI (an `llm-pi-ai:` settings section) become selectable
     * here the moment their routes register.
     */
    interface ModelChoice {
        provider: string | undefined;
        model: string;
        label: string;
    }

    /** The composition's default selection (agent-default-model → settings.yaml). */
    const defaultSelection = (): { provider?: string; model?: string; reasoningEffort?: string } => {
        try {
            return agentDefaultModel.currentSelection();
        } catch (error: unknown) {
            logDebug(`agentDefaultModel.currentSelection failed: ${String(error)}`);
            return {};
        }
    };

    const defaultProvider = (): string | undefined => config.provider ?? defaultSelection().provider;

    const encodeChoice = (provider: string | undefined, model: string): string =>
        provider === undefined || provider === defaultProvider() ? model : `${provider}::${model}`;

    const decodeChoice = (value: string): { provider: string | undefined; model: string } => {
        const i = value.indexOf("::");
        if (i <= 0) return { provider: defaultProvider(), model: value };
        return { provider: value.slice(0, i), model: value.slice(i + 2) };
    };

    /** Cached adapter directory; invalidated by `llm/adapters-updated`. */
    let liveCatalog: ModelChoice[] | undefined;

    /** Per-route reasoning-effort metadata; invalidated with the catalog. */
    interface EffortCatalog {
        efforts: { id: string; name: string; description?: string }[];
        defaultEffort?: string;
    }
    const effortCache = new Map<string, EffortCatalog | undefined>();

    const discoverModels = async (): Promise<ModelChoice[]> => {
        if (liveCatalog !== undefined) return liveCatalog;
        const found: ModelChoice[] = [];
        try {
            const providers = llm.listProviders();
            const multi = providers.length > 1;
            for (const provider of providers) {
                const models = await llm.listModels(provider.id).catch((error: unknown) => {
                    logDebug(`listModels(${provider.id}) failed: ${String(error)}`);
                    return [];
                });
                for (const model of models) {
                    found.push({
                        provider: provider.id,
                        model: model.id,
                        label: multi ? `${model.name} (${provider.name})` : model.name,
                    });
                }
            }
        } catch (error: unknown) {
            logDebug(`model discovery failed: ${String(error)}`);
        }
        liveCatalog = found;
        return found;
    };

    ctx.on("llm/adapters-updated", () => {
        // A settings edit (Web UI Models page) registered or withdrew routes;
        // rebuild on next use so new third-party models appear immediately.
        liveCatalog = undefined;
        effortCache.clear();
    });

    /**
     * The session's effective provider/model route: explicit session picks
     * first, then bridge config, then the composition default, then the last
     * logged request header (accurate once a request ran).
     */
    const routeOf = (record: SessionRecord): { provider?: string; model?: string } => {
        const logged = loggedConfig(record);
        const provider = record.provider ?? defaultProvider() ?? logged?.provider;
        const model =
            record.model ??
            config.model ??
            defaultSelection().model ??
            logged?.model ??
            record.agent.options.model;
        return {
            ...(provider !== undefined ? { provider } : {}),
            ...(model !== undefined ? { model } : {}),
        };
    };

    /** The conversation's last logged call config (provider/model/effort), when any request ran. */
    const loggedConfig = (
        record: SessionRecord,
    ): { provider: string; model: string; reasoningEffort?: string } | undefined => {
        try {
            const header = (
                record.agent.session as unknown as {
                    requestHeader?: () => { config?: { provider: string; model: string; reasoningEffort?: unknown } } | undefined;
                }
            ).requestHeader?.();
            const cfg = header?.config;
            if (cfg === undefined) return undefined;
            return {
                provider: cfg.provider,
                model: cfg.model,
                ...(cfg.reasoningEffort !== undefined ? { reasoningEffort: String(cfg.reasoningEffort) } : {}),
            };
        } catch {
            return undefined;
        }
    };

    /** Selectable reasoning efforts for one exact route, from the owning adapter. */
    const effortCatalog = async (
        provider: string | undefined,
        model: string | undefined,
    ): Promise<EffortCatalog | undefined> => {
        if (provider === undefined || model === undefined) return undefined;
        const key = `${provider}::${model}`;
        if (effortCache.has(key)) return effortCache.get(key);
        let catalog: EffortCatalog | undefined;
        try {
            const reasoning = (await llm.resolveModelInfo(provider, model)).reasoning;
            if (reasoning !== undefined && reasoning.efforts.length > 0) {
                catalog = {
                    efforts: reasoning.efforts.map((effort) => ({
                        id: String(effort.id),
                        name: effort.name,
                        ...(effort.description !== undefined ? { description: effort.description } : {}),
                    })),
                    ...(reasoning.defaultEffort !== undefined
                        ? { defaultEffort: String(reasoning.defaultEffort) }
                        : {}),
                };
            }
        } catch (error: unknown) {
            logDebug(`resolveModelInfo(${key}) failed: ${String(error)}`);
        }
        effortCache.set(key, catalog);
        return catalog;
    };

    /**
     * Install (once per live agent) the mutable selection prompt assembly
     * snapshots. Reads fall back to the logged header, then the session's
     * route composed with the product-default reasoning effort (the Web UI
     * saved selection), so an untouched session runs exactly what the other
     * dsh entry points (web, headless) would run.
     */
    const ensureSelection = (record: SessionRecord): ModelSelectionRef | undefined => {
        const install = harness.installModelSelection;
        if (install === undefined) return undefined;
        if (record.selection !== undefined) return record.selection;
        let picked: ModelSelectionValue | undefined;
        const selection: ModelSelectionRef = {
            get current(): ModelSelectionValue | undefined {
                if (picked !== undefined) return picked;
                const logged = loggedConfig(record);
                if (logged !== undefined) return logged;
                const { provider, model } = routeOf(record);
                if (provider === undefined || model === undefined) return undefined;
                const defaults = defaultSelection();
                // Effort applies when the route is the default selection's own
                // model (or the default names no model): a explicitly pinned
                // different model keeps its adapter-default behavior.
                const effort =
                    defaults.model === undefined || defaults.model === model
                        ? defaults.reasoningEffort
                        : undefined;
                return { provider, model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) };
            },
            set current(next: ModelSelectionValue | undefined) {
                picked = next;
            },
            assembled: undefined,
        };
        try {
            install((record.agent as unknown as { ctx: unknown }).ctx, selection);
        } catch (error: unknown) {
            logWarn(`installModelSelection failed: ${String(error)}`);
            return undefined;
        }
        record.selection = selection;
        return selection;
    };

    /**
     * Resume-based model switching: model options are fixed at agent
     * construction, so swap by resuming the same durable session under new
     * options. A picked reasoning effort survives when the new route offers it.
     */
    const switchModel = async (record: SessionRecord, acpSessionId: string, value: string): Promise<void> => {
        if (record.inflight !== undefined) {
            throw invalidParams("cannot switch models while a prompt is running");
        }
        const choice = decodeChoice(value);
        const known = new Set<string>([
            ...modelCandidates().map((model) => encodeChoice(undefined, model)),
            ...(await discoverModels()).map((entry) => encodeChoice(entry.provider, entry.model)),
            encodeChoice(record.provider, record.model ?? ""),
        ]);
        if (!known.has(value)) throw invalidParams(`unknown model: ${value}`);
        if (choice.model === record.model && choice.provider === (record.provider ?? defaultProvider())) return;
        const sessionId = record.agent.session.id;
        await record.dispose().catch((error: unknown) => {
            logWarn(`dispose during model switch failed: ${String(error)}`);
        });
        let handle;
        try {
            const presets = presetsService();
            handle = await agents.resume({
                resumeSessionId: sessionId,
                agentOptions: agentOptionsFor(choice.model, choice.provider),
                ...(presetSetup(presets, record.preset) !== undefined
                    ? { setup: presetSetup(presets, record.preset) }
                    : {}),
            } as Parameters<typeof agents.resume>[0]);
        } catch (error: unknown) {
            sessions.delete(acpSessionId);
            throw internalError(`model switch failed: ${errorChain(error)}`);
        }
        record.agent = handle.agent;
        record.dispose = () => handle.dispose();
        record.model = choice.model;
        if (choice.provider !== undefined && choice.provider !== defaultProvider()) {
            record.provider = choice.provider;
        } else {
            delete record.provider;
        }
        // The old selection ref died with the disposed agent's scope; reinstall
        // immediately so the default reasoning effort keeps applying.
        delete record.selection;
        ensureSelection(record);
        if (record.effort !== undefined) {
            const route = routeOf(record);
            const catalog = await effortCatalog(route.provider, route.model);
            if (
                catalog?.efforts.some((effort) => effort.id === record.effort) === true &&
                route.provider !== undefined &&
                route.model !== undefined
            ) {
                const selection = ensureSelection(record);
                if (selection !== undefined) {
                    selection.current = {
                        provider: route.provider,
                        model: route.model,
                        reasoningEffort: record.effort,
                    };
                }
            } else {
                // The new route does not offer the picked effort; fall back to
                // its default instead of failing every request.
                delete record.effort;
            }
        }
        // Approval policy is agent-scoped state; re-apply it to the new agent.
        setApprovalPolicy(record, record.approvals);
    };

    /**
     * Live adapter directory. Third-party routes configured in the dsh Web UI
     * (`llm-pi-ai:` settings) show up here the moment they register.
     */
    const listProviderRoutes = async (): Promise<ProviderRoute[]> => {
        try {
            const raw = llm.listProviders();
            if (!Array.isArray(raw)) return [];
            return raw.flatMap((entry) => {
                if (!entry || typeof entry !== "object") return [];
                const id = (entry as { id?: unknown }).id;
                if (typeof id !== "string" || id.length === 0) return [];
                const name = (entry as { name?: unknown }).name;
                return [{ id, ...(typeof name === "string" && name.length > 0 ? { name } : {}) }];
            });
        } catch (error: unknown) {
            logDebug(`listProviders failed: ${String(error)}`);
            return [];
        }
    };

    const credentialPresent = async (provider?: string): Promise<boolean> => {
        const names = credentialEnvNames(provider).filter((name) => !name.endsWith("_BASE_URL"));
        for (const name of names) {
            try {
                if ((await credentials.resolve(credentialRef(name))) !== undefined) return true;
            } catch (error: unknown) {
                logWarn(`credential lookup failed: ${String(error)}`);
            }
        }
        return false;
    };

    const requireCredential = async (provider?: string): Promise<void> => {
        if (await credentialPresent(provider)) return;
        throw authRequired(
            "no credential found for this provider: call authenticate with `_meta[\"api-key\"].apiKey` or `_meta.gateway`, use the browser method, run `dsh-acp login`, or save a key in the dsh Web UI (Settings → Models)",
        );
    };

    const agentOptionsFor = (
        model: string | undefined,
        provider?: string,
    ): { provider?: string; model?: string; maxTokens?: number } => ({
        ...(provider !== undefined
            ? { provider }
            : config.provider !== undefined
              ? { provider: config.provider }
              : {}),
        ...(model !== undefined ? { model } : {}),
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    });

    /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
    const ownedRecord = (agent: Agent): SessionRecord | undefined => {
        const record = sessions.get(String(agent.session.id));
        return record?.agent === agent ? record : undefined;
    };

    const requireSession = (sessionId: string): SessionRecord => {
        const record = sessions.get(sessionId);
        if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`);
        return record;
    };

    /**
     * The session record, restored from the persisted log when the process
     * no longer holds it live. Zed keeps threads across agent restarts and
     * may prompt an old session without `session/load` first; recovering
     * silently (no history replay — the client already renders it) beats
     * failing the turn with `unknown session`.
     */
    const requireOrRestoreSession = async (sessionId: string): Promise<SessionRecord> => {
        const record = sessions.get(sessionId);
        if (record !== undefined) return record;
        logWarn(`restoring session ${sessionId} from the persisted log`);
        try {
            return await restoreSession(sessionId, { replay: false });
        } catch (error: unknown) {
            throw invalidParams(`unknown session: ${sessionId} (${errorChain(error)})`);
        }
    };

    /**
     * Resume one persisted session into a live record: inspect the log,
     * optionally replay its history to the client, rebuild the agent with
     * its stored preset, and fold logged permission facts. Shared by
     * `session/load` (replay: true) and silent restore (replay: false).
     */
    const restoreSession = async (
        sessionId: string,
        options: { replay: boolean; cwd?: string },
    ): Promise<SessionRecord> => {
        const persistence = requirePersistence();
        const existing = sessions.get(sessionId);
        if (existing !== undefined) {
            // Reloading an open session: drop the live agent first so
            // resume owns the log exclusively.
            sessions.delete(sessionId);
            existing.agent.cancel({ kind: "user" });
            settlePrompt(existing, "cancelled");
            await existing.dispose().catch((error: unknown) => {
                logWarn(`dispose before reload failed: ${String(error)}`);
            });
        }
        let events: readonly SessionEvent[];
        let storedHeader: { agentPreset?: string; cwd?: string } | undefined;
        try {
            const inspected = await persistence.inspect(SessionId(sessionId));
            events = inspected.events;
            storedHeader = (inspected as unknown as { header?: { agentPreset?: string; cwd?: string } }).header;
        } catch (error: unknown) {
            throw invalidParams(`session not found: ${sessionId} (${errorChain(error)})`);
        }
        const replay = buildReplay(events as unknown as HarnessEvent[]);
        if (options.replay) {
            for (const update of replay.updates) notify(sessionId, update);
            if (replay.title !== undefined) {
                notify(sessionId, {
                    sessionUpdate: "session_info_update",
                    title: replay.title,
                });
            }
        }
        const presets = presetsService();
        const storedPreset = presetFromLog(storedHeader, events as unknown as { type?: string }[]);
        const presetId = (await presets.resolve(storedPreset)).id;
        const handle = await agents.resume({
            resumeSessionId: SessionId(sessionId),
            agentOptions: agentOptionsFor(config.model),
            ...(presetSetup(presets, presetId) !== undefined ? { setup: presetSetup(presets, presetId) } : {}),
        } as Parameters<typeof agents.resume>[0]);
        const cwd = options.cwd ?? storedHeader?.cwd;
        const projection = new SessionProjection(replay.contextWindow, {
            terminalOutput: clientTerminalOutput,
            ...(cwd !== undefined ? { cwd } : {}),
        });
        projection.title = replay.title;
        const record = registerRecord(
            sessionId,
            handle.agent,
            () => handle.dispose(),
            config.model,
            config.permissionMode ?? "workspace-write",
            projection,
        );
        if (presetId !== undefined) record.preset = presetId;
        // Permission facts are logged and replayed (permission/preset,
        // sandbox/mode, approval/policy events); mirror the service folds
        // so the advertised state matches what is enforced.
        {
            const permission = permissionService();
            const storedMode = permission.current(events as unknown as unknown[]);
            if (storedMode !== undefined) record.modeId = storedMode as SandboxMode;
            for (let index = events.length - 1; index >= 0; index -= 1) {
                const event = events[index] as unknown as { type?: string; data?: { policy?: string } };
                if (event?.type === "approval/policy") {
                    const policy = event.data?.policy;
                    if (policy === "ask" || policy === "never") record.approvals = policy;
                    break;
                }
            }
        }
        ensureSelection(record);
        queueMicrotask(() => publishCommands(sessionId));
        return record;
    };

    const assertOpen = (): void => {
        if (closed) throw internalError("the ACP bridge has been disposed");
    };

    /** Send one update without letting a disconnected client fail an agent turn. */
    const notify = (sessionId: string, update: SessionUpdate): void => {
        void conn.sessionUpdate({ sessionId, update }).catch((error: unknown) => {
            logWarn(`session/update failed: ${String(error)}`);
        });
    };

    const settlePrompt = (record: SessionRecord, reason: StopReason): void => {
        const inflight = record.inflight;
        if (inflight === undefined) return;
        record.inflight = undefined;
        inflight.resolve(reason);
    };

    /** Observe one parent agent's scoped subagent lifecycle. */
    const watchSubagentParent = (parent: Agent): void => {
        if (watchedSubagentParents.has(parent as object)) return;
        watchedSubagentParents.add(parent as object);

        parent.ctx.on("subagent/start", (info: SubagentRunInfo) => {
            const parentLink = subagentByChild.get(String(parent.id));
            const rootSessionId = parentLink?.rootSessionId ?? String(parent.session.id);
            const record = sessions.get(rootSessionId);
            if (record === undefined) return;

            const runId = String(info.runId);
            const childSessionId = String(info.id);
            const toolCallId = `subagent:${runId}`;
            const payload: Record<string, unknown> = {
                runId,
                provider: info.provider,
                id: childSessionId,
                local: info.local,
                ...(parentLink !== undefined ? { parentToolCallId: parentLink.toolCallId } : {}),
            };
            for (const update of record.projection.onEvent({ type: "subagent/start", data: payload })) {
                notify(rootSessionId, update);
            }

            const child = agents.get(info.id);
            const link: LiveSubagent = {
                rootSessionId,
                childSessionId,
                runId,
                provider: info.provider,
                toolCallId,
                projection: new SessionProjection(undefined, {
                    terminalOutput: clientTerminalOutput,
                    ...(child?.session.header.cwd !== undefined ? { cwd: child.session.header.cwd } : {}),
                    subagent: { childSessionId, parentToolCallId: toolCallId, provider: info.provider },
                }),
            };
            subagentByChild.set(childSessionId, link);
            subagentByRun.set(runId, link);
            if (child !== undefined) watchSubagentParent(child);
        });

        parent.ctx.on("subagent/end", (info: SubagentRunEndInfo) => {
            const runId = String(info.runId);
            const link = subagentByRun.get(runId);
            if (link === undefined) return;
            const record = sessions.get(link.rootSessionId);
            if (record !== undefined) {
                const parentLink = subagentByChild.get(String(parent.id));
                const payload: Record<string, unknown> = {
                    runId,
                    provider: info.provider,
                    id: String(info.id),
                    local: info.local,
                    stopReason: info.stopReason,
                    ...(info.lastAssistantMessage !== undefined
                        ? { lastAssistantMessage: info.lastAssistantMessage }
                        : {}),
                    ...(parentLink !== undefined ? { parentToolCallId: parentLink.toolCallId } : {}),
                };
                for (const update of record.projection.onEvent({ type: "subagent/end", data: payload })) {
                    notify(link.rootSessionId, update);
                }
            }
            subagentByRun.delete(runId);
            if (subagentByChild.get(link.childSessionId)?.runId === runId) {
                subagentByChild.delete(link.childSessionId);
            }
        });
    };

    // ------------------------------------------------------------------ //
    // Agent presets (session modes → preset compositions)                 //
    // ------------------------------------------------------------------ //

    /**
     * The optional `agentPresets` roster (mounted by the profile patch; the
     * dsh CLI injects its shipped root — standard/code/minimal/creator — into
     * any row with this id). Each preset is one model-facing composition
     * (persona, tools, compaction) that an agent joins at creation, so ACP
     * session modes map onto it: pick "minimal" in the client and the next
     * turn runs the two-tool fixed-prompt agent, exactly like the Web UI.
     */
    interface AgentPresetsService {
        list(): Promise<PresetRow[]>;
        resolve(id?: string): Promise<{ id: string }>;
        mount(agentCtx: unknown, id: string): Promise<void>;
    }

    const presetsService = (): AgentPresetsService => agentPresets as unknown as AgentPresetsService;

    /** Agent-create/resume `setup` joining one preset; undefined without a roster. */
    const presetSetup = (
        presets: AgentPresetsService,
        presetId: string | undefined,
    ): ((agentCtx: unknown) => Promise<void>) | undefined => {
        if (presetId === undefined) return undefined;
        return async (agentCtx: unknown) => {
            const started = performance.now();
            logDebug(`preset setup: mounting "${presetId}"`);
            await presets.mount(agentCtx, presetId);
            logDebug(`preset setup: mounted "${presetId}" in ${(performance.now() - started).toFixed(1)}ms`);
        };
    };

    /** Last selected preset in a stored log, else the creation-time header fact. */
    const presetFromLog = (
        header: { agentPreset?: string } | undefined,
        events: readonly { type?: string; data?: unknown }[],
    ): string | undefined => {
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (event?.type === "agent-preset/selected") {
                return (event.data as { agentPreset?: string } | undefined)?.agentPreset;
            }
        }
        return header?.agentPreset;
    };

    /** Sandbox confinement levels: the session-mode selector, always. */
    const modeState = (record: SessionRecord): SessionModeState => {
        const permission = permissionService();
        if (permission.names.length > 0) {
            return {
                currentModeId: record.modeId,
                availableModes: permission.names.map((name) => {
                    const spec = permission.resolve(name);
                    return { id: name, name: spec.name, description: spec.description };
                }),
            };
        }
        return {
            currentModeId: record.modeId,
            availableModes: SANDBOX_MODES.map((mode) => {
                const label = MODE_LABELS[mode] ?? { name: mode, description: "" };
                return { id: mode, name: label.name, description: label.description };
            }),
        };
    };

    /**
     * Switch the agent preset: rebuild the agent over the same session so the
     * new composition joins from the next turn. Record the durable
     * `agent-preset/selected` fact only after the new composition mounts — a
     * failed mount must not poison the log or drop the live session.
     */
    const switchPreset = async (record: SessionRecord, acpSessionId: string, presetId: string): Promise<void> => {
        if (record.inflight !== undefined) {
            throw invalidParams("cannot switch presets while a prompt is running");
        }
        const presets = presetsService();
        let resolved: string;
        try {
            resolved = (await presets.resolve(presetId)).id;
        } catch (error: unknown) {
            throw invalidParams(`unknown preset: ${presetId} (${errorChain(error)})`);
        }
        if (resolved === record.preset) return;
        const previous = record.preset;
        const sessionId = record.agent.session.id;
        const resumeWith = (id: string | undefined) =>
            agents.resume({
                resumeSessionId: sessionId,
                agentOptions: agentOptionsFor(record.model ?? config.model, record.provider),
                ...(presetSetup(presets, id) !== undefined ? { setup: presetSetup(presets, id) } : {}),
            } as Parameters<typeof agents.resume>[0]);
        await record.dispose().catch((error: unknown) => {
            logWarn(`dispose during preset switch failed: ${String(error)}`);
        });
        let handle: Awaited<ReturnType<typeof resumeWith>>;
        try {
            handle = await resumeWith(resolved);
        } catch (error: unknown) {
            try {
                handle = await resumeWith(previous);
            } catch (restoreError: unknown) {
                sessions.delete(acpSessionId);
                throw internalError(
                    `preset switch failed: ${errorChain(error)}; restore also failed: ${errorChain(restoreError)}`,
                );
            }
            record.agent = handle.agent;
            record.dispose = () => handle.dispose();
            delete record.selection;
            ensureSelection(record);
            setApprovalPolicy(record, record.approvals);
            publishCommands(acpSessionId, record);
            throw invalidParams(`preset "${resolved}" failed to mount: ${errorChain(error)}`);
        }
        record.agent = handle.agent;
        record.dispose = () => handle.dispose();
        record.preset = resolved;
        try {
            (
                handle.agent.session as unknown as {
                    append(type: string, data: unknown): unknown;
                }
            ).append("agent-preset/selected", { agentPreset: resolved });
        } catch (error: unknown) {
            logWarn(`recording preset selection failed: ${String(error)}`);
        }
        delete record.selection;
        ensureSelection(record);
        // Approval policy is agent-scoped state; re-apply it to the new agent.
        setApprovalPolicy(record, record.approvals);
        publishCommands(acpSessionId, record);
    };

    /** Flip the per-agent approval policy, mirroring the result on the record. */
    const setApprovalPolicy = (record: SessionRecord, policy: ApprovalPolicy): void => {
        try {
            approval.setPolicy(record.agent, policy);
        } catch (error: unknown) {
            logWarn(`approval policy switch failed: ${String(error)}`);
        }
        record.approvals = policy;
    };

    /** Apply one sandbox mode: confinement, coupled approval default, mode update. */
    /**
     * The permission-presets service: the product's ONE user-facing
     * permission concept. Each named preset bundles a sandbox confinement
     * with its approval policy (read-only/ask, workspace-write/ask,
     * danger-full-access/never by default — deployments can reconfigure the
     * table). The Web UI and TUI surface exactly these presets and never a
     * standalone approval toggle; the session-mode selector mirrors that.
     */
    interface PermissionPresetsService {
        names: string[];
        resolve(name: string): { sandbox: SandboxMode; approval: ApprovalPolicy; name: string; description: string };
        current(events: readonly unknown[]): string | undefined;
        apply(session: unknown, name: string, setApproval: (policy: ApprovalPolicy) => void): void;
    }

    const permissionService = (): PermissionPresetsService =>
        permissionPresets as unknown as PermissionPresetsService;

    const applyMode = (record: SessionRecord, sessionId: string, modeId: string): void => {
        const permission = permissionService();
        if (permission.names.includes(modeId)) {
            // The authoritative path: records the durable permission/preset
            // fact, applies the sandbox, and writes the bundled approval
            // policy through the live agent.
            let bundledApproval: ApprovalPolicy = record.approvals;
            permission.apply(record.agent.session, modeId, (policy) => {
                bundledApproval = policy;
            });
            setApprovalPolicy(record, bundledApproval);
            record.modeId = permission.resolve(modeId).sandbox;
            notify(sessionId, { sessionUpdate: "current_mode_update", currentModeId: modeId });
            return;
        }
        const mode = SANDBOX_MODES.find((candidate) => candidate === modeId);
        if (mode === undefined) throw invalidParams(`unknown mode: ${modeId}`);
        setSandboxMode(record.agent.session, mode);
        setApprovalPolicy(record, mode === "danger-full-access" ? "never" : "ask");
        record.modeId = mode;
        notify(sessionId, { sessionUpdate: "current_mode_update", currentModeId: mode });
    };

    /** The model-select entries: adapter directory first, then static config. */
    const modelChoices = async (record: SessionRecord): Promise<{ value: string; name: string }[]> => {
        const seen = new Set<string>();
        const options: { value: string; name: string }[] = [];
        const push = (value: string, name: string): void => {
            if (seen.has(value)) return;
            seen.add(value);
            options.push({ value, name });
        };
        const current = encodeChoice(
            record.provider,
            record.model ?? config.model ?? defaultSelection().model ?? record.agent.options.model ?? "",
        );
        if (current.length === 0) return [];
        // Adapter directory first: it carries human names and third-party
        // routes. Static config and the current selection are backstops.
        const discovered = await discoverModels();
        push(current, discovered.find((c) => encodeChoice(c.provider, c.model) === current)?.label ?? current);
        for (const choice of discovered) {
            push(encodeChoice(choice.provider, choice.model), choice.label);
        }
        for (const model of modelCandidates()) push(encodeChoice(undefined, model), model);
        return options;
    };

    /**
     * Session config options: sandbox mode, model, reasoning effort, and
     * approvals. Everything lives here (not only in `modes`) because clients
     * that support config options — Zed — drop the `modes` state entirely
     * when any config option is present.
     */
    const configOptions = async (record: SessionRecord): Promise<SessionConfigOption[]> => {
        const result: SessionConfigOption[] = [];

        // The permission level (the product's one user-facing {sandbox,
        // approval} dimension) ALSO travels as a config option: session modes
        // carry the same state for clients that render them, but some (Zed
        // among them) only surface config options.
        {
            const permission = permissionService();
            const levels =
                permission.names.length > 0
                    ? permission.names.map((name) => {
                          const spec = permission.resolve(name);
                          return { value: name, name: spec.name, description: spec.description };
                      })
                    : SANDBOX_MODES.map((mode) => {
                          const label = MODE_LABELS[mode] ?? { name: mode, description: "" };
                          return { value: mode, name: label.name, description: label.description };
                      });
            result.push({
                type: "select",
                id: "mode",
                name: "Permissions",
                category: "mode",
                currentValue: record.modeId,
                options: levels,
            });
        }

        if (commandRuntime.list(record.agent).some((command) => command.name === "plan")) {
            const active = [...record.agent.session.events]
                .reverse()
                .map((event) => event as unknown as HarnessEvent)
                .find((event) => event.type === "plan/mode")?.data?.["active"] === true;
            result.push({
                type: "select",
                id: "collaboration_mode",
                name: "Collaboration mode",
                currentValue: active ? "plan" : "default",
                options: [
                    { value: "default", name: "Default" },
                    { value: "plan", name: "Plan" },
                ],
            });
        }

        const models = await modelChoices(record);
        if (models.length >= 2) {
            result.push({
                type: "select",
                id: "model",
                name: "Model",
                category: "model",
                currentValue: models[0]!.value,
                options: models,
            });
        }

        const route = routeOf(record);
        const efforts = await effortCatalog(route.provider, route.model);
        if (efforts !== undefined && efforts.efforts.length >= 2) {
            const known = new Set(efforts.efforts.map((effort) => effort.id));
            const preferred = [
                record.effort,
                loggedConfig(record)?.reasoningEffort,
                // The user's saved product default (Web UI → settings.yaml),
                // e.g. reasoningEffort: max, outranks the adapter's default.
                defaultSelection().reasoningEffort,
                efforts.defaultEffort,
            ].find(
                (candidate): candidate is string => candidate !== undefined && known.has(candidate),
            );
            result.push({
                type: "select",
                id: "effort",
                name: "Reasoning",
                category: "thought_level",
                currentValue: preferred ?? efforts.efforts[0]!.id,
                options: efforts.efforts.map((effort) => ({
                    value: effort.id,
                    name: effort.name,
                    ...(effort.description !== undefined ? { description: effort.description } : {}),
                })),
            });
        }

        // Agent presets: one model-facing composition (persona, tool surface,
        // compaction) per entry. ACP has no icon on configOptions; clients
        // special-case `id: "agent"` / `name: "Agent"`.
        const presets = presetsService();
        if (record.preset !== undefined) {
            try {
                const roster = await presets.list();
                if (roster.length >= 2) {
                    result.push({
                        type: "select",
                        id: "agent",
                        name: "Agent",
                        currentValue: record.preset,
                        options: roster.map((preset) => ({
                            value: preset.id,
                            name: presetDisplayName(preset),
                            description: `Agent preset “${preset.id}”`,
                        })),
                    });
                }
            } catch (error: unknown) {
                logWarn(`preset roster unavailable: ${String(error)}`);
            }
        }

        return result;
    };

    /** Built-in adapter commands, always first and never shadowed. */
    const BUILTIN_COMMANDS = [
        { name: "status", description: "Show adapter, model, mode, and token status" },
        {
            name: "model",
            description: "Select the model for this conversation",
            input: { hint: "[model] — blank lists available models" },
        },
    ];

    /**
     * The full command surface for one live agent: adapter built-ins, the
     * harness command registry (compact/goal/permission/plan/… — whatever
     * the composition mounts, scoped per agent), and user-invocable skills.
     * A skill needs no dispatch here: `/name` in a user message is the
     * harness's own invocation gesture, handled inside the agent.
     */
    const availableCommandsFor = async (
        record: SessionRecord,
    ): Promise<
        {
            name: string;
            description: string;
            input?: { hint: string };
            _meta?: Record<string, unknown>;
        }[]
    > => {
        const list: {
            name: string;
            description: string;
            input?: { hint: string };
            _meta?: Record<string, unknown>;
        }[] = [...BUILTIN_COMMANDS];
        if (tuiClient.advertised) {
            list.push({
                name: "plan-view",
                description: "Open the current ACP plan",
                _meta: {
                    commandAction: {
                        kind: "clientCommand",
                        presentation: "view",
                    },
                },
            });
        }
        const seen = new Set(list.map((command) => command.name));
        try {
            for (const descriptor of commandRuntime.list(record.agent)) {
                if (seen.has(descriptor.name)) continue;
                seen.add(descriptor.name);
                list.push({
                    name: descriptor.name,
                    description: descriptor.description,
                    ...(descriptor.input !== undefined ? { input: { hint: descriptor.input.hint } } : {}),
                    ...(descriptor.name === "plan"
                        ? {
                              _meta: {
                                  commandAction: {
                                      kind: "setConfigOption",
                                      configId: "collaboration_mode",
                                      value: "plan",
                                      resetValue: "default",
                                      presentation: "state",
                                  },
                              },
                          }
                        : {}),
                });
            }
        } catch (error: unknown) {
            logWarn(`command listing failed: ${String(error)}`);
        }
        try {
            const skills = await skillRegistry.list({
                ...(record.agent.session.header.cwd !== undefined
                    ? { cwd: record.agent.session.header.cwd }
                    : {}),
                scope: record.agent,
            });
            for (const skill of skills) {
                if (skill.invocation.userInvocable !== true) continue;
                if (seen.has(skill.name)) continue;
                seen.add(skill.name);
                list.push({
                    name: skill.name,
                    description: skill.description,
                    input: { hint: "instructions for the skill" },
                });
            }
        } catch (error: unknown) {
            logDebug(`skill listing failed: ${String(error)}`);
        }
        return list;
    };

    const publishCommands = (sessionId: string, record?: SessionRecord): void => {
        const target = record ?? sessions.get(sessionId);
        if (target === undefined) return;
        void availableCommandsFor(target)
            .then((availableCommands) => {
                notify(sessionId, { sessionUpdate: "available_commands_update", availableCommands });
            })
            .catch((error: unknown) => {
                logWarn(`publishing commands failed: ${String(error)}`);
            });
    };

    /** Push the current config-option surface (Zed re-renders its selectors). */
    const publishConfigOptions = (sessionId: string, record: SessionRecord): void => {
        void configOptions(record)
            .then((options) => {
                notify(sessionId, {
                    sessionUpdate: "config_option_update",
                    configOptions: options,
                } as unknown as SessionUpdate);
            })
            .catch((error: unknown) => {
                logWarn(`publishing config options failed: ${String(error)}`);
            });
    };

    /**
     * Re-read session-logged permission facts into the record. Harness
     * commands (e.g. /permission) change durable state behind the adapter's
     * back; the advertised mode must follow the log, not our last write.
     */
    const syncPermissionState = (record: SessionRecord, sessionId: string): void => {
        const events = (record.agent.session as unknown as { events?: readonly unknown[] }).events;
        if (events === undefined) return;
        const permission = permissionService();
        const storedMode = permission.current(events as unknown[]);
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index] as { type?: string; data?: { policy?: string } };
            if (event?.type === "approval/policy") {
                const policy = event.data?.policy;
                if (policy === "ask" || policy === "never") record.approvals = policy;
                break;
            }
        }
        if (storedMode !== undefined && storedMode !== record.modeId) {
            record.modeId = storedMode as SandboxMode;
            notify(sessionId, {
                sessionUpdate: "current_mode_update",
                currentModeId: record.modeId,
            } as unknown as SessionUpdate);
        }
    };

    // ------------------------------------------------------------------ //
    // Host credential seam (`ctx.credentials` / dsh-credentials-local)     //
    // ------------------------------------------------------------------ //

    const describeCredential = async (provider?: string): Promise<string> => {
        const names = credentialEnvNames(provider).filter((candidate) => !candidate.endsWith("_BASE_URL"));
        for (const name of names) {
            try {
                const info = await credentials.describe(credentialRef(name));
                if (info.configured) return info.source ?? "credential store";
            } catch (error: unknown) {
                logWarn(`credential describe failed: ${String(error)}`);
            }
        }
        return "not configured";
    };

    const saveCredential = async (provider: string | undefined, key: string): Promise<void> => {
        await credentials.set(credentialRef(primaryCredentialName(provider)), key);
    };

    const saveGateway = async (
        provider: string | undefined,
        key: string,
        baseUrl: string,
    ): Promise<void> => {
        await saveCredential(provider, key);
        await credentials.set(credentialRef(credentialBaseUrlName(provider)), baseUrl);
    };

    const logoutStored = async (): Promise<void> => {
        const routes = await listProviderRoutes();
        const providers = routes.length > 0 ? routes.map((route) => route.id) : [config.provider];
        for (const provider of providers) {
            try {
                await credentials.unset(credentialRef(primaryCredentialName(provider)));
            } catch (error: unknown) {
                logWarn(`credential unset failed: ${String(error)}`);
            }
        }
    };

    /**
     * The /model command: no argument lists the live catalog with the current
     * route marked; an argument switches by exact id (`provider::model` or
     * model id) or unique case-insensitive substring of the id or label.
     */
    const modelCommandText = async (
        record: SessionRecord,
        acpSessionId: string,
        query: string,
    ): Promise<string> => {
        const discovered = await discoverModels();
        const catalog: { value: string; label: string }[] = [
            ...discovered.map((entry) => ({
                value: encodeChoice(entry.provider, entry.model),
                label: entry.label,
            })),
            ...modelCandidates()
                .filter((model) => !discovered.some((entry) => entry.model === model))
                .map((model) => ({ value: encodeChoice(undefined, model), label: model })),
        ];
        const route = routeOf(record);
        const currentValue = encodeChoice(record.provider, record.model ?? route.model ?? "");
        if (query === "") {
            const lines = catalog.map(
                (entry) => `${entry.value === currentValue ? "→" : " "} ${entry.label} — ${entry.value}`,
            );
            return [
                `model: ${route.model ?? "(product default)"}${record.effort !== undefined ? ` (effort ${record.effort})` : ""}`,
                "",
                ...(lines.length > 0 ? lines : ["no models discovered — check credentials with /status"]),
                "",
                "switch with /model <name>",
            ].join("\n");
        }
        const lowered = query.toLowerCase();
        const exact = catalog.filter(
            (entry) =>
                entry.value.toLowerCase() === lowered ||
                decodeChoice(entry.value).model.toLowerCase() === lowered,
        );
        const matches =
            exact.length > 0
                ? exact
                : catalog.filter(
                      (entry) =>
                          entry.value.toLowerCase().includes(lowered) ||
                          entry.label.toLowerCase().includes(lowered),
                  );
        if (matches.length === 0) return `no model matches "${query}" — see /model`;
        if (matches.length > 1) {
            return [`"${query}" is ambiguous:`, ...matches.map((entry) => `  ${entry.label} — ${entry.value}`)].join(
                "\n",
            );
        }
        const target = matches[0] as { value: string; label: string };
        if (target.value === currentValue) return `already on ${target.label}`;
        await switchModel(record, acpSessionId, target.value);
        publishCommands(acpSessionId, record);
        publishConfigOptions(acpSessionId, record);
        return `model → ${target.label}`;
    };

    const statusText = async (record: SessionRecord): Promise<string> => {
        const used = record.projection.contextWindow;
        const route = routeOf(record);
        const effort = record.effort ?? loggedConfig(record)?.reasoningEffort;
        const lines = [
            `**dsh-acp** ${VERSION} — DeepSeek Harness ACP bridge`,
            "",
            `| | |`,
            `|---|---|`,
            `| Provider | ${route.provider ?? "(composition default)"} |`,
            `| Model | ${route.model ?? "(composition default)"} |`,
            `| Reasoning | ${effort ?? "(adapter default)"} |`,
            `| Credential | ${await describeCredential(route.provider)} |`,
            ...(record.preset !== undefined ? [`| Preset | ${record.preset} |`] : []),
            `| Permission mode | ${record.modeId} |`,
            `| Approvals | ${record.approvals} |`,
            `| Workspace | ${record.agent.session.header.cwd ?? process.cwd()} |`,
            `| Session | ${String(record.agent.session.id)} |`,
            ...(used !== undefined ? [`| Context window | ${used.toLocaleString()} tokens |`] : []),
        ];
        return lines.join("\n");
    };

    const registerRecord = (
        sessionId: string,
        agent: Agent,
        dispose: () => Promise<void>,
        model: string | undefined,
        modeId: SandboxMode,
        projection?: SessionProjection,
    ): SessionRecord => {
        const record: SessionRecord = {
            agent,
            dispose,
            projection:
                projection ??
                new SessionProjection(undefined, {
                    terminalOutput: clientTerminalOutput,
                    ...(agent.session.header.cwd !== undefined ? { cwd: agent.session.header.cwd } : {}),
                }),
            modeId,
            model,
            approvals: modeId === "danger-full-access" ? "never" : "ask",
            cancelled: false,
            inflight: undefined,
        };
        sessions.set(sessionId, record);
        watchSubagentParent(agent);
        return record;
    };

    // ------------------------------------------------------------------ //
    // Live event routing                                                  //
    // ------------------------------------------------------------------ //

    ctx.on("session/event", (session, event: SessionEvent) => {
        const sessionId = String(session.header.id);
        const record = sessions.get(sessionId);
        if (record === undefined || record.agent.session !== session) {
            const child = subagentByChild.get(sessionId);
            if (child !== undefined && clientSubagentTranscript) {
                for (const update of child.projection.onEvent(event as unknown as HarnessEvent)) {
                    notify(child.rootSessionId, update);
                }
            }
            return;
        }
        try {
            const harnessEvent = event as unknown as HarnessEvent;
            for (const update of record.projection.onEvent(harnessEvent)) {
                notify(sessionId, update);
            }
            if (harnessEvent.type === "plan/mode") publishConfigOptions(sessionId, record);
        } finally {
            const inflight = record.inflight;
            if (inflight !== undefined && event.type === "turn/end" && inflight.turn === event.data.turn) {
                // Model failures surface immediately as prompt errors; other
                // endings settle at whole-agent idle.
                if (event.data.reason.kind === "error") {
                    record.inflight = undefined;
                    inflight.reject(internalError(`turn failed: ${event.data.reason.error.message}`));
                }
            }
        }
    });

    ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
        const record = ownedRecord(agent);
        const inflight = record?.inflight;
        if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn;
    });

    ctx.on("agent/error", ({ agent, turn, error }) => {
        const record = ownedRecord(agent);
        const inflight = record?.inflight;
        if (record === undefined || inflight === undefined || inflight.turn === turn) return;
        record.inflight = undefined;
        inflight.reject(internalError(`turn failed: ${errorChain(error)}`));
    });

    // Permission requests: one-shot decisions, with an "always for this
    // session" convenience that flips the harness approval policy to 'never'.
    ctx.on("approval/request", (request, next) => {
        const record = ownedRecord(request.agent);
        if (record === undefined || request.callId === undefined) return next();
        return conn
            .requestPermission({
                sessionId: String(record.agent.session.id),
                toolCall: { toolCallId: request.callId },
                options: [
                    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                    { optionId: "allow-always", name: "Always allow (this session)", kind: "allow_always" },
                    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
                ],
            })
            .then(({ outcome }) => {
                if (outcome.outcome === "cancelled") return "cancelled" as const;
                if (outcome.optionId === "allow-always") {
                    setApprovalPolicy(record, "never");
                    return "allowed-once" as const;
                }
                return outcome.optionId === "allow-once" ? ("allowed-once" as const) : ("rejected" as const);
            });
    });

    // ------------------------------------------------------------------ //
    // The ACP agent                                                       //
    // ------------------------------------------------------------------ //

    const makeAgent = (connection: AgentSideConnection): AcpAgent => {
        conn = connection;
        return {
            async initialize(params: InitializeRequest): Promise<InitializeResponse> {
                const requested = params.protocolVersion;
                // Zed's display-terminal extension: command tool calls embed a
                // presentation terminal when the client advertises it in the
                // capability _meta (the codex-acp contract).
                const capsMeta = (params.clientCapabilities as { _meta?: Record<string, unknown> } | undefined)?.[
                    "_meta"
                ];
                clientTerminalOutput =
                    capsMeta !== null && typeof capsMeta === "object"
                        ? capsMeta["terminal_output"] === true
                        : false;
                clientSubagentTranscript =
                    capsMeta !== null && typeof capsMeta === "object"
                        ? capsMeta["subagent-transcript"] === true
                        : false;
                clientElicitationForm =
                    params.clientCapabilities?.elicitation?.form !== undefined &&
                    params.clientCapabilities.elicitation.form !== null;
                tuiClient.advertised = advertisesCordis(capsMeta);
                const providers = await listProviderRoutes();
                return {
                    protocolVersion:
                        typeof requested === "number" && requested >= 1 && requested < PROTOCOL_VERSION
                            ? requested
                            : PROTOCOL_VERSION,
                    agentInfo: { name: "dsh-acp", title: "DeepSeek Harness", version: VERSION },
                    agentCapabilities: {
                        _meta: { dsh: { cordis: { ...CORDIS_CAPABILITY } } },
                        loadSession: true,
                        promptCapabilities: {
                            image: attachmentIngestOf(ctx.get("attachments")) !== undefined,
                            audio: false,
                            embeddedContext: true,
                        },
                        // Stdio servers always work; streamable HTTP maps onto
                        // mcp-client's second transport. Legacy SSE does not.
                        mcpCapabilities: { http: true, sse: false },
                        auth: { logout: {} },
                        sessionCapabilities: { list: {} },
                    },
                    authMethods: advertisedAuthMethods(
                        providers,
                        params.clientCapabilities as ClientAuthCapabilities | undefined,
                    ) as AuthMethod[],
                };
            },

            async authenticate(params: AuthenticateRequest): Promise<void> {
                const gateway = gatewayFromAuthenticate(params);
                if (isGatewayAuthMethod(params.methodId) || gateway.baseUrl) {
                    if (!gateway.baseUrl || !gateway.key) {
                        throw authRequired(
                            "authenticate gateway requires `_meta.gateway.baseUrl` and an Authorization header",
                        );
                    }
                    await saveGateway(
                        gateway.providerName ?? config.provider,
                        gateway.key,
                        gateway.baseUrl,
                    );
                    return;
                }
                const submitted = apiKeyFromAuthenticate(params);
                const provider =
                    submitted.provider ?? providerFromAuthMethodId(params.methodId) ?? config.provider;
                if (submitted.key) {
                    await saveCredential(provider, submitted.key);
                    return;
                }
                if (await credentialPresent(provider)) return;
                if (isBrowserAuthMethod(params.methodId) && shouldOfferLocalAuthPage()) {
                    const page = await startLocalAuthPage({
                        credentialName: primaryCredentialName(provider),
                    });
                    openLocalAuthPage(page.url);
                    try {
                        const key = await page.completed;
                        await saveCredential(provider, key);
                        return;
                    } finally {
                        page.close();
                    }
                }
                await requireCredential(provider);
            },

            async logout(_params: LogoutRequest): Promise<void> {
                await logoutStored();
            },

            async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
                assertOpen();
                const started = performance.now();
                let checkpoint = started;
                const mark = (name: string): void => {
                    const now = performance.now();
                    logDebug(`session/new ${name}: ${(now - checkpoint).toFixed(1)}ms (+${(now - started).toFixed(1)}ms)`);
                    checkpoint = now;
                };
                await requireCredential(config.provider);
                mark("credential");
                validateCwd(params.cwd);
                syncMcpServers(params.mcpServers, params.cwd);
                mark("request setup");
                const sessionId = SessionId(randomUUID());
                const presets = presetsService();
                const presetId = (await presets.resolve(undefined)).id;
                mark("preset resolve");
                const handle = await agents.create({
                    sessionId,
                    meta: { cwd: params.cwd, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
                    agentOptions: agentOptionsFor(config.model),
                    ...(presetSetup(presets, presetId) !== undefined
                        ? { setup: presetSetup(presets, presetId) }
                        : {}),
                } as Parameters<typeof agents.create>[0]);
                mark("agent create");
                if (closed) {
                    await handle.dispose();
                    throw internalError("connection closed during session/new");
                }
                const record = registerRecord(
                    String(sessionId),
                    handle.agent,
                    () => handle.dispose(),
                    config.model,
                    config.permissionMode ?? "workspace-write",
                );
                if (presetId !== undefined) record.preset = presetId;
                ensureSelection(record);
                queueMicrotask(() => publishCommands(String(sessionId)));
                const options = await configOptions(record);
                mark("response surface");
                return {
                    sessionId: String(sessionId),
                    modes: modeState(record),
                    ...(options.length > 0 ? { configOptions: options } : {}),
                };
            },

            async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
                assertOpen();
                await requireCredential(config.provider);
                validateCwd(params.cwd);
                syncMcpServers(params.mcpServers, params.cwd);
                requirePersistence();
                const record = await restoreSession(params.sessionId, { replay: true, cwd: params.cwd });
                const options = await configOptions(record);
                return {
                    modes: modeState(record),
                    ...(options.length > 0 ? { configOptions: options } : {}),
                };
            },

            async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
                assertOpen();
                const persistence = requirePersistence();
                const headers = await persistence.list();
                headers.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
                const filtered = params.cwd !== undefined && params.cwd !== null
                    ? headers.filter((header) => header.cwd === params.cwd)
                    : headers;
                const page = filtered.slice(0, 100);
                const withTitles = await Promise.allSettled(
                    page.slice(0, 20).map(async (header) => {
                        const { events } = await persistence.inspect(header.id);
                        return foldSessionTitle(events)?.title;
                    }),
                );
                const sessionsInfo: SessionInfo[] = page.map((header, index) => {
                    const settled = withTitles[index];
                    const title = settled !== undefined && settled.status === "fulfilled" ? settled.value : undefined;
                    return {
                        sessionId: String(header.id),
                        cwd: header.cwd ?? "",
                        ...(title !== undefined ? { title } : {}),
                        ...(header.createdAt !== undefined
                            ? { updatedAt: new Date(header.createdAt).toISOString() }
                            : {}),
                    };
                });
                return { sessions: sessionsInfo };
            },

            async prompt(params: PromptRequest): Promise<PromptResponse> {
                assertOpen();
                const record = await requireOrRestoreSession(params.sessionId);
                let converted;
                try {
                    converted = await convertPrompt(
                        params.prompt,
                        attachmentIngestOf(ctx.get("attachments")),
                    );
                } catch (error: unknown) {
                    if (
                        error instanceof UnsupportedPromptContentError ||
                        error instanceof PromptImageError
                    ) {
                        throw invalidParams(error.message);
                    }
                    throw error;
                }
                if (converted.blocks.length === 0) throw invalidParams("empty prompt");

                // ACP clients steer by issuing another session/prompt while
                // the active one is still in flight. Queueing is client-side;
                // the bridge must deliver an immediate second prompt to the
                // harness's next-step inbox without disturbing the active
                // request or its projection window.
                if (record.inflight !== undefined) {
                    await requireCredential(record.provider ?? config.provider);
                    if (agents.get(record.agent.id) !== record.agent) {
                        throw internalError("prompt was not steered: the agent was disposed outside the bridge");
                    }
                    const message = createUserMessage({
                        content: converted.blocks,
                        source: { kind: "user" },
                    });
                    try {
                        deliverPrompt(record.agent, message, true);
                    } catch (error: unknown) {
                        const detail = error instanceof Error ? error.message : String(error);
                        throw internalError(`prompt was not steered: ${detail}`);
                    }
                    return { stopReason: "end_turn" };
                }

                // Adapter-level slash commands never reach the model.
                const trimmed = converted.displayText.trim();
                const commandMatch = trimmed.match(/^\/(\w[\w-]*)\b/);
                const respond = (text: string): PromptResponse => {
                    notify(params.sessionId, {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text },
                    });
                    return { stopReason: "end_turn" };
                };
                if (commandMatch?.[1] === "status") return respond(await statusText(record));
                if (commandMatch?.[1] === "model") {
                    return respond(
                        await modelCommandText(
                            record,
                            params.sessionId,
                            trimmed.slice(commandMatch[0].length).trim(),
                        ),
                    );
                }
                if (commandMatch !== null && commandMatch[1] !== undefined) {
                    // The harness command registry (compact/goal/permission/…)
                    // executes without a model turn. An unresolved slash falls
                    // through: /skill-name is the harness's own skill gesture
                    // and is claimed inside the agent's next step.
                    let execution;
                    try {
                        execution = await commandRuntime.execute(
                            record.agent,
                            trimmed,
                            new AbortController().signal,
                        );
                    } catch (error: unknown) {
                        return respond(`⚠ /${commandMatch[1]} failed: ${errorChain(error)}`);
                    }
                    if (execution !== undefined) {
                        const { result } = execution;
                        const text =
                            result.text ??
                            (result.kind === "success" ? `/${commandMatch[1]} ✓` : `/${commandMatch[1]} failed`);
                        // Commands can change agent-visible state (permission
                        // preset, plan mode); follow the session log and
                        // refresh every advertised surface.
                        syncPermissionState(record, params.sessionId);
                        publishCommands(params.sessionId, record);
                        publishConfigOptions(params.sessionId, record);
                        return respond(result.kind === "error" ? `⚠ ${text}` : text);
                    }
                }

                // Gate model turns (not slash commands) on a usable credential
                // for the session's current provider route.
                await requireCredential(record.provider ?? config.provider);

                // Never drive a retired agent: an agent-loop reload disposes
                // agents while bridge records survive.
                if (agents.get(record.agent.id) !== record.agent) {
                    throw internalError("prompt was not queued: the agent was disposed outside the bridge");
                }

                record.cancelled = false;
                const message = createUserMessage({
                    content: converted.blocks,
                    source: { kind: "user" },
                });

                // Prompt conversion and credential lookup can yield. A second
                // request may have won the turn slot while this one awaited;
                // re-check immediately before admission so it becomes steer
                // instead of overwriting the active inflight record.
                if (record.inflight !== undefined) {
                    try {
                        deliverPrompt(record.agent, message, true);
                    } catch (error: unknown) {
                        const detail = error instanceof Error ? error.message : String(error);
                        throw internalError(`prompt was not steered: ${detail}`);
                    }
                    return { stopReason: "end_turn" };
                }

                record.projection.beginPrompt();

                const stopReason = await new Promise<StopReason>((resolve, reject) => {
                    const inflight: Inflight = { resolve, reject, messageId: message.id, turn: undefined };
                    record.inflight = inflight;
                    try {
                        deliverPrompt(record.agent, message, false);
                    } catch (error: unknown) {
                        record.inflight = undefined;
                        const detail = error instanceof Error ? error.message : String(error);
                        throw internalError(`prompt was not queued: ${detail}`);
                    }
                    // Settle at whole-agent idle: a correlated turn/end decides
                    // the stop reason; a turnless slot means admission discarded
                    // the prompt (reported as cancelled).
                    void record.agent.whenIdle().then(() => {
                        if (record.inflight !== inflight) return;
                        record.inflight = undefined;
                        if (record.cancelled) {
                            resolve("cancelled");
                            return;
                        }
                        const end =
                            inflight.turn !== undefined
                                ? record.projection.turnEndFor(inflight.turn) ?? record.projection.lastTurnEnd
                                : record.projection.lastTurnEnd;
                        resolve(end === undefined ? "cancelled" : turnEndToStopReason(end));
                    });
                });

                const usage = record.projection.promptUsage();
                return { stopReason, ...(usage !== undefined ? { usage } : {}) };
            },

            async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
                const record = await requireOrRestoreSession(params.sessionId);
                applyMode(record, params.sessionId, params.modeId);
                notify(params.sessionId, {
                    sessionUpdate: "config_option_update",
                    configOptions: await configOptions(record),
                });
                return {};
            },

            async setSessionConfigOption(
                params: SetSessionConfigOptionRequest,
            ): Promise<SetSessionConfigOptionResponse> {
                const record = await requireOrRestoreSession(params.sessionId);
                const value = typeof params.value === "string" ? params.value : undefined;
                if (value === undefined) throw invalidParams(`invalid value: ${String(params.value)}`);

                switch (params.configId) {
                    case "mode": {
                        applyMode(record, params.sessionId, value);
                        break;
                    }
                    case "agent":
                    case "preset": {
                        await switchPreset(record, params.sessionId, value);
                        break;
                    }
                    case "effort": {
                        const route = routeOf(record);
                        const catalog = await effortCatalog(route.provider, route.model);
                        if (catalog === undefined || !catalog.efforts.some((effort) => effort.id === value)) {
                            throw invalidParams(`unknown effort: ${value}`);
                        }
                        const selection = ensureSelection(record);
                        if (selection === undefined || route.provider === undefined || route.model === undefined) {
                            throw invalidParams("reasoning effort switching is unavailable on this host");
                        }
                        // Snapshotted at the next step's prompt assembly; a
                        // running turn keeps its captured selection.
                        selection.current = {
                            provider: route.provider,
                            model: route.model,
                            reasoningEffort: value,
                        };
                        record.effort = value;
                        break;
                    }
                    case "collaboration_mode": {
                        if (value !== "default" && value !== "plan") {
                            throw invalidParams(`unknown collaboration mode: ${value}`);
                        }
                        const execution = await commandRuntime.execute(
                            record.agent,
                            value === "plan" ? "/plan" : "/plan off",
                            new AbortController().signal,
                        );
                        if (execution === undefined) {
                            throw invalidParams("plan mode is unavailable on this session");
                        }
                        if (execution.result.kind === "error") {
                            throw invalidParams(execution.result.text);
                        }
                        break;
                    }
                    case "model": {
                        await switchModel(record, params.sessionId, value);
                        break;
                    }
                    default:
                        throw invalidParams(`unknown config option: ${params.configId}`);
                }
                return { configOptions: await configOptions(record) };
            },

            async closeSession(params: CloseSessionRequest): Promise<void> {
                const record = sessions.get(params.sessionId);
                if (record === undefined) return;
                sessions.delete(params.sessionId);
                record.agent.cancel({ kind: "user" });
                settlePrompt(record, "cancelled");
                await record.dispose().catch((error: unknown) => {
                    logWarn(`session close failed: ${String(error)}`);
                });
            },

            cancel(params: CancelNotification): Promise<void> {
                const record = sessions.get(params.sessionId);
                if (record === undefined) return Promise.resolve();
                record.cancelled = true;
                record.agent.cancel({ kind: "user" });
                settlePrompt(record, "cancelled");
                return Promise.resolve();
            },
        };
    };

    function requirePersistence(): Context["sessionPersistence"] {
        return sessionPersistence;
    }

    function validateCwd(cwd: string): void {
        if (!isAbsolute(cwd)) throw invalidParams(`cwd must be an absolute path: ${cwd}`);
    }

    // ------------------------------------------------------------------ //
    // MCP servers (session mcpServers → dsh-mcp-client instances)         //
    // ------------------------------------------------------------------ //

    /**
     * Live mcp-client mounts by server name. ACP has no session/close, so a
     * mount lives until the process exits or a later session re-declares the
     * same name with a different config (the client edited its settings —
     * replace, so new sessions and the next turns of old ones see the new
     * server). Same name + same config is reused across sessions: clients
     * send one configured list to every session, and tool names
     * (`mcp__<name>__…`) stay stable for prompt caching.
     */
    const mcpMounts = new Map<string, { configJson: string; fiber: { dispose(): unknown } }>();
    let warnedNoMcpClient = false;

    /** mcp-client requires `[A-Za-z0-9_-]{1,32}`; ACP names are free-form. */
    const sanitizeServerName = (raw: string): string => {
        const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
        return cleaned.length > 0 ? cleaned : "server";
    };

    /** Projects one ACP McpServer onto an mcp-client config, if supported. */
    const mcpConfigFor = (
        server: Record<string, unknown>,
        cwd: string,
        serverName: string,
    ): Record<string, unknown> | undefined => {
        const envList = (list: unknown): Record<string, string> =>
            Object.fromEntries(
                (Array.isArray(list) ? (list as { name: string; value: string }[]) : []).map((e) => [
                    e.name,
                    e.value,
                ]),
            );
        if (typeof server["command"] === "string") {
            return {
                transport: "stdio",
                serverName,
                command: server["command"],
                args: Array.isArray(server["args"]) ? server["args"] : [],
                env: envList(server["env"]),
                cwd: typeof server["cwd"] === "string" ? server["cwd"] : cwd,
                // A dead or misconfigured server must not take the session
                // down; the client surfaces missing tools on its own.
                failOnStartupError: false,
            };
        }
        if (server["type"] === "http" && typeof server["url"] === "string") {
            return {
                transport: "streamable-http",
                serverName,
                url: server["url"],
                headers: envList(server["headers"]),
                failOnStartupError: false,
            };
        }
        return undefined;
    };

    /** Mounts/reuses/replaces mcp-client instances for a session's server list. */
    const syncMcpServers = (servers: NewSessionRequest["mcpServers"] | undefined, cwd: string): void => {
        if (servers === undefined || servers.length === 0) return;
        const mcpClient = harness.mcpClient;
        if (mcpClient === undefined) {
            if (!warnedNoMcpClient) {
                warnedNoMcpClient = true;
                logWarn(
                    `ignoring ${servers.length} MCP server(s): this DeepSeek Harness installation lacks @deepseek-ai/dsh-mcp-client`,
                );
            }
            return;
        }
        const taken = new Set<string>();
        for (const entry of servers) {
            const server = entry as unknown as Record<string, unknown>;
            const base = sanitizeServerName(typeof server["name"] === "string" ? server["name"] : "server");
            let serverName = base;
            for (let n = 2; taken.has(serverName); n += 1) serverName = `${base.slice(0, 28)}_${n}`;
            const cfg = mcpConfigFor(server, cwd, serverName);
            if (cfg === undefined) {
                logWarn(`skipping MCP server "${serverName}": unsupported transport`);
                continue;
            }
            const configJson = JSON.stringify(cfg);
            const existing = mcpMounts.get(serverName);
            if (existing !== undefined) {
                if (existing.configJson === configJson) {
                    taken.add(serverName);
                    continue;
                }
                try {
                    void existing.fiber.dispose();
                } catch (error: unknown) {
                    logWarn(`disposing MCP server "${serverName}": ${String(error)}`);
                }
                mcpMounts.delete(serverName);
            }
            try {
                const fiber = (
                    ctx as unknown as { plugin(module: unknown, config: unknown): { dispose(): unknown } }
                ).plugin(mcpClient, cfg);
                mcpMounts.set(serverName, { configJson, fiber });
                taken.add(serverName);
                logDebug(`mounted MCP server "${serverName}" (${String(cfg["transport"])})`);
            } catch (error: unknown) {
                logWarn(`failed to mount MCP server "${serverName}": ${String(error)}`);
            }
        }
    };

    // ------------------------------------------------------------------ //
    // Transport wiring and teardown                                       //
    // ------------------------------------------------------------------ //

    const raw: Stream =
        config.stream ??
        ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
        );
    const stream = muxAcpStream(raw, rpc);
    conn = new AgentSideConnection(makeAgent, stream);
    await ctx.plugin(userQuestionsPlugin, {
        formSupported: () => clientElicitationForm,
        sessionIdForRequest: (request) => {
            if (request.agent === undefined) return undefined;
            const record = ownedRecord(request.agent);
            return record === undefined ? undefined : String(record.agent.session.id);
        },
        create: (request) => conn.unstable_createElicitation(request),
    });

    let quiescing: Promise<void> | undefined;
    const quiesce = (): Promise<void> => {
        if (quiescing !== undefined) return quiescing;
        closed = true;
        const records = [...sessions.values()];
        sessions.clear();
        subagentByChild.clear();
        subagentByRun.clear();
        for (const record of records) {
            record.agent.cancel({ kind: "user" });
            settlePrompt(record, "cancelled");
        }
        quiescing = (async () => {
            // Continuable subagents (when composed) own descendant teardown;
            // drain them child-first before disposing the top-level agents.
            try {
                await subagents.drainContinuableDescendants(records.map((record) => record.agent));
            } catch (error: unknown) {
                logWarn(`continuable subagent teardown failed: ${String(error)}`);
            }
            const disposals = await Promise.allSettled(records.map((record) => record.dispose()));
            const failures = disposals.filter(
                (result): result is PromiseRejectedResult => result.status === "rejected",
            );
            if (failures.length > 0) {
                const detail = failures.map((failure) => errorChain(failure.reason)).join("; ");
                throw new AggregateError(
                    failures.map((failure) => failure.reason as unknown),
                    `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
                );
            }
        })();
        return quiescing;
    };

    void conn.closed
        .catch((error: unknown) => {
            logWarn(`connection closed with an error: ${String(error)}`);
        })
        .then(quiesce)
        .catch((error: unknown) => {
            logWarn(`connection-close teardown failed: ${String(error)}`);
        });

    ctx.effect(() => quiesce, "acp-bridge.connection");
}
