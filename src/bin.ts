#!/usr/bin/env node

import { registerHooks } from "node:module";

import { HarnessNotFoundError, hostModuleUrl, resolveHost } from "./harness.ts";
import { logError } from "./log.ts";
import { HELP_TEXT } from "./settings.ts";
import { VERSION } from "./version.ts";

const NAME = "@openma/deepseek-harness-acp";

function explicitDshPath(argv: string[]): string | undefined {
    const index = argv.indexOf("--dsh-path");
    if (index >= 0) return argv[index + 1];
    const env = process.env["DSH_PATH"];
    return env !== undefined && env.length > 0 ? env : undefined;
}

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
        if (error instanceof HarnessNotFoundError) {
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
