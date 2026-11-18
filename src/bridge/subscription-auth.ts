import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Routes owned by dsh-plugin-subscriptions, not arbitrary API-key providers. */
const ROUTES = new Set(["codex", "claude", "grok", "copilot", "antigravity"]);

/** Check only durable login presence. The provider itself refreshes and validates tokens. */
export async function hasSubscriptionLogin(home: string | undefined, provider: string | undefined): Promise<boolean> {
    if (!home || !provider || !ROUTES.has(provider)) return false;
    try {
        const store: unknown = JSON.parse(await readFile(join(home, "plugins", "subscriptions", "auth.json"), "utf8"));
        if (!store || typeof store !== "object" || Array.isArray(store)) return false;
        const entry = (store as Record<string, unknown>)[provider];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const record = entry as Record<string, unknown>;
        const valid = (value: unknown): boolean => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return false;
            const session = value as Record<string, unknown>;
            return typeof session["accessToken"] === "string" && session["accessToken"].length > 0 &&
                typeof session["refreshToken"] === "string" && session["refreshToken"].length > 0 &&
                typeof session["expiresAt"] === "number" && Number.isFinite(session["expiresAt"]);
        };
        if (valid(record)) return true;
        const accounts = record["accounts"];
        return !!accounts && typeof accounts === "object" && !Array.isArray(accounts) &&
            Object.values(accounts).some(valid);
    } catch {
        // Missing, unreadable or malformed stores fail closed; never log secrets.
        return false;
    }
}
