import { describe, expect, it } from "vitest";
import { startLocalAuthPage } from "../src/auth-page.ts";

describe("local Agent Auth page", () => {
    it("accepts a posted API key without echoing it", async () => {
        const page = await startLocalAuthPage({ credentialName: "DEEPSEEK_API_KEY", timeoutMs: 5_000 });
        try {
            const form = await fetch(page.url);
            const html = await form.text();
            expect(html).toContain('name="api-key"');
            expect(html).toContain("DEEPSEEK_API_KEY");

            const submitted = fetch(page.url, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: "api-key=sk-test-abcdef",
            });
            await expect(page.completed).resolves.toBe("sk-test-abcdef");
            const result = await submitted;
            expect(result.status).toBe(200);
            expect(await result.text()).not.toContain("sk-test-abcdef");
        } finally {
            page.close();
        }
    });
});
