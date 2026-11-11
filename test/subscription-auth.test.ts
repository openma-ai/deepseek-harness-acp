import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasSubscriptionLogin } from "../src/bridge/subscription-auth.ts";

describe("subscription credential presence", () => {
    it("fails closed on absent, malformed, unknown and incomplete sessions", async () => {
        const home = await mkdtemp(join(tmpdir(), "acp-subscriptions-"));
        try {
            expect(await hasSubscriptionLogin(home, "codex")).toBe(false);
            const dir = join(home, "plugins", "subscriptions");
            await mkdir(dir, { recursive: true });
            const path = join(dir, "auth.json");
            await writeFile(path, "not json");
            expect(await hasSubscriptionLogin(home, "codex")).toBe(false);
            await writeFile(path, JSON.stringify({ codex: { accounts: { broken: { accessToken: "test" } } } }));
            expect(await hasSubscriptionLogin(home, "codex")).toBe(false);
            expect(await hasSubscriptionLogin(home, "unknown")).toBe(false);
        } finally { await rm(home, { recursive: true, force: true }); }
    });
    it("detects provider-specific modern and legacy sessions without requiring unexpired access tokens", async () => {
        const home = await mkdtemp(join(tmpdir(), "acp-subscriptions-"));
        try {
            const dir = join(home, "plugins", "subscriptions");
            await mkdir(dir, { recursive: true });
            const session = { accessToken: "test-access", refreshToken: "test-refresh", expiresAt: 0 };
            await writeFile(join(dir, "auth.json"), JSON.stringify({ codex: { accounts: { one: session } }, claude: session }));
            expect(await hasSubscriptionLogin(home, "codex")).toBe(true);
            expect(await hasSubscriptionLogin(home, "claude")).toBe(true);
            expect(await hasSubscriptionLogin(home, "grok")).toBe(false);
        } finally { await rm(home, { recursive: true, force: true }); }
    });
});
