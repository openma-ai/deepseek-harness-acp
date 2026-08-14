/**
 * Bundle entry: the ACP bridge as a dsh profile plugin.
 *
 * This is what `@openma/deepseek-harness-acp/bridge` resolves to when the
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

import * as bridge from "./bridge/index.ts";
import { selfHarness } from "./bridge/self-harness.ts";
import type { AcpBridgeConfig } from "./bridge/index.ts";

export const name = bridge.name;
export const inject = bridge.inject;

/** Bundle-facing config: everything except the injected harness kit. */
export type Config = Omit<AcpBridgeConfig, "harness" | "stream">;

export function apply(ctx: Context, config: Config): void {
    // No pinned defaults: absent provider/model means the composition's own
    // default route (agent-default-model reading the user's settings.yaml).
    bridge.apply(ctx, {
        ...(config.provider !== undefined ? { provider: config.provider } : {}),
        ...(config.model !== undefined ? { model: config.model } : {}),
        ...(config.models !== undefined ? { models: config.models } : {}),
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {}),
        harness: selfHarness(),
    });
}
