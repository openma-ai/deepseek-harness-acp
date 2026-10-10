#!/usr/bin/env node

import { registerHooks } from "node:module";

import { HarnessCompatibilityError, HarnessNotFoundError, hostModuleUrl, resolveHost } from "./harness.ts";
import { logError } from "./log.ts";
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

    let host;
    try {
        host = resolveHost(explicitDshPath(argv));
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
    await import(cli);
}

bootstrap().catch((error: unknown) => {
    logError(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
});
