import { describe, expect, it } from "vitest";
import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import { Context } from "@deepseek-ai/cordis";
import UserQuestionService, {
    type UserQuestionService as UserQuestionServiceType,
} from "@deepseek-ai/dsh-user-questions";
import type {
    AskUserQuestionAnswer,
    AskUserQuestionItem,
    AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";
import * as bridge from "../src/bridge/index.ts";

type UserQuestionBridge = {
    questionsToElicitation?: (questions: AskUserQuestionItem[], sessionId: string) => CreateElicitationRequest;
    answerFromElicitation?: (
        questions: AskUserQuestionItem[],
        response: CreateElicitationResponse,
    ) => AskUserQuestionAnswer | undefined;
    askUserQuestionsOverAcp?: (
        request: AskUserQuestionRequest,
        sessionId: string,
        create: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>,
    ) => Promise<AskUserQuestionAnswer>;
    installAcpUserQuestionProvider?: (
        service: UserQuestionServiceType,
        options: {
            formSupported: () => boolean;
            sessionIdForRequest: (request: AskUserQuestionRequest) => string | undefined;
            create: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
        },
    ) => () => void;
};

const subject = bridge as UserQuestionBridge;

describe("ACP user-question elicitation", () => {
    it("maps a DSH single-choice question onto a standard ACP form with an Other field", () => {
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
                            { const: "custom_0", title: "Other" },
                        ],
                    },
                    question_0_custom: {
                        type: "string",
                        title: "Other",
                        description: "Type a custom answer.",
                    },
                },
                required: [],
            },
        });
    });

    it("keeps every DSH question skippable in the ACP form", () => {
        const request = subject.questionsToElicitation?.([{
            id: "features",
            question: "Which features?",
            options: [{ label: "Cache" }, { label: "Tracing" }],
            multiSelect: true,
        }], "s1");

        expect(request).toMatchObject({
            mode: "form",
            requestedSchema: {
                required: [],
                properties: {
                    question_0: { type: "array", minItems: 1 },
                },
            },
        });
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
                question_0: ["option_0", "custom_0"],
                question_0_custom: "Metrics",
            },
        });

        expect(answer).toEqual({
            answers: [{ id: "features", selected: ["Cache"], custom: "Metrics" }],
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
});
