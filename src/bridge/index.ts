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
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import type { SessionId, SessionEvent } from "@deepseek-ai/dsh-session";
import type { foldSessionTitle } from "@deepseek-ai/dsh-session-title";
import type { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
// Side-effect type imports: declaration-merge the approval waterfall and agent events.
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-session-persistence";

import { VERSION } from "../version.ts";
import { logDebug, logWarn } from "../log.ts";
import { buildReplay } from "./history.ts";
import { convertPrompt, UnsupportedPromptContentError } from "./prompt.ts";
import { SessionProjection, turnEndToStopReason, type HarnessEvent, type SessionUpdate } from "./translate.ts";

export const name = "acp-bridge";
/** The bridge creates and owns agents; every other capability is optional. */
export const inject = ["agents"];

/** Host functions the bridge needs beyond the plugin tree (see loadKit). */
export interface BridgeHarness {
    createUserMessage: typeof createUserMessage;
    errorChain: typeof errorChain;
    sessionId: typeof SessionId;
    foldSessionTitle: typeof foldSessionTitle;
    setSandboxMode: typeof setSandboxMode;
    sandboxModes: readonly SandboxMode[];
    /** Brands a credential reference for `ctx.credentials` lookups (optional seam). */
    credentialRef?: (value: string) => unknown;
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

function envCredentialPresent(): boolean {
    // A custom base URL counts: OpenAI-compatible proxies may not need a key.
    return Boolean(process.env["DEEPSEEK_API_KEY"] || process.env["DEEPSEEK_BASE_URL"]);
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
 * @param ctx - cordis context carrying `agents` plus optional
 *   `sessionPersistence`, `approval`, and `subagents` services.
 * @param config - provider/model selection and optional test transport.
 */
export async function apply(ctx: Context, config: AcpBridgeConfig = {}): Promise<void> {
    // Capture injected services during apply; handlers run outside the scope.
    const agents = ctx.agents;
    const harness = config.harness ?? (await import("./self-harness.ts")).selfHarness();
    const { createUserMessage, errorChain, sessionId: SessionId, foldSessionTitle, setSandboxMode } = harness;
    const SANDBOX_MODES = harness.sandboxModes;
    const sessions = new Map<string, SessionRecord>();
    let closed = false;
    let conn: AgentSideConnection;

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
        const service = ctx.get("agentDefaultModel") as
            | { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
            | undefined;
        if (service === undefined) return {};
        try {
            return service.currentSelection();
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
        const llm = ctx.get("llm") as
            | {
                  listProviders(): { id: string; name: string }[];
                  listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]>;
              }
            | undefined;
        const found: ModelChoice[] = [];
        if (llm !== undefined) {
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
        const llm = ctx.get("llm") as
            | {
                  resolveModelInfo?(
                      provider: string,
                      model: string,
                  ): Promise<{
                      reasoning?: {
                          efforts: readonly { id: unknown; name: string; description?: string }[];
                          defaultEffort?: unknown;
                      };
                  }>;
              }
            | undefined;
        let catalog: EffortCatalog | undefined;
        try {
            const reasoning = (await llm?.resolveModelInfo?.(provider, model))?.reasoning;
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
     * Whether a model call has any chance of authenticating: the credential
     * seam first (the key saved through the dsh Web UI, hot-reloaded from
     * ~/.dsh/.credentials.yaml), then the process environment. Composition
     * boots activate plugins concurrently, so wait briefly for the seam to
     * register instead of failing a session that raced the loader.
     */
    const credentialPresent = async (): Promise<boolean> => {
        if (envCredentialPresent()) return true;
        const brand = harness.credentialRef;
        if (brand === undefined) return false;
        const deadline = Date.now() + 5000;
        for (;;) {
            const seam = ctx.get("credentials") as
                | { resolve(ref: unknown): Promise<{ value: string } | undefined> }
                | undefined;
            if (seam !== undefined) {
                try {
                    return (await seam.resolve(brand("DEEPSEEK_API_KEY"))) !== undefined;
                } catch (error: unknown) {
                    logWarn(`credential lookup failed: ${String(error)}`);
                    return false;
                }
            }
            if (Date.now() >= deadline) {
                logDebug("credential gate: no credentials service registered within 5s");
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
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
        list(): Promise<{ id: string }[]>;
        resolve(id?: string): Promise<{ id: string }>;
        mount(agentCtx: unknown, id: string): Promise<void>;
    }

    const presetsService = (): AgentPresetsService | undefined =>
        ctx.get("agentPresets") as AgentPresetsService | undefined;

    /** Agent-create/resume `setup` joining one preset; undefined without a roster. */
    const presetSetup = (
        presets: AgentPresetsService | undefined,
        presetId: string | undefined,
    ): ((agentCtx: unknown) => Promise<void>) | undefined => {
        if (presets === undefined || presetId === undefined) return undefined;
        return async (agentCtx: unknown) => {
            logDebug(`preset setup: mounting "${presetId}"`);
            await presets.mount(agentCtx, presetId);
            logDebug(`preset setup: mounted "${presetId}"`);
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

    const presetLabel = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

    const modeState = async (record: SessionRecord): Promise<SessionModeState> => {
        const presets = presetsService();
        if (presets !== undefined && record.preset !== undefined) {
            try {
                const roster = await presets.list();
                if (roster.length > 0) {
                    return {
                        currentModeId: record.preset,
                        availableModes: roster.map((preset) => ({
                            id: preset.id,
                            name: presetLabel(preset.id),
                            description: `Agent preset “${preset.id}”`,
                        })),
                    };
                }
            } catch (error: unknown) {
                logWarn(`preset roster unavailable: ${String(error)}`);
            }
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
     * Switch the agent preset: record the durable fact, then rebuild the
     * agent over the same session so the new composition (persona, tool set,
     * compaction) joins from the next turn — the resume-based swap the model
     * switch already uses. The Web UI locks the preset at creation; ACP
     * clients get a live switch because rebuilding is this bridge's norm.
     */
    const switchPreset = async (record: SessionRecord, acpSessionId: string, presetId: string): Promise<void> => {
        if (record.inflight !== undefined) {
            throw invalidParams("cannot switch presets while a prompt is running");
        }
        const presets = presetsService();
        if (presets === undefined) throw invalidParams(`unknown mode: ${presetId}`);
        let resolved: string;
        try {
            resolved = (await presets.resolve(presetId)).id;
        } catch (error: unknown) {
            throw invalidParams(`unknown preset: ${presetId} (${errorChain(error)})`);
        }
        if (resolved === record.preset) return;
        try {
            (
                record.agent.session as unknown as {
                    append(type: string, data: unknown): unknown;
                }
            ).append("agent-preset/selected", { agentPreset: resolved });
        } catch (error: unknown) {
            logWarn(`recording preset selection failed: ${String(error)}`);
        }
        const sessionId = record.agent.session.id;
        await record.dispose().catch((error: unknown) => {
            logWarn(`dispose during preset switch failed: ${String(error)}`);
        });
        let handle;
        try {
            handle = await agents.resume({
                resumeSessionId: sessionId,
                agentOptions: agentOptionsFor(record.model ?? config.model, record.provider),
                setup: presetSetup(presets, resolved),
            } as Parameters<typeof agents.resume>[0]);
        } catch (error: unknown) {
            sessions.delete(acpSessionId);
            throw internalError(`preset switch failed: ${errorChain(error)}`);
        }
        record.agent = handle.agent;
        record.dispose = () => handle.dispose();
        record.preset = resolved;
        delete record.selection;
        ensureSelection(record);
        // Approval policy is agent-scoped state; re-apply it to the new agent.
        setApprovalPolicy(record, record.approvals);
        notify(acpSessionId, { sessionUpdate: "current_mode_update", currentModeId: resolved });
    };

    /** Flip the per-agent approval policy, mirroring the result on the record. */
    const setApprovalPolicy = (record: SessionRecord, policy: ApprovalPolicy): void => {
        try {
            (ctx.get("approval") as { setPolicy?: (agent: Agent, policy: ApprovalPolicy) => void } | undefined)
                ?.setPolicy?.(record.agent, policy);
        } catch (error: unknown) {
            logWarn(`approval policy switch failed: ${String(error)}`);
        }
        record.approvals = policy;
    };

    /** Apply one sandbox mode: confinement, coupled approval default, mode update. */
    const applyMode = (record: SessionRecord, sessionId: string, modeId: string): void => {
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

        result.push({
            type: "select",
            id: "mode",
            name: "Mode",
            category: "mode",
            currentValue: record.modeId,
            options: SANDBOX_MODES.map((mode) => {
                const label = MODE_LABELS[mode] ?? { name: mode, description: "" };
                return {
                    value: mode,
                    name: label.name,
                    ...(label.description.length > 0 ? { description: label.description } : {}),
                };
            }),
        });

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

        result.push({
            type: "select",
            id: "approvals",
            name: "Approvals",
            currentValue: record.approvals,
            options: [
                { value: "ask", name: "Ask", description: "Ask before actions beyond the sandbox mode" },
                { value: "never", name: "Never ask", description: "Auto-approve every permission request" },
            ],
        });

        return result;
    };

    const publishCommands = (sessionId: string): void => {
        notify(sessionId, {
            sessionUpdate: "available_commands_update",
            availableCommands: [
                { name: "status", description: "Show adapter, model, mode, and token status" },
                {
                    name: "login",
                    description:
                        "Save a DeepSeek API key into the harness credential store (~/.dsh/.credentials.yaml)",
                    input: { hint: "<api-key>" },
                },
                { name: "logout", description: "Remove the API key stored in the harness credential store" },
            ],
        });
    };

    // ------------------------------------------------------------------ //
    // Credential store (the same writable seam the dsh Web UI uses)        //
    // ------------------------------------------------------------------ //

    interface CredentialStore {
        resolve(ref: unknown): Promise<{ value: string } | undefined>;
        describe(ref: unknown): Promise<{ configured: boolean; source?: string; writable: boolean }>;
        set(ref: unknown, value: string): Promise<void>;
        unset(ref: unknown): Promise<void>;
    }

    const credentialStore = (): { store: CredentialStore; ref: unknown } | undefined => {
        const brand = harness.credentialRef;
        const store = ctx.get("credentials") as CredentialStore | undefined;
        if (brand === undefined || store === undefined) return undefined;
        return { store, ref: brand("DEEPSEEK_API_KEY") };
    };

    const maskKey = (value: string): string =>
        value.length <= 8 ? "…" : `${value.slice(0, 4)}…${value.slice(-4)}`;

    const describeCredential = async (): Promise<string> => {
        if (envCredentialPresent()) {
            const viaEnv =
                process.env["DEEPSEEK_API_KEY"] !== undefined ? "DEEPSEEK_API_KEY" : "DEEPSEEK_BASE_URL";
            return `process environment (${viaEnv})`;
        }
        const cs = credentialStore();
        if (cs === undefined) return "not configured";
        try {
            const info = await cs.store.describe(cs.ref);
            if (!info.configured) return "not configured";
            return info.source ?? "credential store";
        } catch (error: unknown) {
            logWarn(`credential describe failed: ${String(error)}`);
            return "unknown";
        }
    };

    const loginText = async (rawArgument: string): Promise<string> => {
        const key = rawArgument.trim();
        const cs = credentialStore();
        if (cs === undefined) {
            return "This composition has no writable credential store; export DEEPSEEK_API_KEY in the environment that launches the agent instead.";
        }
        if (key.length === 0) {
            return [
                "Usage: `/login <api-key>` — stores the key in the harness credential store",
                "(`~/.dsh/.credentials.yaml`, the same file the dsh Web UI writes; mode 600).",
                "",
                `Current credential source: ${await describeCredential()}.`,
                "",
                "Note: text entered here also lands in your client's chat history. If you",
                "prefer to keep the key out of it, save the key in the dsh Web UI instead.",
            ].join("\n");
        }
        try {
            await cs.store.set(cs.ref, key);
        } catch (error: unknown) {
            return [
                `Could not store the key: ${error instanceof Error ? error.message : String(error)}`,
                "",
                "A read-only source (usually the process environment) is currently supplying",
                "this credential, so a stored value would be shadowed. Unset DEEPSEEK_API_KEY",
                "in the launching environment, or keep using it as the credential.",
            ].join("\n");
        }
        return `Saved DEEPSEEK_API_KEY (${maskKey(key)}) to the harness credential store — source now: ${await describeCredential()}. The dsh Web UI sees the same key.`;
    };

    const logoutText = async (): Promise<string> => {
        const cs = credentialStore();
        if (cs === undefined) return "This composition has no writable credential store; nothing to remove.";
        try {
            await cs.store.unset(cs.ref);
        } catch (error: unknown) {
            return `Could not remove the stored key: ${error instanceof Error ? error.message : String(error)}`;
        }
        const remaining = await describeCredential();
        return remaining === "not configured"
            ? "Removed the stored DEEPSEEK_API_KEY. No credential is configured now."
            : `Removed the stored DEEPSEEK_API_KEY; requests now authenticate via: ${remaining}.`;
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
            `| Credential | ${await describeCredential()} |`,
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
            projection: projection ?? new SessionProjection(),
            modeId,
            model,
            approvals: modeId === "danger-full-access" ? "never" : "ask",
            cancelled: false,
            inflight: undefined,
        };
        sessions.set(sessionId, record);
        return record;
    };

    // ------------------------------------------------------------------ //
    // Live event routing                                                  //
    // ------------------------------------------------------------------ //

    ctx.on("session/event", (session, event: SessionEvent) => {
        const sessionId = String(session.header.id);
        const record = sessions.get(sessionId);
        if (record === undefined || record.agent.session !== session) return;
        try {
            for (const update of record.projection.onEvent(event as unknown as HarnessEvent)) {
                notify(sessionId, update);
            }
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
                    try {
                        (ctx.get("approval") as { setPolicy?: (agent: Agent, policy: "ask" | "never") => void } | undefined)
                            ?.setPolicy?.(record.agent, "never");
                    } catch (error: unknown) {
                        logWarn(`approval policy switch failed: ${String(error)}`);
                    }
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
            initialize(params: InitializeRequest): Promise<InitializeResponse> {
                const hasPersistence = ctx.get("sessionPersistence") !== undefined;
                const requested = params.protocolVersion;
                // No ACP auth methods: credential management belongs to the
                // harness (dsh Web UI → ~/.dsh/.credentials.yaml, hot-reloaded)
                // or the launching environment. The adapter reuses whatever
                // the user already configured; clients never mediate auth.
                return Promise.resolve({
                    protocolVersion:
                        typeof requested === "number" && requested >= 1 && requested < PROTOCOL_VERSION
                            ? requested
                            : PROTOCOL_VERSION,
                    agentInfo: { name: "dsh-acp", title: "DeepSeek Harness", version: VERSION },
                    agentCapabilities: {
                        loadSession: hasPersistence,
                        promptCapabilities: { image: false, audio: false, embeddedContext: true },
                        // Stdio servers always work; streamable HTTP maps onto
                        // mcp-client's second transport. Legacy SSE does not.
                        mcpCapabilities: { http: true, sse: false },
                        ...(hasPersistence ? { sessionCapabilities: { list: {} } } : {}),
                    },
                    authMethods: [],
                });
            },

            async authenticate(_params: AuthenticateRequest): Promise<void> {
                // No advertised methods; accept the call defensively and
                // re-check the ambient credential so a client retry after the
                // user configures dsh succeeds.
                if (!(await credentialPresent())) {
                    throw authRequired(
                        "no DeepSeek credential found: save one in the dsh Web UI (Settings → Models) or set DEEPSEEK_API_KEY",
                    );
                }
            },

            async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
                assertOpen();
                validateCwd(params.cwd);
                syncMcpServers(params.mcpServers, params.cwd);
                // No credential gate here: an unauthenticated user must still
                // reach a session so /login has somewhere to run. The prompt
                // handler guides them before anything touches the model.
                const sessionId = SessionId(randomUUID());
                const presets = presetsService();
                const presetId = presets === undefined ? undefined : (await presets.resolve(undefined)).id;
                const handle = await agents.create({
                    sessionId,
                    meta: { cwd: params.cwd, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
                    agentOptions: agentOptionsFor(config.model),
                    ...(presetSetup(presets, presetId) !== undefined
                        ? { setup: presetSetup(presets, presetId) }
                        : {}),
                } as Parameters<typeof agents.create>[0]);
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
                return {
                    sessionId: String(sessionId),
                    modes: await modeState(record),
                    ...(options.length > 0 ? { configOptions: options } : {}),
                };
            },

            async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
                assertOpen();
                validateCwd(params.cwd);
                syncMcpServers(params.mcpServers, params.cwd);
                const persistence = requirePersistence();
                const sessionId = params.sessionId;
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
                let storedHeader: { agentPreset?: string } | undefined;
                try {
                    const inspected = await persistence.inspect(SessionId(sessionId));
                    events = inspected.events;
                    storedHeader = (inspected as unknown as { header?: { agentPreset?: string } }).header;
                } catch (error: unknown) {
                    throw invalidParams(`session not found: ${sessionId} (${errorChain(error)})`);
                }
                const replay = buildReplay(events as unknown as HarnessEvent[]);
                for (const update of replay.updates) notify(sessionId, update);
                if (replay.title !== undefined) {
                    notify(sessionId, {
                        sessionUpdate: "session_info_update",
                        title: replay.title,
                    });
                }
                const presets = presetsService();
                const storedPreset = presetFromLog(storedHeader, events as unknown as { type?: string }[]);
                const presetId =
                    presets === undefined ? undefined : (await presets.resolve(storedPreset)).id;
                const handle = await agents.resume({
                    resumeSessionId: SessionId(sessionId),
                    agentOptions: agentOptionsFor(config.model),
                    ...(presetSetup(presets, presetId) !== undefined
                        ? { setup: presetSetup(presets, presetId) }
                        : {}),
                } as Parameters<typeof agents.resume>[0]);
                const projection = new SessionProjection(replay.contextWindow);
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
                ensureSelection(record);
                queueMicrotask(() => publishCommands(sessionId));
                const options = await configOptions(record);
                return {
                    modes: await modeState(record),
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
                const record = requireSession(params.sessionId);
                if (record.inflight !== undefined) {
                    throw invalidParams("a prompt is already in flight for this session");
                }
                let converted;
                try {
                    converted = convertPrompt(params.prompt);
                } catch (error: unknown) {
                    if (error instanceof UnsupportedPromptContentError) throw invalidParams(error.message);
                    throw error;
                }
                if (converted.blocks.length === 0) throw invalidParams("empty prompt");

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
                if (commandMatch?.[1] === "login") {
                    return respond(await loginText(trimmed.slice(commandMatch[0].length)));
                }
                if (commandMatch?.[1] === "logout") return respond(await logoutText());

                // Gate model turns (not slash commands) on a usable credential,
                // with self-service guidance instead of a bare protocol error.
                if (!(await credentialPresent())) {
                    return respond(
                        [
                            "No DeepSeek credential is configured, so this prompt was not sent to the model.",
                            "",
                            "Configure one of:",
                            "- `/login <api-key>` — store a key in the harness credential store right here,",
                            "- the dsh Web UI (`dsh web`, Settings → Models),",
                            "- `DEEPSEEK_API_KEY` in the environment that launches this agent.",
                        ].join("\n"),
                    );
                }

                // Never drive a retired agent: an agent-loop reload disposes
                // agents while bridge records survive.
                if (agents.get(record.agent.id) !== record.agent) {
                    throw internalError("prompt was not queued: the agent was disposed outside the bridge");
                }

                record.cancelled = false;
                record.projection.beginPrompt();
                const message = createUserMessage({
                    content: converted.blocks,
                    source: { kind: "user" },
                });

                const stopReason = await new Promise<StopReason>((resolve, reject) => {
                    const inflight: Inflight = { resolve, reject, messageId: message.id, turn: undefined };
                    record.inflight = inflight;
                    try {
                        record.agent.followup(message);
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
                const record = requireSession(params.sessionId);
                // With a preset roster, session modes are agent presets; the
                // sandbox lives in the "mode" config option. Without one, modes
                // keep their original sandbox meaning.
                if (presetsService() !== undefined && record.preset !== undefined) {
                    await switchPreset(record, params.sessionId, params.modeId);
                } else {
                    applyMode(record, params.sessionId, params.modeId);
                }
                notify(params.sessionId, {
                    sessionUpdate: "config_option_update",
                    configOptions: await configOptions(record),
                });
                return {};
            },

            async setSessionConfigOption(
                params: SetSessionConfigOptionRequest,
            ): Promise<SetSessionConfigOptionResponse> {
                const record = requireSession(params.sessionId);
                const value = typeof params.value === "string" ? params.value : undefined;
                if (value === undefined) throw invalidParams(`invalid value: ${String(params.value)}`);

                switch (params.configId) {
                    case "mode": {
                        applyMode(record, params.sessionId, value);
                        break;
                    }
                    case "approvals": {
                        if (value !== "ask" && value !== "never") throw invalidParams(`unknown approvals: ${value}`);
                        setApprovalPolicy(record, value);
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

    function requirePersistence(): NonNullable<ReturnType<typeof getPersistence>> {
        const persistence = getPersistence();
        if (persistence === undefined) {
            throw internalError("session persistence is not composed; session history is unavailable");
        }
        return persistence;
    }

    function getPersistence(): Context["sessionPersistence"] | undefined {
        return ctx.get("sessionPersistence") as Context["sessionPersistence"] | undefined;
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

    const stream: Stream =
        config.stream ??
        ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
        );
    conn = new AgentSideConnection(makeAgent, stream);

    let quiescing: Promise<void> | undefined;
    const quiesce = (): Promise<void> => {
        if (quiescing !== undefined) return quiescing;
        closed = true;
        const records = [...sessions.values()];
        sessions.clear();
        for (const record of records) {
            record.agent.cancel({ kind: "user" });
            settlePrompt(record, "cancelled");
        }
        quiescing = (async () => {
            // Continuable subagents (when composed) own descendant teardown;
            // drain them child-first before disposing the top-level agents.
            const subagents = ctx.get("subagents") as
                | { drainContinuableDescendants(parents: readonly Agent[]): Promise<void> }
                | undefined;
            if (subagents !== undefined) {
                try {
                    await subagents.drainContinuableDescendants(records.map((record) => record.agent));
                } catch (error: unknown) {
                    logWarn(`continuable subagent teardown failed: ${String(error)}`);
                }
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
