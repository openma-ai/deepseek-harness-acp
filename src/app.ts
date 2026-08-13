/**
 * The dsh-acp application composition.
 *
 * Mirrors the shape of `@deepseek-ai/dsh-acp-demo` (agent spine + JSONL
 * persistence + checkpoint policy + protocol bridge) plus the executor leaf
 * from the reference `examples/acp-agent` composition (sandboxed bash and
 * filesystem stacks, one-shot approvals, todo tool, token metering, and
 * context compaction) — but mounts this package's rich ACP bridge instead of
 * the automation-only `@deepseek-ai/dsh-acp`.
 *
 * The composition is programmatic (no cordis.yml): every plugin is an
 * ordinary `ctx.plugin(module, config)` call, and the ordered `ctx.effect`
 * generator disposes in reverse so ACP agents quiesce before persistence
 * detaches.
 */

import type { Context } from "@deepseek-ai/cordis";

import * as llmDeepseek from "@deepseek-ai/dsh-llm-deepseek";
import * as agentSpine from "@deepseek-ai/dsh-agent-spine-demo";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import * as sessionCheckpointPolicy from "@deepseek-ai/dsh-session-checkpoint-policy";
import LocalSandboxProvider from "@deepseek-ai/dsh-sandbox-local";
import SandboxPolicyService from "@deepseek-ai/dsh-sandbox-policy";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import SandboxBashExecutor from "@deepseek-ai/dsh-bash-sandbox";
import ApprovalService from "@deepseek-ai/dsh-user-approval";
import SandboxedFileSystem from "@deepseek-ai/dsh-fs-sandbox";
import * as fsObservationPolicy from "@deepseek-ai/dsh-fs-observation-policy";
import * as toolFs from "@deepseek-ai/dsh-tool-fs";
import * as toolTodo from "@deepseek-ai/dsh-tool-todo";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";

import * as acpBridge from "./bridge/index.ts";
import type { Settings } from "./settings.ts";

export const name = "dsh-acp-app";

/**
 * Compose the full agent + transport tree on `ctx`.
 */
export async function apply(ctx: Context, settings: Settings): Promise<void> {
    await ctx.effect(async function* () {
        // Model adapter: resolves DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL from
        // the launching environment; nothing secret is inlined here.
        const llm = ctx.plugin(llmDeepseek, {
            thinking: settings.thinking ? "enabled" : "disabled",
            reasoningEffort: settings.reasoningEffort,
        });
        await llm;
        yield llm.dispose;

        // Agent spine: llm runtime, sessions, system prompt, tools registry,
        // agent registry + loop, bash tool, workspace AGENTS.md context.
        const spine = ctx.plugin(agentSpine, {
            persona: settings.persona,
            workspaceContext: { maxBytes: 65_536 },
            goals: false,
        });
        await spine;
        yield spine.dispose;

        // Durable JSONL session store (uncompressed for interoperability)
        // plus the explicit request/tool/step durability checkpoints.
        const persistence = ctx.plugin(JsonlSessionPersistence, {
            root: settings.sessionRoot,
            compression: "none",
        });
        await persistence;
        yield persistence.dispose;
        const checkpoints = ctx.plugin(sessionCheckpointPolicy);
        await checkpoints;
        yield checkpoints.dispose;

        // Sandboxed execution: platform sandbox chain, per-session mode
        // policy, managed subprocess groups, confined bash, one-shot
        // approvals for wider-access retries.
        const sandbox = ctx.plugin(LocalSandboxProvider, {});
        await sandbox;
        yield sandbox.dispose;
        const sandboxPolicy = ctx.plugin(SandboxPolicyService, {
            mode: settings.permissionMode,
            workspaceRoot: process.cwd(),
        });
        await sandboxPolicy;
        yield sandboxPolicy.dispose;
        const subprocess = ctx.plugin(LocalSubprocessRuntime);
        await subprocess;
        yield subprocess.dispose;
        const bash = ctx.plugin(SandboxBashExecutor, { timeoutMs: settings.bashTimeoutMs });
        await bash;
        yield bash.dispose;
        const approval = ctx.plugin(ApprovalService, {
            policy: settings.permissionMode === "danger-full-access" ? "never" : "ask",
        });
        await approval;
        yield approval.dispose;

        // Filesystem stack riding the same sandbox policy, with the
        // read-before-edit observation gate and the model-facing fs tools.
        const fs = ctx.plugin(SandboxedFileSystem, {});
        await fs;
        yield fs.dispose;
        const fsPolicy = ctx.plugin(fsObservationPolicy);
        await fsPolicy;
        yield fsPolicy.dispose;
        const fsTools = ctx.plugin(toolFs, {});
        await fsTools;
        yield fsTools.dispose;

        // Plan tool: whole-list todo snapshots (streamed to ACP as `plan`).
        const todo = ctx.plugin(toolTodo, { allowParallelInProgress: true });
        await todo;
        yield todo.dispose;

        // Request pressure + automatic context compaction.
        const meter = ctx.plugin(TokenMeter);
        await meter;
        yield meter.dispose;
        const compaction = ctx.plugin(BasicCompactionEngine, {
            thresholdRatio: 0.8,
            retainRatio: 0.08,
            maxTokens: 8192,
            compactionRetries: 1,
        });
        await compaction;
        yield compaction.dispose;

        // The ACP transport bridge (owns stdout).
        const bridge = ctx.plugin(acpBridge, {
            provider: settings.provider,
            model: settings.model,
            models: settings.models,
            ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
            permissionMode: settings.permissionMode,
        });
        await bridge;
        yield bridge.dispose;
    }, "dsh-acp-app.composition");
}
