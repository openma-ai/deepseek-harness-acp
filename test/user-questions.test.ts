import { describe, expect, it } from "vitest";
import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk/unstable";
import { Context } from "@deepseek-ai/cordis";
import UserQuestionService, {
    UserQuestionError,
    type UserQuestionService as UserQuestionServiceType,
} from "@deepseek-ai/dsh-user-questions";
import type {
    AskUserQuestionAnswer,
    AskUserQuestionItem,
    AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";
import * as bridge from "../src/bridge/index.ts";

type CreateElicitation = (
    request: CreateElicitationRequest,
    options?: { signal?: AbortSignal },
) => Promise<CreateElicitationResponse>;

type UserQuestionBridge = {
    questionsToElicitation?: (
        questions: AskUserQuestionItem[],
        sessionId: string,
        wait?: AskUserQuestionRequest["wait"],
    ) => CreateElicitationRequest;
    answerFromElicitation?: (
        questions: AskUserQuestionItem[],
        response: CreateElicitationResponse,
    ) => AskUserQuestionAnswer | undefined;
    askUserQuestionsOverAcp?: (
        request: AskUserQuestionRequest,
        sessionId: string,
        create: CreateElicitation,
        onLateAnswer?: (answer: AskUserQuestionAnswer) => void,
    ) => Promise<AskUserQuestionAnswer>;
    createElicitation?: (
        connection: {
            createElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
        },
        request: CreateElicitationRequest,
    ) => Promise<CreateElicitationResponse>;
    installAcpUserQuestionProvider?: (
        service: UserQuestionServiceType,
        options: {
            formSupported: () => boolean;
            sessionIdForRequest: (request: AskUserQuestionRequest) => string | undefined;
            create: CreateElicitation;
        },
    ) => () => void;
};

const subject = bridge as UserQuestionBridge;

describe("ACP user-question elicitation", () => {
    it("maps a DSH single-choice question onto a standard ACP form with an __other field", () => {
        const questions: AskUserQuestionItem[] = [{
            id: "target",
            header: "Target",
            question: "Where should this run?",
            detail: "Choose the deployment target.",
            options: [
                { label: "Local", description: "Run on this machine." },
                { label: "Remote", description: "Run in the cluster." },
            ],
        }];

        const request = subject.questionsToElicitation?.(questions, "s1");

        expect(request).toMatchObject({
            mode: "form",
            sessionId: "s1",
            message: "Where should this run?",
            requestedSchema: {
                type: "object",
                properties: {
                    question_0: {
                        type: "string",
                        title: "Target",
                        description: "Where should this run?\n\nChoose the deployment target.",
                        oneOf: [
                            { const: "option_0", title: "Local", description: "Run on this machine." },
                            { const: "option_1", title: "Remote", description: "Run in the cluster." },
                        ],
                    },
                    question_0__other: {
                        type: "string",
                        title: "Other",
                        description: "Type a custom answer.",
                    },
                },
                required: [],
            },
        });
        expect(request?._meta?.["dsh.userQuestions"]).toMatchObject({
            version: 1,
            questions,
        });
    });

    it("keeps every DSH question skippable in the ACP form", () => {
        const request = subject.questionsToElicitation?.([{
            id: "features",
            question: "Which features?",
            options: [{ label: "Cache" }, { label: "Tracing" }],
            multiSelect: true,
        }], "s1");

        // No minItems: an empty selection is the skipped answer, which clients
        // must be able to submit for a skippable question.
        expect(request).toMatchObject({
            mode: "form",
            requestedSchema: {
                required: [],
                properties: {
                    question_0: { type: "array" },
                },
            },
        });
        const schema = (request?.mode === "form" ? request.requestedSchema : undefined) as
            { properties?: Record<string, unknown> } | undefined;
        expect(schema?.properties?.["question_0"]).not.toHaveProperty("minItems");
    });

    it("restores multi-select labels and custom text from accepted form content", () => {
        const questions: AskUserQuestionItem[] = [{
            id: "features",
            question: "Which features?",
            options: [{ label: "Cache" }, { label: "Tracing" }],
            multiSelect: true,
        }];

        const answer = subject.answerFromElicitation?.(questions, {
            action: "accept",
            content: {
                question_0: ["option_0"],
                question_0__other: "Metrics",
            },
        });

        expect(answer).toEqual({
            answers: [{ id: "features", selected: ["Cache"], custom: "Metrics" }],
        });
    });

    it("decodes literal option labels clients send for declared choices", () => {
        const questions: AskUserQuestionItem[] = [{
            id: "target",
            question: "Where should this run?",
            options: [{ label: "Local" }, { label: "Remote" }],
        }];

        // A generic form client may submit the displayed label rather than the
        // option_N const.
        const answer = subject.answerFromElicitation?.(questions, {
            action: "accept",
            content: { question_0: "Remote" },
        });

        expect(answer).toEqual({
            answers: [{ id: "target", selected: ["Remote"] }],
        });
    });

    it("decodes answers keyed by question id for meta-aware clients", () => {
        const questions: AskUserQuestionItem[] = [{
            id: "target",
            question: "Where should this run?",
            options: [{ label: "Local" }, { label: "Remote" }],
        }];

        const answer = subject.answerFromElicitation?.(questions, {
            action: "accept",
            content: {
                target: "Remote",
                "target__other": "Colo",
            },
        });

        expect(answer).toEqual({
            answers: [{ id: "target", selected: [], custom: "Colo" }],
        });
    });

    it("carries the dsh call id onto the elicitation toolCallId and meta for timed asks", () => {
        const request = subject.questionsToElicitation?.(
            [{ id: "confirm", question: "Continue?" }],
            "s1",
            { callId: "call-9" as never, timed: true },
        );

        expect(request).toMatchObject({
            toolCallId: "call-9",
            _meta: {
                "dsh.userQuestions": {
                    version: 1,
                    callId: "call-9",
                    timed: true,
                },
            },
        });
    });

    it("treats a free-text form value as the question's custom answer", () => {
        const questions: AskUserQuestionItem[] = [{ id: "name", question: "Name it" }];

        const answer = subject.answerFromElicitation?.(questions, {
            action: "accept",
            content: { question_0: "release-candidate" },
        });

        expect(answer).toEqual({
            answers: [{ id: "name", selected: [], custom: "release-candidate" }],
        });
    });

    it("waits for the ACP client's elicitation response and returns it to the tool", async () => {
        const sent: CreateElicitationRequest[] = [];
        const request: AskUserQuestionRequest = {
            questions: [{
                id: "target",
                question: "Where should this run?",
                options: [{ label: "Local" }, { label: "Remote" }],
            }],
        };

        const answer = await subject.askUserQuestionsOverAcp?.(request, "s1", async (elicitation) => {
            sent.push(elicitation);
            return { action: "accept", content: { question_0: "option_1" } };
        });

        expect(answer).toEqual({ answers: [{ id: "target", selected: ["Remote"] }] });
        expect(sent).toMatchObject([{ mode: "form", sessionId: "s1" }]);
    });

    it("uses the stable AgentSideConnection createElicitation method", async () => {
        const sent: CreateElicitationRequest[] = [];
        const request = subject.questionsToElicitation?.(
            [{ id: "confirm", question: "Continue?" }],
            "s1",
        );
        expect(request).toBeDefined();

        const response = await subject.createElicitation?.({
            async createElicitation(elicitation) {
                sent.push(elicitation);
                return { action: "accept", content: { question_0: "yes" } };
            },
        }, request!);

        expect(response).toEqual({ action: "accept", content: { question_0: "yes" } });
        expect(sent).toEqual([request]);
    });

    it("rejects a timed elicitation when the wait signal aborts, keeps the ask open, and delivers a late accept", async () => {
        const controller = new AbortController();
        const timeout = new UserQuestionError("ask_user_question timed out before the user answered", "ASK_TIMED_OUT");
        let finish: ((response: CreateElicitationResponse) => void) | undefined;
        let cancelSignal: AbortSignal | undefined;
        const late: AskUserQuestionAnswer[] = [];
        const pending = subject.askUserQuestionsOverAcp?.(
            {
                questions: [{ id: "confirm", question: "Continue?" }],
                wait: { callId: "call-1" as never, timed: true },
                signal: controller.signal,
            },
            "s1",
            (_request, options) => {
                cancelSignal = options?.signal;
                return new Promise((resolve) => { finish = resolve; });
            },
            (answer) => { late.push(answer); },
        );
        controller.abort(timeout);
        await expect(pending).rejects.toMatchObject({ code: "ASK_TIMED_OUT" });
        // A timed-out question is continued, not cancelled: the client must not
        // receive $/cancel_request, so the late accept still has an open RPC to
        // settle.
        expect(cancelSignal?.aborted).not.toBe(true);
        finish?.({ action: "accept", content: { question_0: "yes" } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(late).toEqual([{ answers: [{ id: "confirm", selected: [], custom: "yes" }] }]);
    });

    it("cancels the elicitation through $/cancel_request when the question ends", async () => {
        const controller = new AbortController();
        let cancelSignal: AbortSignal | undefined;
        const pending = subject.askUserQuestionsOverAcp?.(
            {
                questions: [{ id: "confirm", question: "Continue?" }],
                signal: controller.signal,
            },
            "s1",
            (_request, options) => {
                cancelSignal = options?.signal;
                return new Promise<CreateElicitationResponse>(() => undefined);
            },
        );
        controller.abort(new Error("session closed"));
        await expect(pending).rejects.toMatchObject({ code: "ASK_ABORTED" });
        expect(cancelSignal?.aborted).toBe(true);
    });

    it("turns a cancelled elicitation into the user-question cancellation error", async () => {
        const promise = subject.askUserQuestionsOverAcp?.(
            { questions: [{ id: "confirm", question: "Continue?" }] },
            "s1",
            async () => ({ action: "cancel" }),
        );

        await expect(promise).rejects.toMatchObject({
            name: "UserQuestionError",
            code: "ASK_CANCELLED",
        });
    });

    it("routes owned questions before an existing Web handler and delegates other questions", async () => {
        const ctx = new Context();
        await ctx.plugin(UserQuestionService);
        ctx.on("user-questions/request", async () => ({ answers: [{ id: "web", selected: [], custom: "web" }] }));
        const dispose = subject.installAcpUserQuestionProvider!(ctx.userQuestions, {
            formSupported: () => true,
            sessionIdForRequest: request => request.questions[0]?.id === "acp" ? "session" : undefined,
            create: async () => ({ action: "accept", content: { question_0: "acp" } }),
        });
        try {
            await expect(ctx.userQuestions.ask({ questions: [{ id: "acp", question: "Where?" }] }))
                .resolves.toEqual({ answers: [{ id: "acp", selected: [], custom: "acp" }] });
            await expect(ctx.userQuestions.ask({ questions: [{ id: "web", question: "Where?" }] }))
                .resolves.toEqual({ answers: [{ id: "web", selected: [], custom: "web" }] });
        } finally { dispose(); await ctx.fiber.dispose(); }
    });

    it("leaves a timed question unclaimed when the client has no form elicitation", async () => {
        const ctx = new Context();
        const fiber = ctx.plugin(UserQuestionService);
        await fiber;
        const dispose = subject.installAcpUserQuestionProvider?.(ctx.userQuestions, {
            formSupported: () => false,
            sessionIdForRequest: () => "s1",
            create: async () => ({ action: "accept", content: {} }),
        });
        try {
            await expect(ctx.userQuestions.ask({
                questions: [{ id: "confirm", question: "Continue?" }],
                wait: { callId: "call-1" as never, timed: true },
            })).rejects.toMatchObject({ code: "NO_PROVIDER" });
            await expect(ctx.userQuestions.ask({
                questions: [{ id: "confirm", question: "Continue?" }],
            })).rejects.toMatchObject({ code: "CLIENT_UNSUPPORTED" });
        } finally {
            dispose?.();
            await fiber.dispose();
        }
    });

    it("registers the ACP client as the active user-questions provider", async () => {
        const ctx = new Context();
        const fiber = ctx.plugin(UserQuestionService);
        await fiber;
        const dispose = subject.installAcpUserQuestionProvider?.(ctx.userQuestions, {
            formSupported: () => true,
            sessionIdForRequest: () => "s1",
            create: async () => ({ action: "accept", content: { question_0: "yes" } }),
        });

        try {
            await expect(ctx.userQuestions.ask({
                questions: [{ id: "confirm", question: "Continue?" }],
            })).resolves.toEqual({
                answers: [{ id: "confirm", selected: [], custom: "yes" }],
            });
        } finally {
            dispose?.();
            await fiber.dispose();
        }
    });

    it("multiplexes concurrent ACP connections through the single user-questions provider", async () => {
        const ctx = new Context();
        const fiber = ctx.plugin(UserQuestionService);
        await fiber;
        let firstService: UserQuestionServiceType | undefined;
        let secondService: UserQuestionServiceType | undefined;
        const firstFiber = ctx.plugin({
            name: "first-acp-connection",
            inject: ["userQuestions"],
            apply(child) {
                firstService = child.userQuestions;
            },
        });
        const secondFiber = ctx.plugin({
            name: "second-acp-connection",
            inject: ["userQuestions"],
            apply(child) {
                secondService = child.userQuestions;
            },
        });
        await Promise.all([firstFiber, secondFiber]);
        const first = subject.installAcpUserQuestionProvider?.(firstService!, {
            formSupported: () => true,
            sessionIdForRequest: (request) => request.questions[0]?.id === "first" ? "s-first" : undefined,
            create: async () => ({ action: "accept", content: { question_0: "from-first" } }),
        });
        const second = subject.installAcpUserQuestionProvider?.(secondService!, {
            formSupported: () => true,
            sessionIdForRequest: (request) => request.questions[0]?.id === "second" ? "s-second" : undefined,
            create: async () => ({ action: "accept", content: { question_0: "from-second" } }),
        });

        try {
            await expect(ctx.userQuestions.ask({
                questions: [{ id: "first", question: "First connection?" }],
            })).resolves.toEqual({
                answers: [{ id: "first", selected: [], custom: "from-first" }],
            });
            await expect(ctx.userQuestions.ask({
                questions: [{ id: "second", question: "Second connection?" }],
            })).resolves.toEqual({
                answers: [{ id: "second", selected: [], custom: "from-second" }],
            });

            first?.();
            await expect(ctx.userQuestions.ask({
                questions: [{ id: "second", question: "Still connected?" }],
            })).resolves.toEqual({
                answers: [{ id: "second", selected: [], custom: "from-second" }],
            });
        } finally {
            first?.();
            second?.();
            await Promise.all([firstFiber.dispose(), secondFiber.dispose()]);
            await fiber.dispose();
        }
    });
});
