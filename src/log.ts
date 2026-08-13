/**
 * Stderr-only logging. Stdout belongs exclusively to the ACP JSON-RPC wire,
 * so every diagnostic goes to stderr; debug output is gated behind
 * `DSH_ACP_DEBUG`.
 */

const PREFIX = "[dsh-acp]";

export function logWarn(message: string): void {
    process.stderr.write(`${PREFIX} warn: ${message}\n`);
}

export function logError(message: string): void {
    process.stderr.write(`${PREFIX} error: ${message}\n`);
}

export function logDebug(message: string): void {
    if (process.env["DSH_ACP_DEBUG"]) process.stderr.write(`${PREFIX} debug: ${message}\n`);
}
