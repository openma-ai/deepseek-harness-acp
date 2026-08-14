/**
 * `dsh-acp login` — interactive terminal credential setup (ACP Terminal Auth).
 *
 * Boots the same composition the server uses and writes the API key through
 * the harness credential seam (`~/.dsh/.credentials.yaml`, mode 600 — the
 * exact file the dsh Web UI reads and writes). Never echoes the key.
 */

import type { Context } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface CredentialStore {
    resolve(ref: unknown): Promise<{ value: string } | undefined>;
    describe(ref: unknown): Promise<{ configured: boolean; source?: string; writable: boolean }>;
    set(ref: unknown, value: string): Promise<void>;
    unset(ref: unknown): Promise<void>;
}

/** Read one secret line: raw-mode TTY without echo, or a piped line. */
async function readSecret(promptText: string): Promise<string> {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of stdin) {
            chunks.push(Buffer.from(chunk));
            const text = Buffer.concat(chunks).toString("utf8");
            const newline = text.indexOf("\n");
            if (newline >= 0) return text.slice(0, newline).trim();
        }
        return Buffer.concat(chunks).toString("utf8").trim();
    }
    process.stderr.write(promptText);
    return await new Promise<string>((resolve) => {
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let buffer = "";
        const onData = (chunk: string): void => {
            for (const char of chunk) {
                if (char === "\n" || char === "\r" || char === "\u0004") {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.off("data", onData);
                    process.stderr.write("\n");
                    resolve(buffer.trim());
                    return;
                }
                if (char === "\u0003") {
                    stdin.setRawMode(false);
                    process.stderr.write("^C\n");
                    process.exit(130);
                }
                if (char === "\u007f" || char === "\b") {
                    buffer = buffer.slice(0, -1);
                    continue;
                }
                buffer += char;
            }
        };
        stdin.on("data", onData);
    });
}

/**
 * Run the login flow against a booted composition. Returns the process exit
 * code. The key comes from the argument list (`dsh-acp login sk-…`) or an
 * un-echoed interactive prompt.
 */
export async function runLogin(ctx: Context, hostBase: string, argv: string[]): Promise<number> {
    const req = createRequire(join(hostBase, "noop.js"));
    let credentialRef: ((name: string) => unknown) | undefined;
    try {
        const mod = (await import(pathToFileURL(req.resolve("@deepseek-ai/dsh-credentials")).href)) as {
            credentialRef?: (name: string) => unknown;
        };
        credentialRef = mod.credentialRef;
    } catch {
        credentialRef = undefined;
    }
    const store = ctx.get("credentials") as CredentialStore | undefined;
    if (store === undefined || credentialRef === undefined) {
        process.stderr.write(
            "This composition has no writable credential store; export DEEPSEEK_API_KEY instead.\n",
        );
        return 1;
    }
    const ref = credentialRef("DEEPSEEK_API_KEY");
    const before = await store.describe(ref);
    if (before.configured && before.source !== undefined) {
        process.stderr.write(`A key is already configured (source: ${before.source}).\n`);
    }
    const key = argv[0] ?? (await readSecret("DeepSeek API key (input hidden): "));
    if (key.length === 0) {
        process.stderr.write("No key entered; nothing saved.\n");
        return 1;
    }
    await store.set(ref, key);
    const masked = key.length <= 8 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
    process.stderr.write(
        `Saved ${masked} to the harness credential store (~/.dsh/.credentials.yaml, mode 600).\n` +
            "The dsh Web UI and every dsh surface share this credential.\n",
    );
    return 0;
}
