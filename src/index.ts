#!/usr/bin/env node
/**
 * dsh-acp — Agent Client Protocol stdio server for DeepSeek Harness.
 *
 * Boots the harness composition (`src/app.ts`) on a fresh cordis Context and
 * serves ACP JSON-RPC on stdin/stdout. Stdout is reserved for the protocol;
 * every diagnostic goes to stderr.
 */

import { Context } from "@deepseek-ai/cordis";

import * as app from "./app.ts";
import { logError } from "./log.ts";
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

    const ctx = new Context();
    await ctx.plugin(app, settings);

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
