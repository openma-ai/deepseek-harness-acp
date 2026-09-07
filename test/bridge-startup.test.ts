import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import * as bridge from "../src/bridge/index.ts";

describe("ACP bridge startup", () => {
    it("leaves the transport untouched when question-provider setup fails", async () => {
        const ctx = new Context();
        // Simulate a question backend rejecting registration during startup.
        // All other services are idle: no ACP request should reach them.
        for (const name of bridge.inject) ctx.provide(name, {});
        ctx.set("userQuestions", {
            registerProvider() {
                throw new UserQuestionError("a user-questions provider is already registered", "DUPLICATE_PROVIDER");
            },
        });
        const errors = vi.spyOn(ctx.logger, "error").mockImplementation(() => {});
        const input = new TransformStream();
        const output = new TransformStream();
        const fiber = ctx.plugin(bridge, {
            stream: { readable: input.readable, writable: output.writable },
            harness: {} as bridge.BridgeHarness,
        });
        try {
            await expect(Promise.resolve(fiber)).rejects.toMatchObject({ code: "DUPLICATE_PROVIDER" });
            // Starting the SDK prematurely locks these streams even after
            // Cordis rolls back the failed plugin and removes its listeners.
            expect(input.readable.locked).toBe(false);
            expect(output.writable.locked).toBe(false);
        } finally {
            await ctx.fiber.dispose();
            errors.mockRestore();
        }
    });
});
