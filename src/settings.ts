/**
 * CLI/environment configuration for the dsh-acp server.
 *
 * Flags win over environment variables, which win over defaults. Environment
 * names follow the DeepSeek Harness conventions (`DSH_*`, `DEEPSEEK_*`) so a
 * setup that works with the harness Web UI or Python SDK works here too.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";

export interface Settings {
    /** Explicit DeepSeek Harness installation (DSH_PATH); auto-detected when unset. */
    dshPath: string | undefined;
    provider: string | undefined;
    model: string | undefined;
    /** Selectable model candidates (session config option). */
    models: string[];
    maxTokens: number | undefined;
    permissionMode: SandboxMode;
    sessionRoot: string;
    persona: string;
    thinking: boolean;
    reasoningEffort: "off" | "high" | "max";
    /** Foreground bash tool timeout in milliseconds. */
    bashTimeoutMs: number;
}

export const DEFAULT_PERSONA = `You are a coding assistant powered by the {{model}} model, working inside an editor via the Agent Client Protocol. Your working directory is {{cwd}}. Your bash tool runs under a file sandbox — a \`[sandbox: file access denied …]\` result is policy, not a command bug.

Verify your work by running the code or tests. Keep answers brief and factual.`;

const PERMISSION_MODES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

export class SettingsError extends Error {}

function envString(name: string): string | undefined {
    const value = process.env[name];
    return value !== undefined && value.length > 0 ? value : undefined;
}

interface ParsedArgs {
    flags: Map<string, string | true>;
}

function parseFlags(argv: string[]): ParsedArgs {
    const flags = new Map<string, string | true>();
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === undefined || !arg.startsWith("--")) {
            throw new SettingsError(`unexpected argument: ${String(arg)}`);
        }
        const eq = arg.indexOf("=");
        if (eq >= 0) {
            flags.set(arg.slice(2, eq), arg.slice(eq + 1));
            continue;
        }
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--") && FLAGS_WITH_VALUES.has(name)) {
            flags.set(name, next);
            i += 1;
        } else {
            flags.set(name, true);
        }
    }
    return { flags };
}

const FLAGS_WITH_VALUES = new Set([
    "dsh-path",
    "provider",
    "model",
    "models",
    "max-tokens",
    "permission-mode",
    "session-root",
    "persona",
    "reasoning-effort",
    "bash-timeout",
]);

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
    const value = parsed.flags.get(name);
    if (value === undefined) return undefined;
    if (value === true) throw new SettingsError(`--${name} requires a value`);
    return value;
}

/**
 * Resolve settings from CLI flags and the environment.
 */
export function resolveSettings(argv: string[]): Settings {
    const parsed = parseFlags(argv);
    for (const name of parsed.flags.keys()) {
        if (!FLAGS_WITH_VALUES.has(name) && name !== "no-thinking") {
            throw new SettingsError(`unknown flag: --${name}`);
        }
    }

    const model = stringFlag(parsed, "model") ?? envString("DSH_MODEL");
    const modelsRaw = stringFlag(parsed, "models") ?? envString("DSH_ACP_MODELS");
    const models = (modelsRaw !== undefined ? modelsRaw.split(",") : ["deepseek-v4-flash", "deepseek-v4-pro"])
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    const permissionModeRaw =
        stringFlag(parsed, "permission-mode") ?? envString("DSH_PERMISSION_MODE") ?? "workspace-write";
    const permissionMode = PERMISSION_MODES.find((candidate) => candidate === permissionModeRaw);
    if (permissionMode === undefined) {
        throw new SettingsError(
            `invalid --permission-mode: ${permissionModeRaw} (expected ${PERMISSION_MODES.join(" | ")})`,
        );
    }

    const maxTokensRaw = stringFlag(parsed, "max-tokens") ?? envString("DSH_MAX_TOKENS");
    let maxTokens: number | undefined;
    if (maxTokensRaw !== undefined) {
        maxTokens = Number(maxTokensRaw);
        if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
            throw new SettingsError(`invalid --max-tokens: ${maxTokensRaw}`);
        }
    }

    const reasoningRaw = stringFlag(parsed, "reasoning-effort") ?? envString("DSH_REASONING_EFFORT") ?? "high";
    if (reasoningRaw !== "off" && reasoningRaw !== "high" && reasoningRaw !== "max") {
        throw new SettingsError(`invalid --reasoning-effort: ${reasoningRaw} (expected off | high | max)`);
    }

    const bashTimeoutRaw = stringFlag(parsed, "bash-timeout") ?? envString("DSH_BASH_TIMEOUT_MS") ?? "60000";
    const bashTimeoutMs = Number(bashTimeoutRaw);
    if (!Number.isSafeInteger(bashTimeoutMs) || bashTimeoutMs <= 0) {
        throw new SettingsError(`invalid --bash-timeout: ${bashTimeoutRaw}`);
    }

    return {
        dshPath: stringFlag(parsed, "dsh-path") ?? envString("DSH_PATH"),
        provider: stringFlag(parsed, "provider") ?? envString("DSH_PROVIDER"),
        model,
        models,
        maxTokens,
        permissionMode,
        sessionRoot:
            stringFlag(parsed, "session-root") ??
            envString("DSH_SESSION_ROOT") ??
            join(homedir(), ".dsh-acp", "sessions"),
        persona: stringFlag(parsed, "persona") ?? envString("DSH_SYSTEM_PROMPT") ?? DEFAULT_PERSONA,
        thinking: !parsed.flags.has("no-thinking"),
        reasoningEffort: reasoningRaw,
        bashTimeoutMs,
    };
}

export const HELP_TEXT = `Usage: dsh-acp [options]
       dsh-acp login [api-key]   Save a DeepSeek API key (interactive when omitted)
       dsh-acp update            Self-update via npm

Agent Client Protocol (ACP) stdio server for DeepSeek Harness. Speak ACP on
stdin/stdout from an ACP client such as Zed; diagnostics go to stderr.

Options:
  --dsh-path <path>           DeepSeek Harness installation: the dsh binary, its
                              package dir, or any dir carrying node_modules/@deepseek-ai
                              (DSH_PATH; auto-detected when unset — own tree, ./node_modules,
                              dsh on PATH, npm root -g)
  --provider <route>          Provider route (DSH_PROVIDER, default deepseek-official)
  --model <id>                Default model (DSH_MODEL, default deepseek-v4-flash)
  --models <a,b,...>          Selectable models for the session "Model" option
                              (DSH_ACP_MODELS, default deepseek-v4-flash,deepseek-v4-pro)
  --max-tokens <n>            Per-request output-token cap (DSH_MAX_TOKENS)
  --permission-mode <mode>    read-only | workspace-write | danger-full-access
                              (DSH_PERMISSION_MODE, default workspace-write)
  --session-root <dir>        JSONL session store (DSH_SESSION_ROOT, default ~/.dsh-acp/sessions)
  --persona <text>            System-prompt persona (DSH_SYSTEM_PROMPT)
  --reasoning-effort <level>  off | high | max (DSH_REASONING_EFFORT, default high)
  --no-thinking               Disable model thinking output
  --bash-timeout <ms>         Foreground bash timeout (DSH_BASH_TIMEOUT_MS, default 60000)
  --version                   Print version and exit
  --help                      Show this help

Environment:
  DSH_PATH                    DeepSeek Harness installation (see --dsh-path)
  DEEPSEEK_API_KEY            DeepSeek (or compatible) API credential
  DEEPSEEK_BASE_URL           OpenAI-compatible endpoint override
  DSH_ACP_DEBUG               Verbose stderr diagnostics
`;
