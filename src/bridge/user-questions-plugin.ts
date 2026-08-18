/** Standard ACP form elicitation provider as an ordinary child plugin. */

import type { Context } from "@deepseek-ai/cordis";
import type { UserQuestionService } from "@deepseek-ai/dsh-user-questions";

import {
    installAcpUserQuestionProvider,
    type AcpUserQuestionProviderOptions,
} from "./user-questions.ts";

export const name = "acp-user-questions";
export const inject = ["userQuestions"];

export type Config = AcpUserQuestionProviderOptions;

export function apply(ctx: Context, config: Config): void {
    const service = (ctx as Context & { userQuestions: UserQuestionService }).userQuestions;
    const dispose = installAcpUserQuestionProvider(service, config);
    ctx.effect(() => dispose, "acp-user-questions.provider");
}
