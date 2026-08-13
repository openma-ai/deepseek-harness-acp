/**
 * Bundle entry: the ACP bridge as a dsh profile plugin.
 *
 * This is what `@deepseek-ai-harness/dsh-acp/bridge` resolves to when the
 * package is installed into a dsh profile (`dsh plugin --profile acp add …`)
 * and named by the bundle patch. In a profile, the surrounding dsh
 * installation provides every `@deepseek-ai/*` module, so — unlike the
 * standalone CLI, which loads them from a discovered host tree — this entry
 * imports its helpers directly and hands the bridge a ready `harness` kit.
 *
 * The agent composition (spine, adapters, tools, persistence, sandbox,
 * skills, subagents, …) comes from the profile's other bundles, normally
 * `@deepseek-ai/dsh-base`. The bridge rides whatever the profile mounts: its
 * event projection is composition-agnostic by design.
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { foldSessionTitle } from "@deepseek-ai/dsh-session-title";
import { SANDBOX_MODES, setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

import * as bridge from "./bridge/index.ts";
import type { AcpBridgeConfig, BridgeHarness } from "./bridge/index.ts";

export const name = bridge.name;
export const inject = bridge.inject;

/** Bundle-facing config: everything except the injected harness kit. */
export type Config = Omit<AcpBridgeConfig, "harness" | "stream">;

const HARNESS: BridgeHarness = {
    createUserMessage,
    errorChain,
    sessionId: SessionId,
    foldSessionTitle,
    setSandboxMode,
    sandboxModes: SANDBOX_MODES,
    credentialRef,
};

export function apply(ctx: Context, config: Config): void {
    bridge.apply(ctx, {
        provider: config.provider ?? "deepseek-official",
        model: config.model ?? "deepseek-v4-flash",
        ...(config.models !== undefined ? { models: config.models } : {}),
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {}),
        harness: HARNESS,
    });
}
