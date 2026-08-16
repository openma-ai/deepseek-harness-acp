import type {
    CreateElicitationRequest,
    CreateElicitationResponse,
    ElicitationContentValue,
    ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import {
    UserQuestionError,
    type AskUserQuestionAnswer,
    type AskUserQuestionItem,
    type AskUserQuestionRequest,
    type UserQuestionService,
} from "@deepseek-ai/dsh-user-questions";

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

export async function askUserQuestionsOverAcp(
    request: AskUserQuestionRequest,
    sessionId: string,
    create: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>,
): Promise<AskUserQuestionAnswer> {
    const response = await create(questionsToElicitation(request.questions, sessionId));
    const answer = answerFromElicitation(request.questions, response);
    if (answer === undefined) {
        throw new UserQuestionError("the user cancelled ask_user_question", "ASK_CANCELLED");
    }
    return answer;
}

export interface AcpUserQuestionProviderOptions {
    formSupported: () => boolean;
    sessionIdForRequest: (request: AskUserQuestionRequest) => string | undefined;
    create: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
}

export function installAcpUserQuestionProvider(
    service: UserQuestionService,
    options: AcpUserQuestionProviderOptions,
): () => void {
    return service.registerProvider({
        async ask(request) {
            if (!options.formSupported()) {
                throw new UserQuestionError(
                    "the ACP client does not support form elicitation",
                    "CLIENT_UNSUPPORTED",
                );
            }
            const sessionId = options.sessionIdForRequest(request);
            if (sessionId === undefined) {
                throw new UserQuestionError(
                    "ACP user interaction requires a live root session",
                    "ASK_MISSING_AGENT",
                );
            }
            return askUserQuestionsOverAcp(request, sessionId, options.create);
        },
    });
}
