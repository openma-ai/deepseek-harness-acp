#!/usr/bin/env node
/**
 * dsh-acp — Agent Client Protocol stdio server for DeepSeek Harness.
 *
 * Finds the user's DeepSeek Harness installation (DSH_PATH or auto-detected;
 * see src/harness.ts), composes the agent runtime from it in-process, and
 * serves ACP JSON-RPC on stdin/stdout. Stdout is reserved for the protocol;
 * every diagnostic goes to stderr.
 */

import { spawnSync } from "node:child_process";

import { HarnessNotFoundError, resolveHost } from "./harness.ts";
import { bootAcpProfile, type BootedContext } from "./profile-boot.ts";
import { runLogin } from "./login.ts";
import { logDebug, logError, logInfo } from "./log.ts";
import { HELP_TEXT, resolveSettings, SettingsError } from "./settings.ts";
import { VERSION } from "./version.ts";

const NAME = "@openma/deepseek-harness-acp";

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes("--version")) {
        console.log(`${NAME} ${VERSION}`);
        return;
    }
    if (argv.includes("--help")) {
        console.log(HELP_TEXT.trimEnd());
        return;
    }
    if (argv[0] === "login") {
        // CLI login: interactive credential setup, then exit. Boots
        // the same composition as serving (minus the stdio server) so the
        // key lands in the shared harness credential store.
        let booted: BootedContext;
        try {
            const host = resolveHost(undefined);
            booted = await bootAcpProfile(host, { serve: false });
        } catch (error: unknown) {
            if (error instanceof HarnessNotFoundError) {
                logError(error.message);
                process.exitCode = 1;
                return;
            }
            throw error;
        }
        try {
            process.exitCode = await runLogin(
                booted as unknown as Parameters<typeof runLogin>[0],
                argv.slice(1),
            );
        } finally {
            await booted.fiber.dispose().catch(() => undefined);
        }
        return;
    }
    if (argv[0] === "update") {
        // Self-update through the same package manager that installed us.
        logInfo(`updating ${NAME} (npm install -g ${NAME}@latest)…`);
        const result = spawnSync("npm", ["install", "-g", `${NAME}@latest`], { stdio: ["ignore", 2, 2] });
        if (result.status !== 0) {
            logError(`npm install failed with status ${result.status ?? "unknown"}`);
            process.exitCode = result.status ?? 1;
            return;
        }
        logInfo("updated. If you also keep a global DeepSeek Harness, refresh it with:");
        logInfo("    npm install -g @deepseek-ai/dsh@latest");
        return;
    }

    let settings;
    try {
        settings = resolveSettings(argv);
    } catch (error: unknown) {
        if (error instanceof SettingsError) {
            logError(error.message);
            process.stderr.write(`\n${HELP_TEXT}`);
            process.exitCode = 2;
            return;
        }
        throw error;
    }

    let ctx: { fiber: { dispose(): Promise<void> } };
    try {
        const host = resolveHost(settings.dshPath);
        logDebug(`harness host: ${host.base} via ${host.source} (${host.version ?? "unknown version"})`);
        if (process.env["DSH_ACP_COMPOSE"] === "spine") {
            logError(
                "DSH_ACP_COMPOSE=spine is no longer supported: the ACP bridge injects dsh-base services (credentials, models, permissions, presets). Unset DSH_ACP_COMPOSE to use the profile engine.",
            );
            process.exitCode = 1;
            return;
        }
        // The dsh profile composition (dsh-base + this package's bundle patch +
        // the user's $DSH_HOME layers), sharing the product's own home state.
        const booted: BootedContext = await bootAcpProfile(host, {
            bundles: settings.bundles,
            ...(settings.provider !== undefined ? { provider: settings.provider } : {}),
            ...(settings.model !== undefined ? { model: settings.model } : {}),
            ...(settings.permissionMode !== undefined ? { permissionMode: settings.permissionMode } : {}),
            ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
        });
        ctx = booted;
    } catch (error: unknown) {
        if (error instanceof HarnessNotFoundError) {
            logError(error.message);
            process.exitCode = 1;
            return;
        }
        throw error;
    }

    let disposing = false;
    const shutdown = (code: number): void => {
        if (disposing) return;
        disposing = true;
        void ctx.fiber
            .dispose()
            .catch((error: unknown) => {
                logError(`teardown failed: ${String(error)}`);
            })
            .finally(() => {
                process.exit(code);
            });
    };

    // The ACP client owns process lifetime: EOF on stdin ends the server.
    process.stdin.on("end", () => shutdown(0));
    process.stdin.on("close", () => shutdown(0));
    process.on("SIGINT", () => shutdown(130));
    process.on("SIGTERM", () => shutdown(143));
}

main().catch((error: unknown) => {
    logError(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
});
