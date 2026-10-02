import { routeLegacyQuestions } from "./legacy-user-questions.ts";
import type {
    CreateElicitationRequest,
    CreateElicitationResponse,
    ElicitationContentValue,
    ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import { Service, type Context } from "@deepseek-ai/cordis";
import {
    UserQuestionError,
    type AskUserQuestionAnswer,
    type AskUserQuestionItem,
    type AskUserQuestionRequest,
    type UserQuestionService,
} from "@deepseek-ai/dsh-user-questions";

import { logDebug, logWarn } from "../log.ts";

const META_KEY = "dsh.userQuestions";

function fieldName(index: number): string {
    return `question_${index}`;
}

function customFieldName(index: number): string {
    return `${fieldName(index)}_custom`;
}

function optionValue(index: number): string {
    return `option_${index}`;
}

function customValue(index: number): string {
    return `custom_${index}`;
}

function descriptionOf(question: AskUserQuestionItem): string | undefined {
    const parts = [question.header === undefined ? undefined : question.question, question.detail]
        .filter((part): part is string => part !== undefined && part.length > 0);
    return parts.length === 0 ? undefined : parts.join("\n\n");
}

function propertyOf(question: AskUserQuestionItem, index: number): ElicitationPropertySchema {
    const title = question.header ?? question.question;
    const description = descriptionOf(question);
    const options = question.options ?? [];
    if (options.length === 0) {
        return {
            type: "string",
            title,
            ...(description === undefined ? {} : { description }),
        };
    }
    const choices = [
        ...options.map((option, optionIndex) => ({
            const: optionValue(optionIndex),
            title: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
        })),
        { const: customValue(index), title: "Other" },
    ];
    if (question.multiSelect === true) {
        return {
            type: "array",
            title,
            ...(description === undefined ? {} : { description }),
            minItems: 1,
            items: { anyOf: choices },
        };
    }
    return {
        type: "string",
        title,
        ...(description === undefined ? {} : { description }),
        oneOf: choices,
    };
}

export function questionsToElicitation(
    questions: AskUserQuestionItem[],
    sessionId: string,
): CreateElicitationRequest {
    const properties: Record<string, ElicitationPropertySchema> = {};
    const required: string[] = [];
    questions.forEach((question, index) => {
        const field = fieldName(index);
        properties[field] = propertyOf(question, index);
        if ((question.options?.length ?? 0) > 0) {
            properties[customFieldName(index)] = {
                type: "string",
                title: "Other",
                description: "Type a custom answer.",
            };
        }
    });
    return {
        mode: "form",
        sessionId,
        message: "The agent needs your input.",
        requestedSchema: {
            type: "object",
            properties,
            required,
        },
        _meta: {
            [META_KEY]: {
                version: 1,
                questions,
            },
        },
    };
}

export function answerFromElicitation(
    questions: AskUserQuestionItem[],
    response: CreateElicitationResponse,
): AskUserQuestionAnswer | undefined {
    if (response.action !== "accept") return undefined;
    const content = (response.content ?? {}) as Record<string, ElicitationContentValue>;
    return {
        answers: questions.map((question, index) => {
            const options = question.options ?? [];
            const raw = content[fieldName(index)];
            if (options.length === 0) {
                const custom = typeof raw === "string" ? raw.trim() : "";
                return {
                    id: question.id,
                    selected: [],
                    ...(custom.length === 0 ? {} : { custom }),
                };
            }
            const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
            const selected = values.flatMap((value) => {
                const match = /^option_(\d+)$/.exec(value);
                if (match === null) return [];
                const option = options[Number(match[1])];
                return option === undefined ? [] : [option.label];
            });
            const customRaw = content[customFieldName(index)];
            const custom = typeof customRaw === "string" ? customRaw.trim() : "";
            return {
                id: question.id,
                selected: custom.length > 0 && question.multiSelect !== true ? [] : selected,
                ...(custom.length === 0 ? {} : { custom }),
            };
        }),
    };
}

function abortedQuestionError(signal: AbortSignal): UserQuestionError {
    const reason = signal.reason;
    if (reason instanceof UserQuestionError) return reason;
    const message = reason instanceof Error ? reason.message : "ask_user_question was aborted";
    return new UserQuestionError(message, "ASK_ABORTED");
}

/**
 * Ask over ACP form elicitation.
 *
 * Timed questions (`askTimed`) abort `request.signal` when the foreground
 * wait ends. The elicitation RPC itself cannot be withdrawn, so a timeout
 * rejects this promise immediately and a later accept is reported through
 * `onLateAnswer` for the continued-question path.
 */
export async function askUserQuestionsOverAcp(
    request: AskUserQuestionRequest,
    sessionId: string,
    create: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>,
    onLateAnswer?: (answer: AskUserQuestionAnswer) => void,
): Promise<AskUserQuestionAnswer> {
    const signal = request.signal;
    if (signal?.aborted) throw abortedQuestionError(signal);
    const responsePromise = create(questionsToElicitation(request.questions, sessionId));
    if (signal === undefined) return answerOrCancel(request.questions, await responsePromise);

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortedQuestionError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([
            responsePromise.then((response) => answerOrCancel(request.questions, response)),
            aborted,
        ]);
    } catch (error) {
        if (signal.aborted && onLateAnswer !== undefined) {
            void responsePromise.then((response) => {
                const answer = answerFromElicitation(request.questions, response);
                if (answer !== undefined) onLateAnswer(answer);
            }, () => undefined);
        }
        throw error;
    } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
}

