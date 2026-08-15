/**
 * The dsh-acp application composition, built from a resolved DeepSeek Harness
 * host installation.
 *
 * Mirrors the plugin tree of the in-repo ACP example: the agent spine
 * (replicated from `@deepseek-ai/dsh-agent-spine-demo`'s composition — the
 * demo bundle itself is not shipped with the `@deepseek-ai/dsh` CLI), JSONL
 * session persistence with explicit durability checkpoints, the sandboxed
 * bash and filesystem stacks with one-shot approvals, the todo tool, token
 * metering, context compaction — and this package's ACP bridge as the
 * transport.
 *
 * Every module here comes from the host tree (`loadKit`); this file never
 * imports harness packages by specifier at runtime.
 */

import type { Context } from "@deepseek-ai/cordis";

import * as acpBridge from "./bridge/index.ts";
import type { BridgeHarness } from "./bridge/index.ts";
import { pluginOf, type HarnessKit } from "./harness.ts";
import type { Settings } from "./settings.ts";

export const name = "dsh-acp-app";

export interface AppConfig {
    settings: Settings;
    kit: HarnessKit;
}

/** Session-title fallback limits, mirrored from agent-spine-demo's example policy. */
const SESSION_TITLE_CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 };

/**
 * Replicate the agent spine: LLM vocabulary and core registries first, then
 * the seam plugins, then the loop that drives them. Load order is free
 * (cordis pends each fiber on its `inject`), but the listing mirrors the
 * layering for readability. Skills and goals stay unmounted: the editor owns
 * task framing, and every mounted surface must exist in the host CLI's
 * dependency closure.
 */
function applySpine(ctx: Context, kit: HarnessKit, settings: Settings): void {
    const p = kit.plugins;
    const anyCtx = ctx as { plugin(plugin: unknown, config?: unknown): unknown };
    const resolveDshHome = (p["homePaths"] as { resolveDshHome?: (home?: string) => string }).resolveDshHome;
    const dshHome = resolveDshHome?.();

    anyCtx.plugin(pluginOf(p["timer"]!));
    anyCtx.plugin(pluginOf(p["llmRuntime"]!));
    anyCtx.plugin(pluginOf(p["sessionStore"]!));
    anyCtx.plugin(pluginOf(p["sessionTitle"]!), SESSION_TITLE_CONFIG);
    anyCtx.plugin(pluginOf(p["systemPrompt"]!), {
        includeHarnessIdentity: true,
        includeRuntimeContext: true,
        persona: settings.persona,
    });
    anyCtx.plugin(pluginOf(p["tools"]!), {});
    anyCtx.plugin(pluginOf(p["agents"]!));
    anyCtx.plugin(p["llmRetry"]!);
    anyCtx.plugin(pluginOf(p["jobs"]!), {});
    anyCtx.plugin(pluginOf(p["invariants"]!), {});
    anyCtx.plugin(p["sessionInvariant"]!);
    anyCtx.plugin(p["agentInvariant"]!);
    anyCtx.plugin(p["scopeInvariant"]!);
    anyCtx.plugin(p["agentLoopInvariant"]!);
    anyCtx.plugin(p["bashEnv"]!, dshHome !== undefined ? { dshHome } : {});
    anyCtx.plugin(p["toolBash"]!, {});
    anyCtx.plugin(p["workspaceContext"]!, { maxBytes: 65_536 });
    anyCtx.plugin(pluginOf(p["agentLoop"]!), { agents: [] });
}

/**
 * Compose the full agent + transport tree on `ctx`.
 */
