#!/usr/bin/env node

import { VERSION } from "./version";

const NAME = "@deepseek-ai-harness/dsh-acp";

if (process.argv.includes("--version")) {
    console.log(`${NAME} ${VERSION}`);
    process.exit(0);
}

if (process.argv.includes("--help")) {
    console.log(`${NAME} ${VERSION}

Agent Client Protocol (ACP) adapter for DeepSeek Harness.

Usage: dsh-acp [--version] [--help]`);
    process.exit(0);
}

console.log(`${NAME} ${VERSION}`);
process.exit(0);
