/**
 * `dsh-acp login` — interactive CLI credential setup.
 *
 * Boots the same composition the server uses and writes the API key through
 * `ctx.credentials` (`dsh-credentials-local` in dsh-base). That provider owns
 * `$DSH_HOME/.credentials.yaml`; this command never writes the file itself.
 * Never echoes the key.
 */

import { parseLoginArgv, primaryCredentialName } from "./auth.ts";
import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

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
export async function runLogin(ctx: Context, argv: string[]): Promise<number> {
    const parsed = parseLoginArgv(argv);
    const name = primaryCredentialName(parsed.provider);
    const credentials = ctx.credentials;
    const ref = credentialRef(name);
    const before = await credentials.describe(ref);
    if (before.configured && before.source !== undefined) {
        process.stderr.write(`A key is already configured for ${name} (source: ${before.source}).\n`);
    }
    const key = parsed.key ?? (await readSecret(`${name} (input hidden): `));
    if (key.length === 0) {
        process.stderr.write("No key entered; nothing saved.\n");
        return 1;
    }
    await credentials.set(ref, key);
    const masked = key.length <= 8 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
    process.stderr.write(
        `Saved ${masked} as ${name} in the harness credential store (~/.dsh/.credentials.yaml, mode 600).\n` +
            "The dsh Web UI and every dsh surface share this credential.\n",
    );
    return 0;
}
