#!/usr/bin/env node
/**
 * dsh-acp — Agent Client Protocol stdio server for DeepSeek Harness.
 *
 * Finds the user's DeepSeek Harness installation (DSH_PATH or auto-detected;
 * see src/harness.ts), composes the agent runtime from it in-process, and
 * serves ACP JSON-RPC on stdin/stdout. Stdout is reserved for the protocol;
 * every diagnostic goes to stderr.
 */

import * as app from "./app.ts";
import { HarnessNotFoundError, loadKit, resolveHost } from "./harness.ts";
import { logDebug, logError } from "./log.ts";
import { HELP_TEXT, resolveSettings, SettingsError } from "./settings.ts";
import { VERSION } from "./version.ts";

const NAME = "@deepseek-ai-harness/dsh-acp";

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

    let kit;
    try {
        const host = resolveHost(settings.dshPath);
        logDebug(`harness host: ${host.base} via ${host.source} (${host.version ?? "unknown version"})`);
        kit = await loadKit(host);
    } catch (error: unknown) {
        if (error instanceof HarnessNotFoundError) {
            logError(error.message);
            process.exitCode = 1;
            return;
        }
        throw error;
    }

    const ctx = new kit.cordis.Context();
    await ctx.plugin(app, { settings, kit });

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
