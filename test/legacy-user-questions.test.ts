import { describe, expect, it } from "vitest";
import { Context, Service } from "@deepseek-ai/cordis";
import { UserQuestionError, type AskUserQuestionRequest, type AskUserQuestionAnswer } from "@deepseek-ai/dsh-user-questions";
import { installAcpUserQuestionProvider } from "../src/bridge/user-questions.ts";

type Provider = { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> };
// The released 0.1.1 service contract, including validation before dispatch.
class LegacyQuestions extends Service {
    provider: Provider | undefined;
    constructor(ctx: Context) { super(ctx, "userQuestions"); }
    registerProvider(provider: Provider) {
        if (this.provider) throw new UserQuestionError("provider exists", "DUPLICATE_PROVIDER");
        this.provider = provider;
        return () => { this.provider = undefined; };
    }
    async ask(request: AskUserQuestionRequest) {
        if (request.signal?.aborted) throw new UserQuestionError("aborted", "ASK_ABORTED");
        if (!request.questions.length) throw new UserQuestionError("empty", "EMPTY_QUESTIONS");
        if (!this.provider) throw new UserQuestionError("missing", "NO_PROVIDER");
        return this.provider.ask(request);
    }
}
const answer = (custom: string) => ({ answers: [{ id: "q", selected: [], custom }] });
const request = (id: string): AskUserQuestionRequest => ({ questions: [{ id, question: "Question?" }] });

describe("legacy Web and ACP question coexistence", () => {
    it("routes two ACP connections independently while retaining Web registration and reload", async () => {
        const ctx = new Context();
        await ctx.plugin(LegacyQuestions);
        const service = ctx.userQuestions as unknown as LegacyQuestions;
        let stopWeb = service.registerProvider({ ask: async () => answer("web") });
        const stops: Array<() => void> = [];
        try {
            for (const id of ["a", "b"]) stops.push(installAcpUserQuestionProvider(service as never, {
                formSupported: () => true,
                sessionIdForRequest: r => r.questions[0]?.id === id ? id : undefined,
                create: async () => ({ action: "accept", content: { question_0: id } }),
            }));
            expect(await service.ask(request("a"))).toEqual({ answers: [{ id: "a", selected: [], custom: "a" }] });
            expect(await service.ask(request("b"))).toEqual({ answers: [{ id: "b", selected: [], custom: "b" }] });
            expect(await service.ask(request("web"))).toEqual(answer("web"));
            stops[0]!();
            expect(await service.ask(request("b"))).toEqual({ answers: [{ id: "b", selected: [], custom: "b" }] });
            stopWeb();
            await expect(service.ask(request("web"))).rejects.toMatchObject({ code: "NO_PROVIDER" });
            expect(await service.ask(request("b"))).toEqual({ answers: [{ id: "b", selected: [], custom: "b" }] });
            stopWeb = service.registerProvider({ ask: async () => answer("reloaded-web") });
            expect(await service.ask(request("web"))).toEqual(answer("reloaded-web"));
            stops[1]!();
            expect(await service.ask(request("b"))).toEqual(answer("reloaded-web"));
        } finally {
            stops.forEach(stop => stop()); stopWeb(); await ctx.fiber.dispose();
        }
    });
    it("keeps host validation before ACP routing, even without a Web provider", async () => {
        const ctx = new Context(); await ctx.plugin(LegacyQuestions);
        const stop = installAcpUserQuestionProvider(ctx.userQuestions, {
            formSupported: () => true, sessionIdForRequest: () => "acp",
            create: async () => ({ action: "accept", content: { question_0: "yes" } }),
        });
        try {
            await expect(ctx.userQuestions.ask({ questions: [] })).rejects.toMatchObject({ code: "EMPTY_QUESTIONS" });
            await expect(ctx.userQuestions.ask({ ...request("q"), signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ASK_ABORTED" });
        } finally { stop(); await ctx.fiber.dispose(); }
    });
});
