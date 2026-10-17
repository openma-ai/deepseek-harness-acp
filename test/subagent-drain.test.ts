import { describe, expect, it, vi } from "vitest";

import { drainSubagentDescendants } from "../src/bridge/index.ts";

describe("drainSubagentDescendants", () => {
    const parents = [{ id: "a" }, { id: "b" }];

    it("uses dsh 0.2.1's drainDescendants when present", async () => {
        const drainDescendants = vi.fn(async () => {});
        const drainContinuableDescendants = vi.fn(async () => {});
        await drainSubagentDescendants({ drainDescendants, drainContinuableDescendants }, parents);
        expect(drainDescendants).toHaveBeenCalledWith(parents);
        expect(drainContinuableDescendants).not.toHaveBeenCalled();
    });

    it("falls back to dsh 0.2.0's drainContinuableDescendants", async () => {
        const drainContinuableDescendants = vi.fn(async () => {});
        await drainSubagentDescendants({ drainContinuableDescendants }, parents);
        expect(drainContinuableDescendants).toHaveBeenCalledWith(parents);
    });

    it("is a no-op when the service exposes neither (no continuable manager)", async () => {
        await expect(drainSubagentDescendants({}, parents)).resolves.toBeUndefined();
        await expect(drainSubagentDescendants(undefined, parents)).resolves.toBeUndefined();
    });

    it("propagates a drain failure to the caller's warning path", async () => {
        const drainDescendants = vi.fn(async () => { throw new Error("boom"); });
        await expect(drainSubagentDescendants({ drainDescendants }, parents)).rejects.toThrow("boom");
    });
});
