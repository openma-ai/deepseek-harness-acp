import { describe, expect, it } from "vitest";

import {
    interactionModeFromClientMeta,
    withInteractionMode,
} from "../src/bridge/interaction-mode.ts";

describe("ACP client interaction mode", () => {
    it("carries only an explicit client mode into Agent options", () => {
        expect(interactionModeFromClientMeta({
            dsh: { interaction: { mode: "rpc" } },
        })).toBe("rpc");
        expect(interactionModeFromClientMeta({
            dsh: { interaction: { mode: "interactive" } },
        })).toBe("interactive");
        expect(interactionModeFromClientMeta({})).toBeUndefined();
        expect(interactionModeFromClientMeta({
            dsh: { interaction: { mode: "headless" } },
        })).toBeUndefined();

        expect(withInteractionMode({ model: "fixture" }, "rpc")).toEqual({
            model: "fixture",
            interactionMode: "rpc",
        });
        expect(withInteractionMode({ model: "fixture" }, undefined)).toEqual({
            model: "fixture",
        });
    });
});
