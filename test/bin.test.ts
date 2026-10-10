/**
 * Bootstrap entrypoint coverage (issue #157): `src/bin.ts` resolves the
 * host through `explicitDshPath`, reports refused hosts on stderr without a
 * stack trace, and only then loads the CLI module behind its module hooks.
 *
 * Each case re-imports the entrypoint with `vi.resetModules()` so the
 * module-level bootstrap re-runs against the test's argv and mocks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { HELP_TEXT } from "../src/settings.ts";
import { VERSION } from "../src/version.ts";

const argvFor = (...args: string[]) => ["node", "dsh-acp", ...args];

function mockLog() {
    const logError = vi.fn();
    vi.doMock("../src/log.ts", () => ({ logError }));
    return { logError };
}

function mockIndex() {
    const main = vi.fn(async () => {});
    vi.doMock("../src/index.ts", () => ({ main }));
    return { main };
}

function mockHarness(impl: () => unknown) {
    class HarnessNotFoundError extends Error {}
    class HarnessCompatibilityError extends Error {}
    const resolveHost = vi.fn(impl);
    vi.doMock("../src/harness.ts", () => ({
        HarnessCompatibilityError,
        HarnessNotFoundError,
        hostModuleUrl: vi.fn((_host: unknown, specifier: string) => `mock:${specifier}`),
        resolveHost,
    }));
    return { HarnessCompatibilityError, HarnessNotFoundError, resolveHost };
}

beforeEach(() => {
    vi.resetModules();
    process.exitCode = 0;
    vi.stubEnv("DSH_PATH", "");
    vi.stubEnv("DSH_ACP_HOST", "");
});

describe("bootstrap", () => {
    it("prints the version without resolving a host", async () => {
        const { resolveHost } = mockHarness(() => ({ base: "/x", source: "test" }));
        const { main } = mockIndex();
        mockLog();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        process.argv = argvFor("--version");
        const { ready } = await import("../src/bin.ts");
        await ready;
        expect(log).toHaveBeenCalledWith(`@openma/deepseek-harness-acp ${VERSION}`);
        expect(resolveHost).not.toHaveBeenCalled();
        expect(main).not.toHaveBeenCalled();
    });

    it("prints the help text without resolving a host", async () => {
        mockHarness(() => ({ base: "/x", source: "test" }));
        mockIndex();
        mockLog();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        process.argv = argvFor("--help");
        const { ready } = await import("../src/bin.ts");
        await ready;
        expect(log).toHaveBeenCalledWith(HELP_TEXT.trimEnd());
    });

    it("resolves the explicit host and hands argv to the CLI module", async () => {
        const { resolveHost } = mockHarness(() => ({ base: "/opt/dsh", source: "test", version: "0.2.0-rc.2" }));
        const { main } = mockIndex();
        mockLog();
        process.argv = argvFor("--dsh-path", "/opt/dsh", "--bundle", "/b");
        const { ready } = await import("../src/bin.ts");
        await ready;
        expect(resolveHost).toHaveBeenCalledWith("/opt/dsh");
        expect(main).toHaveBeenCalledWith(["--dsh-path", "/opt/dsh", "--bundle", "/b"]);
    });

    it("honours DSH_PATH as the explicit selection", async () => {
        vi.stubEnv("DSH_PATH", "/env/dsh");
        const { resolveHost } = mockHarness(() => ({ base: "/env/dsh", source: "test" }));
        mockIndex();
        mockLog();
        process.argv = argvFor();
        const { ready } = await import("../src/bin.ts");
        await ready;
        expect(resolveHost).toHaveBeenCalledWith("/env/dsh");
    });

    it("exits 1 with a clean message when no runtime is found", async () => {
        const { HarnessNotFoundError } = mockHarness(() => {
            throw new HarnessNotFoundError("could not find a usable DeepSeek Harness runtime");
        });
        const { main } = mockIndex();
        const { logError } = mockLog();
        process.argv = argvFor();
        const { ready } = await import("../src/bin.ts");
        await ready;
        expect(logError).toHaveBeenCalledWith("could not find a usable DeepSeek Harness runtime");
        expect(process.exitCode).toBe(1);
        expect(main).not.toHaveBeenCalled();
    });

    it("exits 1 with a clean message on an incompatible host", async () => {
        const { HarnessCompatibilityError } = mockHarness(() => {
            throw new HarnessCompatibilityError("incompatible DeepSeek Harness: @deepseek-ai/dsh 0.1.1-rc.2");
        });
        const { main } = mockIndex();
        const { logError } = mockLog();
        process.argv = argvFor("--dsh-path", "/stale/dsh");
        const { ready } = await import("../src/bin.ts");
        await ready;
        expect(logError).toHaveBeenCalledWith("incompatible DeepSeek Harness: @deepseek-ai/dsh 0.1.1-rc.2");
        expect(process.exitCode).toBe(1);
        expect(main).not.toHaveBeenCalled();
    });

    it("logs the stack and exits 1 for unexpected failures", async () => {
        mockHarness(() => {
            throw new Error("boom");
        });
        const { main } = mockIndex();
        const { logError } = mockLog();
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        process.argv = argvFor();
        const { ready } = await import("../src/bin.ts");
        await ready;
        expect(logError).toHaveBeenCalledWith(expect.stringContaining("boom"));
        expect(exit).toHaveBeenCalledWith(1);
        expect(main).not.toHaveBeenCalled();
        exit.mockRestore();
    });
});
