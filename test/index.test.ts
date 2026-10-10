/**
 * CLI dispatcher coverage (issue #157): the login/serve entry paths select
 * the runtime through `explicitDshPath`, refuse incompatible/not-found
 * hosts cleanly, and always name the resolved host on stderr.
 *
 * `main` is exported so these paths are exercised in-process; `src/bin.ts`
 * imports this module only after installing its resolution hooks.
 */

import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    HarnessCompatibilityError,
    HarnessNotFoundError,
    resolveHost,
} from "../src/harness.ts";
import { bootAcpProfile } from "../src/profile-boot.ts";
import { runLogin } from "../src/login.ts";
import { logError, logInfo } from "../src/log.ts";
import { main } from "../src/index.ts";
import { HELP_TEXT } from "../src/settings.ts";
import { VERSION } from "../src/version.ts";

vi.mock("../src/harness.ts", () => {
    class HarnessNotFoundError extends Error {
        constructor(probed: string[]) {
            super(
                [
                    "could not find a usable DeepSeek Harness runtime.",
                    "The bundled DeepSeek Harness runtime is missing or invalid.",
                    `Looked at:\n${probed.map((p) => `    ${p}`).join("\n")}`,
                ].join("\n"),
            );
        }
    }
    class HarnessCompatibilityError extends Error {
        constructor(host: { dshVersion?: string; source: string }, supported: string) {
            super(
                `incompatible DeepSeek Harness: @deepseek-ai/dsh ${host.dshVersion ?? "unknown version"} found at ${host.source} — supported versions: ${supported}`,
            );
        }
    }
    return {
        HarnessCompatibilityError,
        HarnessNotFoundError,
        resolveHost: vi.fn(),
    };
});
vi.mock("../src/profile-boot.ts", () => ({ bootAcpProfile: vi.fn() }));
vi.mock("../src/login.ts", () => ({ runLogin: vi.fn() }));
vi.mock("../src/log.ts", () => ({
    logDebug: vi.fn(),
    logError: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    spawnSync: vi.fn(),
}));

const RANGE = "0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2";
const host = {
    base: "/opt/dsh",
    version: "0.2.0-rc.2",
    dshVersion: "0.2.0-rc.2",
    source: "bundled standalone runtime",
};

function fakeBooted() {
    return {
        provide: vi.fn(),
        fiber: { dispose: vi.fn(async () => {}) },
    };
}

// Signal handlers registered by a serve run belong to that run only; keep
// vitest's own listeners untouched.
const baselineSignals: Record<string, Array<(...args: never[]) => unknown>> = {};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    baselineSignals[signal] = process.listeners(signal) as never[];
}

beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    for (const name of ["DSH_PATH", "DSH_ACP_HOST", "DSH_ACP_COMPOSE"] as const) {
        vi.stubEnv(name, "");
    }
});

afterEach(() => {
    process.stdin.removeAllListeners("end");
    process.stdin.removeAllListeners("close");
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const baseline = baselineSignals[signal] ?? [];
        for (const listener of process.listeners(signal)) {
            if (!baseline.includes(listener as never)) {
                process.removeListener(signal, listener);
            }
        }
    }
    vi.unstubAllEnvs();
});

describe("CLI dispatch", () => {
    it("prints the version and exits before resolving a host", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await main(["--version"]);
        expect(log).toHaveBeenCalledWith(`@openma/deepseek-harness-acp ${VERSION}`);
        expect(resolveHost).not.toHaveBeenCalled();
    });

    it("prints the help text for --help", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await main(["--help"]);
        expect(log).toHaveBeenCalledWith(HELP_TEXT.trimEnd());
    });

    it("refuses a settings error with help text and exit code 2", async () => {
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        await main(["--wat"]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining("--wat"));
        expect(stderr).toHaveBeenCalledWith(`\n${HELP_TEXT}`);
        expect(process.exitCode).toBe(2);
    });
});

