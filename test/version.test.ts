import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version";

describe("VERSION", () => {
    it("is a semver-formatted version string", () => {
        expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
});