export async function apply(ctx: Context, config: AppConfig): Promise<void> {
    const { settings, kit } = config;
    const p = kit.plugins;
    const anyCtx = ctx as unknown as {
        plugin(plugin: unknown, config?: unknown): PromiseLike<unknown> & { dispose: unknown };
        effect(callback: () => unknown, label: string): Promise<void>;
    };

    // The bridge needs a handful of host functions beyond the plugin tree.
    // rc builds shipped `installModelSelection` under a mangled name for a
    // while; accept either so attach mode works across host versions.
    const agentsModule = p["agents"] as unknown as {
        installModelSelection?: BridgeHarness["installModelSelection"];
        ln?: BridgeHarness["installModelSelection"];
    };
    const installModelSelection = agentsModule.installModelSelection ?? agentsModule.ln;
    const harness: BridgeHarness = {
        createUserMessage: kit.llm.createUserMessage,
        errorChain: kit.llm.errorChain,
        sessionId: kit.session.SessionId,
        foldSessionTitle: kit.sessionTitle.foldSessionTitle,
        setSandboxMode: kit.sandboxPolicy.setSandboxMode,
        sandboxModes: kit.sandboxPolicy.SANDBOX_MODES,
        ...(installModelSelection !== undefined ? { installModelSelection } : {}),
        ...(p["mcpClient"] !== undefined
            ? { mcpClient: p["mcpClient"] as unknown as NonNullable<BridgeHarness["mcpClient"]> }
            : {}),
    };

    await (ctx as unknown as typeof anyCtx).effect(async function* (this: unknown) {
        // Spine (agent core). Mounted as one child so it disposes last.
        const spine = anyCtx.plugin(
            { name: "dsh-acp-spine", apply: (child: Context) => applySpine(child, kit, settings) },
            {},
        );
        await spine;
        yield spine.dispose;

        // User credentials: the official local provider owns
        // `$DSH_HOME/.credentials.yaml`. Required — the bridge injects it.
        const credentialsModule = p["credentials"];
        if (credentialsModule === undefined) {
            throw new Error("this host has no @deepseek-ai/dsh-credentials-local; the ACP bridge injects ctx.credentials");
        }
        const credentials = anyCtx.plugin(pluginOf(credentialsModule), {});
        await credentials;
        yield credentials.dispose;

        // Model adapter: resolves DEEPSEEK_API_KEY through the credential
        // seam mounted above, falling back to the launching environment;
        // nothing secret is inlined here.
        const llm = anyCtx.plugin(p["llmDeepseek"]!, {
            thinking: settings.thinking ? "enabled" : "disabled",
            reasoningEffort: settings.reasoningEffort,
        });
        await llm;
        yield llm.dispose;

        // Durable JSONL session store (uncompressed for interoperability)
        // plus the explicit request/tool/step durability checkpoints.
        const persistence = anyCtx.plugin(pluginOf(p["persistence"]!), {
            root: settings.sessionRoot,
            compression: "none",
        });
        await persistence;
        yield persistence.dispose;
        const checkpoints = anyCtx.plugin(p["checkpoints"]!);
        await checkpoints;
        yield checkpoints.dispose;

        // Sandboxed execution: platform sandbox chain, per-session mode
        // policy, managed subprocess groups, confined bash, one-shot
        // approvals for wider-access retries.
        const sandbox = anyCtx.plugin(pluginOf(p["sandbox"]!), {});
        await sandbox;
        yield sandbox.dispose;
        const sandboxPolicy = anyCtx.plugin(pluginOf(p["sandboxPolicy"]!), {
            mode: settings.permissionMode,
            workspaceRoot: process.cwd(),
        });
        await sandboxPolicy;
        yield sandboxPolicy.dispose;
        const subprocess = anyCtx.plugin(pluginOf(p["subprocess"]!));
        await subprocess;
        yield subprocess.dispose;
        const bash = anyCtx.plugin(pluginOf(p["bash"]!), { timeoutMs: settings.bashTimeoutMs });
        await bash;
        yield bash.dispose;
        const approval = anyCtx.plugin(pluginOf(p["approval"]!), {
            policy: settings.permissionMode === "danger-full-access" ? "never" : "ask",
        });
        await approval;
        yield approval.dispose;

        // Filesystem stack riding the same sandbox policy, with the
        // read-before-edit observation gate and the model-facing fs tools.
        const fs = anyCtx.plugin(pluginOf(p["fs"]!), {});
        await fs;
        yield fs.dispose;
        const fsPolicy = anyCtx.plugin(p["fsObservationPolicy"]!);
        await fsPolicy;
        yield fsPolicy.dispose;
        const fsTools = anyCtx.plugin(p["toolFs"]!, {});
        await fsTools;
        yield fsTools.dispose;

        // Plan tool: whole-list todo snapshots (streamed to ACP as `plan`).
        const todo = anyCtx.plugin(p["toolTodo"]!, { allowParallelInProgress: true });
        await todo;
        yield todo.dispose;

        // Request pressure + automatic context compaction.
        const meter = anyCtx.plugin(pluginOf(p["tokenMeter"]!));
        await meter;
        yield meter.dispose;
        const compaction = anyCtx.plugin(pluginOf(p["compaction"]!), {
            thresholdRatio: 0.8,
            retainRatio: 0.08,
            maxTokens: 8192,
            compactionRetries: 1,
        });
        await compaction;
        yield compaction.dispose;

        // The ACP transport bridge (owns stdout). The spine engine keeps its
        // historical fixed defaults when no explicit selection was given.
        const bridge = anyCtx.plugin(acpBridge, {
            provider: settings.provider ?? "deepseek-official",
            model: settings.model ?? "deepseek-v4-flash",
            models: settings.models,
            ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
            permissionMode: settings.permissionMode,
            harness,
        });
        await bridge;
        yield bridge.dispose;
    }, "dsh-acp-app.composition");
}
