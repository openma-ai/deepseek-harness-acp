#!/usr/bin/env node

import { registerHooks } from "node:module";

import { HarnessCompatibilityError, HarnessNotFoundError, hostModuleUrl, resolveHost } from "./harness.ts";
import { logError } from "./log.ts";
import { prefetchStandaloneRuntime } from "./runtime.ts";
import { explicitDshPath, HELP_TEXT } from "./settings.ts";
import { VERSION } from "./version.ts";

const NAME = "@openma/deepseek-harness-acp";

async function bootstrap(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes("--version")) {
        console.log(`${NAME} ${VERSION}`);
        return;
    }
    if (argv.includes("--help")) {
        console.log(HELP_TEXT.trimEnd());
        return;
    }
    if (argv.includes("--prefetch-runtime")) {
        // Warm the runtime cache without booting a host, so that the first
        // real start works offline. Never touches stdout: the ACP wire owns it.
        try {
            await prefetchStandaloneRuntime();
        } catch (error: unknown) {
            logError(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
        return;
    }

    let host;
    try {
        host = await resolveHost(explicitDshPath(argv));
    } catch (error: unknown) {
        if (error instanceof HarnessNotFoundError || error instanceof HarnessCompatibilityError) {
            logError(error.message);
            process.exitCode = 1;
            return;
        }
        throw error;
    }

    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === "@deepseek-ai/cordis" || specifier.startsWith("@deepseek-ai/")) {
                return { shortCircuit: true, url: hostModuleUrl(host, specifier) };
            }
            return nextResolve(specifier, context);
        },
    });

    const cli = import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js";
    const mod = (await import(cli)) as { main(argv?: string[]): Promise<void> };
    await mod.main(argv);
}

/** Awaitable bootstrap for tests; binaries observe the usual exit paths. */
export const ready: Promise<void> = bootstrap().catch((error: unknown) => {
    logError(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
});
