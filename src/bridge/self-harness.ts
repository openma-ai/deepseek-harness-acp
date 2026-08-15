/**
 * Self-contained harness helpers for bundle/library mounting.
 *
 * When the bridge is mounted by the dsh profile loader (a `cordis.patch.yml`
 * row naming `@openma/deepseek-harness-acp/bridge`), plugin config is plain
 * YAML — no way to inject functions. This module builds the {@link
 * BridgeHarness} from ordinary imports instead; the packages are declared as
 * regular dependencies, so the profile's pnpm install provides them. All of
 * them are pure helpers (no service identity), so a copy that differs from
 * the composition's own tree is functionally equivalent.
 *
 * The standalone CLI never loads this module: it injects host-tree functions
 * through `config.harness` (see src/harness.ts).
 */

import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { foldSessionTitle } from "@deepseek-ai/dsh-session-title";
import { SANDBOX_MODES, setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import * as agentModule from "@deepseek-ai/dsh-agent";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";

import type { BridgeHarness } from "./index.ts";

export function selfHarness(): BridgeHarness {
    // rc builds shipped `installModelSelection` under a mangled name for a
    // while; accept either so bundle mounts work across host versions.
    const agents = agentModule as unknown as {
        installModelSelection?: BridgeHarness["installModelSelection"];
        ln?: BridgeHarness["installModelSelection"];
    };
    const installModelSelection = agents.installModelSelection ?? agents.ln;
    return {
        createUserMessage,
        errorChain,
        sessionId: SessionId,
        foldSessionTitle,
        setSandboxMode,
        sandboxModes: SANDBOX_MODES,
        ...(installModelSelection !== undefined ? { installModelSelection } : {}),
        mcpClient: mcpClient as unknown as NonNullable<BridgeHarness["mcpClient"]>,
    };
}
