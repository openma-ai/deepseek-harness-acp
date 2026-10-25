import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { AuthLoginCancelled, runBrowserLogin } from "../src/bridge/auth-flow.ts";
import type { LocalAuthPage } from "../src/auth-page.ts";

function pageStub(): LocalAuthPage & { close: ReturnType<typeof vi.fn> } {
    return {
        url: "http://127.0.0.1:9999/",
        close: vi.fn<() => void>(),
        completed: Promise.resolve("sk-from-page"),
    };
}

function deps(overrides: Record<string, unknown> = {}) {
    return {
        createElicitation: vi.fn(async () => ({ action: "accept" }) as never),
        completeElicitation: vi.fn(async () => {}),
        startPage: vi.fn(async () => pageStub()),
        openPage: vi.fn(),
        saveCredential: vi.fn(async () => {}),
        requestId: 42,
        provider: "deepseek-official",
        elicitationId: "dsh-acp-auth-1",
        logDebug: vi.fn(),
        ...overrides,
    };
}

describe("runBrowserLogin", () => {
    it("rejects when the authenticate request id was not tracked", async () => {
        await expect(
            runBrowserLogin(deps({ requestId: undefined }), "DEEPSEEK_API_KEY"),
        ).rejects.toThrow("authenticate request id");
    });

    it("elicites the page URL request-scoped, saves the submitted key, and completes the elicitation", async () => {
        const page = pageStub();
        const d = deps({ startPage: vi.fn(async () => page) });
        await runBrowserLogin(d, "DEEPSEEK_API_KEY");
        expect(d.createElicitation).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: "url",
                requestId: 42,
                elicitationId: "dsh-acp-auth-1",
                url: "http://127.0.0.1:9999/",
                _meta: {
                    dsh: { auth: { credential: "DEEPSEEK_API_KEY", provider: "deepseek-official" } },
                },
            }),
        );
        expect(d.openPage).toHaveBeenCalledWith("http://127.0.0.1:9999/");
        expect(d.saveCredential).toHaveBeenCalledWith("sk-from-page");
        expect(page.close).toHaveBeenCalled();
        expect(d.completeElicitation).toHaveBeenCalledWith({ elicitationId: "dsh-acp-auth-1" });
    });

    it("omits provider from the elicitation meta for the default route", async () => {
        const d = deps({ provider: undefined });
        await runBrowserLogin(d, "DEEPSEEK_API_KEY");
        expect(d.createElicitation).toHaveBeenCalledWith(
            expect.objectContaining({
                _meta: { dsh: { auth: { credential: "DEEPSEEK_API_KEY" } } },
            }),
        );
    });

    it("keeps the elicitation flow alive when the local opener throws", async () => {
        const d = deps({
            openPage: vi.fn(() => {
                throw new Error("no xdg-open");
            }),
        });
        await runBrowserLogin(d, "DEEPSEEK_API_KEY");
        expect(d.saveCredential).toHaveBeenCalledWith("sk-from-page");
        expect(d.logDebug).toHaveBeenCalledWith(expect.stringContaining("no xdg-open"));
    });

    it.each(["decline", "cancel"])("maps an elicitation %s to a cancellation", async (action) => {
        const page = pageStub();
        const d = deps({
            startPage: vi.fn(async () => page),
            createElicitation: vi.fn(async () => ({ action })),
        });
        await expect(runBrowserLogin(d, "DEEPSEEK_API_KEY")).rejects.toBeInstanceOf(
            AuthLoginCancelled,
        );
        expect(d.saveCredential).not.toHaveBeenCalled();
        expect(page.close).toHaveBeenCalled();
        expect(d.completeElicitation).toHaveBeenCalled();
    });

    it("propagates an elicitation RPC failure without saving", async () => {
        const d = deps({
            createElicitation: vi.fn(async () => {
                throw RequestError.methodNotFound("elicitation/create");
            }),
        });
        await expect(runBrowserLogin(d, "DEEPSEEK_API_KEY")).rejects.toMatchObject({
            code: -32601,
        });
        expect(d.saveCredential).not.toHaveBeenCalled();
    });

    it("propagates a page failure (e.g. its bounded timeout)", async () => {
        const page = pageStub();
        page.completed = Promise.reject(new Error("local auth page timed out"));
        const d = deps({ startPage: vi.fn(async () => page) });
        await expect(runBrowserLogin(d, "DEEPSEEK_API_KEY")).rejects.toThrow(
            "local auth page timed out",
        );
        expect(d.saveCredential).not.toHaveBeenCalled();
        expect(page.close).toHaveBeenCalled();
    });

    it("propagates a page bind failure", async () => {
        const d = deps({
            startPage: vi.fn(async () => {
                throw new Error("local auth page failed to bind");
            }),
        });
        await expect(runBrowserLogin(d, "DEEPSEEK_API_KEY")).rejects.toThrow(
            "local auth page failed to bind",
        );
        expect(d.openPage).not.toHaveBeenCalled();
    });

    it("still closes the page when elicitation completion itself fails", async () => {
        const page = pageStub();
        const d = deps({
            startPage: vi.fn(async () => page),
            completeElicitation: vi.fn(async () => {
                throw new Error("client gone");
            }),
        });
        await runBrowserLogin(d, "DEEPSEEK_API_KEY");
        expect(d.logDebug).toHaveBeenCalledWith(
            expect.stringContaining("elicitation/complete failed"),
        );
        expect(d.saveCredential).toHaveBeenCalled();
    });
});
