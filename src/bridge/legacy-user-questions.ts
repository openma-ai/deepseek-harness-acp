import { symbols } from "@deepseek-ai/cordis";
import { UserQuestionError, type AskUserQuestionRequest, type AskUserQuestionAnswer } from "@deepseek-ai/dsh-user-questions";

type Ask = (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>;
type Route = (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>;
interface LegacyService {
    ask: Ask;
    provider?: { ask: Ask };
}

/**
 * 0.1.1's singleton provider predates the user-questions/request middleware.
 * Keep its ask() validation and provider lifecycle intact: only the receiver
 * of this invocation sees a routed provider. No shared provider is replaced,
 * so Web can unregister/re-register while ACP connections remain active.
 * The private `provider` layout is confined to this legacy capability shim.
 */
export function routeLegacyQuestions(service: object, route: Route): (() => void) | undefined {
    const target = ((service as Record<PropertyKey, unknown>)[symbols.original] ?? service) as LegacyService;
    if (!("provider" in target) || typeof target.ask !== "function") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(target, "ask");
    const originalAsk = target.ask;
    const routedAsk: Ask = function (this: LegacyService, request) {
        const receiver = this;
        const provider = {
            ask: (question: AskUserQuestionRequest) => route(question, () => {
                const fallback = receiver.provider;
                if (fallback === undefined) {
                    throw new UserQuestionError("no user-questions provider is registered", "NO_PROVIDER");
                }
                return fallback.ask(question);
            }),
        };
        return originalAsk.call(new Proxy(receiver, {
            get(object, property, proxy) {
                return property === "provider" ? provider : Reflect.get(object, property, proxy);
            },
        }), request);
    };
    Object.defineProperty(target, "ask", { configurable: true, writable: true, value: routedAsk });
    return () => {
        if (target.ask !== routedAsk) return;
        if (descriptor === undefined) delete (target as Partial<LegacyService>).ask;
        else Object.defineProperty(target, "ask", descriptor);
    };
}
