import { describe, expect, it } from "vitest";
import { substituteUnavailableModel } from "../src/bridge/model-catalog.ts";

const deepseek = [
    { provider: "deepseek", model: "deepseek-flash" },
    { provider: "deepseek", model: "deepseek-v4-pro" },
];

describe("substituteUnavailableModel", () => {
    it("keeps a model the live catalog still lists", () => {
        expect(substituteUnavailableModel("deepseek", "deepseek-v4-pro", deepseek, true))
            .toEqual({ model: "deepseek-v4-pro", replaced: false });
    });

    it("replaces removed deepseek-v4-flash with deepseek-flash even if the adapter would pass it through", () => {
        const decision = substituteUnavailableModel("deepseek", "deepseek-v4-flash", deepseek, true);
        expect(decision.model).toBe("deepseek-flash");
        expect(decision.replaced).toBe(true);
    });

    it("keeps an unlisted id the adapter can still describe", () => {
        expect(substituteUnavailableModel("deepseek-official", "custom-future", deepseek, true))
            .toEqual({ model: "custom-future", replaced: false });
    });

    it("falls back to the provider's first live model when the id is refused", () => {
        const decision = substituteUnavailableModel("deepseek", "kimi-k2", deepseek, false);
        expect(decision.model).toBe("deepseek-flash");
        expect(decision.replaced).toBe(true);
    });
});