describe("login", () => {
    it("boots with the explicitly selected host and strips consumed host flags", async () => {
        const booted = fakeBooted();
        vi.mocked(resolveHost).mockReturnValue(host as never);
        vi.mocked(bootAcpProfile).mockResolvedValue(booted as never);
        vi.mocked(runLogin).mockResolvedValue(3);

        await main(["login", "--dsh-path", "/opt/custom-dsh", "sk-key", "--dsh-path=/late/dsh", "extra"]);

        expect(resolveHost).toHaveBeenCalledWith("/opt/custom-dsh");
        expect(bootAcpProfile).toHaveBeenCalledWith(host, { serve: false });
        expect(runLogin).toHaveBeenCalledWith(booted, ["sk-key", "extra"]);
        expect(booted.fiber.dispose).toHaveBeenCalled();
        expect(process.exitCode).toBe(3);
    });

    it("reports incompatible host selection without a stack trace", async () => {
        vi.mocked(resolveHost).mockImplementation(() => {
            throw new HarnessCompatibilityError(
                { ...host, dshVersion: "0.1.1-rc.2", source: "--dsh-path/DSH_PATH (/stale/dsh)" },
                RANGE,
            );
        });
        await main(["login", "--dsh-path", "/stale/dsh"]);
        expect(logError).toHaveBeenCalledWith(
            `incompatible DeepSeek Harness: @deepseek-ai/dsh 0.1.1-rc.2 found at --dsh-path/DSH_PATH (/stale/dsh) — supported versions: ${RANGE}`,
        );
        expect(process.exitCode).toBe(1);
        expect(runLogin).not.toHaveBeenCalled();
    });

    it("reports a missing host without a stack trace", async () => {
        vi.mocked(resolveHost).mockImplementation(() => {
            throw new HarnessNotFoundError(["bundled standalone runtime"]);
        });
        await main(["login"]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining("could not find a usable DeepSeek Harness runtime"));
        expect(process.exitCode).toBe(1);
    });

    it("rethrows unexpected host/boot failures", async () => {
        vi.mocked(resolveHost).mockImplementation(() => {
            throw new Error("boom");
        });
        await expect(main(["login"])).rejects.toThrow("boom");
    });
});

describe("update", () => {
    it("logs success when npm exits cleanly", async () => {
        vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never);
        await main(["update"]);
        expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("updated"));
    });

    it("propagates the npm failure status", async () => {
        vi.mocked(spawnSync).mockReturnValue({ status: 5 } as never);
        await main(["update"]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining("5"));
        expect(process.exitCode).toBe(5);
    });

    it("defaults to exit 1 when npm reports no status", async () => {
        vi.mocked(spawnSync).mockReturnValue({ status: null } as never);
        await main(["update"]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining("unknown"));
        expect(process.exitCode).toBe(1);
    });
});

describe("serve", () => {
    it("names the resolved host on stderr and shuts down on stdin end", async () => {
        const booted = fakeBooted();
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        vi.mocked(resolveHost).mockReturnValue(host as never);
        vi.mocked(bootAcpProfile).mockResolvedValue(booted as never);

        await main([]);

        expect(logInfo).toHaveBeenCalledWith(
            "harness host: @deepseek-ai/dsh 0.2.0-rc.2 via bundled standalone runtime (/opt/dsh)",
        );
        expect(bootAcpProfile).toHaveBeenCalledWith(host, { bundles: [] });
        process.stdin.emit("end");
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
        expect(booted.fiber.dispose).toHaveBeenCalled();
        exit.mockRestore();
    });

    it("labels an unversioned host as unknown version", async () => {
        vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        vi.mocked(resolveHost).mockReturnValue({ ...host, dshVersion: undefined } as never);
        vi.mocked(bootAcpProfile).mockResolvedValue(fakeBooted() as never);
        await main([]);
        expect(logInfo).toHaveBeenCalledWith(
            "harness host: @deepseek-ai/dsh unknown version via bundled standalone runtime (/opt/dsh)",
        );
    });

    it("refuses DSH_ACP_COMPOSE=spine explicitly", async () => {
        vi.stubEnv("DSH_ACP_COMPOSE", "spine");
        vi.mocked(resolveHost).mockReturnValue(host as never);
        await main([]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining("DSH_ACP_COMPOSE=spine is no longer supported"));
        expect(process.exitCode).toBe(1);
    });

    it("reports incompatible/missing hosts without a stack trace", async () => {
        vi.mocked(resolveHost).mockImplementation(() => {
            throw new HarnessCompatibilityError(
                { ...host, dshVersion: "0.1.1-rc.2", source: "--dsh-path/DSH_PATH (/stale/dsh)" },
                RANGE,
            );
        });
        await main([]);
        expect(logError).toHaveBeenCalledWith(
            `incompatible DeepSeek Harness: @deepseek-ai/dsh 0.1.1-rc.2 found at --dsh-path/DSH_PATH (/stale/dsh) — supported versions: ${RANGE}`,
        );
        expect(process.exitCode).toBe(1);

        vi.clearAllMocks();
        process.exitCode = 0;
        vi.mocked(resolveHost).mockImplementation(() => {
            throw new HarnessNotFoundError(["bundled standalone runtime"]);
        });
        await main([]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining("could not find a usable DeepSeek Harness runtime"));
        expect(process.exitCode).toBe(1);
    });

    it("rethrows unexpected host/boot failures", async () => {
        vi.mocked(resolveHost).mockImplementation(() => {
            throw new Error("boom");
        });
        await expect(main([])).rejects.toThrow("boom");
    });
});