function answerOrCancel(
    questions: AskUserQuestionItem[],
    response: CreateElicitationResponse,
): AskUserQuestionAnswer {
    const answer = answerFromElicitation(questions, response);
    if (answer === undefined) {
        throw new UserQuestionError("the user cancelled ask_user_question", "ASK_CANCELLED");
    }
    return answer;
}

export function createElicitation(
    connection: {
        createElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
    },
    request: CreateElicitationRequest,
): Promise<CreateElicitationResponse> {
    return connection.createElicitation(request);
}

export interface AcpUserQuestionProviderOptions {
    formSupported: () => boolean;
    sessionIdForRequest: (request: AskUserQuestionRequest) => string | undefined;
    create: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
}

interface AcpUserQuestionRouter {
    routes: AcpUserQuestionProviderOptions[];
    disposeProvider: () => void;
}

const ROUTERS_KEY = Symbol.for("@openma/deepseek-harness-acp/user-question-routers");
const routers = ((globalThis as Record<PropertyKey, unknown>)[ROUTERS_KEY] ??=
    new WeakMap<object, AcpUserQuestionRouter>()) as WeakMap<object, AcpUserQuestionRouter>;

export function installAcpUserQuestionProvider(
    service: UserQuestionService,
    options: AcpUserQuestionProviderOptions,
): () => void {
    const tracked = (service as unknown as Record<PropertyKey, unknown>)[Service.tracker];
    const owner = typeof tracked === "object" && tracked !== null ? tracked : service;
    let router = routers.get(owner);
    if (router === undefined) {
        const routes: AcpUserQuestionProviderOptions[] = [];
        const ask = async (request: AskUserQuestionRequest, next?: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer> => {
            for (let index = routes.length - 1; index >= 0; index -= 1) {
                const route = routes[index];
                const sessionId = route?.sessionIdForRequest(request);
                if (route === undefined || sessionId === undefined) continue;
                if (!route.formSupported()) {
                    // A timed ask with no form UI is unclaimed. askTimed waits
                    // out NO_PROVIDER and returns pending; failing immediately
                    // would skip that deadline.
                    if (request.wait?.timed === true) {
                        throw new UserQuestionError(
                            "the ACP client does not support form elicitation",
                            "NO_PROVIDER",
                        );
                    }
                    throw new UserQuestionError(
                        "the ACP client does not support form elicitation",
                        "CLIENT_UNSUPPORTED",
                    );
                }
                return askUserQuestionsOverAcp(request, sessionId, route.create, (answer) => {
                    const agent = request.agent;
                    const callId = request.wait?.callId;
                    if (agent === undefined || callId === undefined) return;
                    try {
                        if (!service.answer(agent, callId, answer)) {
                            logDebug("late user-question answer arrived after the question closed");
                        }
                    } catch (error: unknown) {
                        logWarn(`late user-question answer failed: ${String(error)}`);
                    }
                });
            }
            if (next !== undefined) return next();
            throw new UserQuestionError(
                "ACP user interaction requires a live root session",
                "ASK_MISSING_AGENT",
            );
        };
        const legacy = service as unknown as {
            registerProvider?: (provider: { ask: typeof ask }) => () => void;
        };
        const disposeProvider = typeof legacy.registerProvider === "function"
            ? routeLegacyQuestions(service, ask) ?? legacy.registerProvider({ ask })
            : (service as unknown as { ctx: Context }).ctx.root.on("user-questions/request", ask, { prepend: true });
        router = { routes, disposeProvider };
        routers.set(owner, router);
    }

    router.routes.push(options);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        const index = router.routes.indexOf(options);
        if (index >= 0) router.routes.splice(index, 1);
        if (router.routes.length !== 0) return;
        routers.delete(owner);
        router.disposeProvider();
    };
}
