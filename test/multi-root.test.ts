/**
 * Unit coverage for the built-in multi-root plugin: root validation and the
 * dialect-widening profiles. E2E coverage of the ACP surface lives in
 * test/e2e.test.ts.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import type { ConfinedArgv, SandboxPolicy } from "@deepseek-ai/dsh-sandbox";

import {
    DialectUnrecognizedError,
    widenConfinedArgv,
} from "../src/multi-root/dialects.ts";
import { MultiRootFileSystem } from "../src/multi-root/fs.ts";
import { MultiRootSandboxProvider } from "../src/multi-root/sandbox.ts";
import {
    canonicalRoot,
    effectiveAdditionalRoots,
    normalizeAdditionalDirectories,
    RootValidationError,
} from "../src/multi-root/roots.ts";
import { AcpMultiRootScope } from "../src/multi-root/scope.ts";

const roots: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
}

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const policy = (workspaceRoot: string, mode: SandboxPolicy["mode"] = "workspace-write"): SandboxPolicy => ({
    mode,
    workspaceRoot,
});

function confined(argv: string[]): ConfinedArgv {
    return {
        argv,
        enforcement: "full",
        denialSignatures: ["operation not permitted"],
        runnerFailureRules: [],
    };
}

describe("multi-root validation", () => {
    it("treats omitted and empty input as the single-root path", () => {
        expect(normalizeAdditionalDirectories(undefined)).toEqual([]);
        expect(normalizeAdditionalDirectories(null)).toEqual([]);
        expect(normalizeAdditionalDirectories([])).toEqual([]);
    });

    it("canonicalizes absolute directories and preserves request order", () => {
        const first = tempDir("dsh-acp-root-a-");
        const second = tempDir("dsh-acp-root-b-");
        // mkdtempSync may return a non-realpath spelling (macOS /var → /private/var;
        // Windows short names); the plugin always stores the realpath form.
        expect(normalizeAdditionalDirectories([first, second])).toEqual([
            canonicalRoot(first),
            canonicalRoot(second),
        ]);
    });

    it("rejects relative, non-directory, missing, duplicate, and primary entries", () => {
        const primary = tempDir("dsh-acp-primary-");
        const extra = tempDir("dsh-acp-extra-");
        const file = join(extra, "file.txt");
        writeFileSync(file, "x");

        const expectCode = (input: unknown, code: string, options?: { primaryRoot?: string }): void => {
            try {
                normalizeAdditionalDirectories(input, options);
                throw new Error("expected validation to fail");
            } catch (error: unknown) {
                expect(error).toBeInstanceOf(RootValidationError);
                expect((error as RootValidationError).code).toBe(code);
            }
        };

        expectCode(["relative/path"], "not-absolute");
        expectCode(["   "], "not-absolute");
        expectCode([file], "not-a-directory");
        expectCode([join(extra, "missing")], "missing");
        expectCode([extra, extra], "duplicate");
        expectCode([primary], "equals-primary", { primaryRoot: primary });
        expectCode("not-an-array", "not-an-array");
        expectCode([42], "not-a-string");
    });

    it("withholds missing roots and the primary root from the effective set", () => {
        const primary = tempDir("dsh-acp-effective-primary-");
        const extra = tempDir("dsh-acp-effective-extra-");
        const nested = join(primary, "nested");
        mkdirSync(nested);
        expect(effectiveAdditionalRoots(primary, [extra, nested, join(extra, "gone")])).toEqual([
            canonicalRoot(extra),
        ]);
    });
});

describe("multi-root dialect widening", () => {
    it("returns the upstream argv unchanged for an empty scope or read-only mode", () => {
        const workspace = tempDir("dsh-acp-dialect-workspace-");
        const upstream = confined([
            "bwrap",
            "--ro-bind",
            "/",
            "/",
            "--bind",
            workspace,
            workspace,
            "--",
            "true",
        ]);
        expect(widenConfinedArgv(upstream, ["true"], policy(workspace), [])).toBe(upstream);
        expect(widenConfinedArgv(upstream, ["true"], policy(workspace, "read-only"), ["/extra"])).toBe(upstream);
    });

    it("widens a bwrap profile with a writable bind", () => {
        const workspace = tempDir("dsh-acp-bwrap-workspace-");
        const extra = tempDir("dsh-acp-bwrap-extra-");
        const upstream = confined([
            "bwrap",
            "--ro-bind",
            "/",
            "/",
            "--tmpfs",
            "/tmp",
            "--bind",
            workspace,
            workspace,
            "--",
            "true",
        ]);
        const widened = widenConfinedArgv(upstream, ["true"], policy(workspace), [extra]);
        expect(widened.argv).toEqual([
            "bwrap",
            "--ro-bind",
            "/",
            "/",
            "--tmpfs",
            "/tmp",
            "--bind",
            workspace,
            workspace,
            "--bind",
            extra,
            extra,
            "--",
            "true",
        ]);
        expect(widened.enforcement).toBe("full");
        expect(widened.denialSignatures).toBe(upstream.denialSignatures);
    });

    it("widens a landlock profile with a read-write grant", () => {
        const workspace = tempDir("dsh-acp-landlock-workspace-");
        const extra = tempDir("dsh-acp-landlock-extra-");
        const upstream = confined([
            "landlock-run",
            "--ro",
            "/",
            "--rw",
            "/dev/null",
            "--rw",
            workspace,
            "--",
            "true",
        ]);
        expect(widenConfinedArgv(upstream, ["true"], policy(workspace), [extra]).argv).toEqual([
            "landlock-run",
            "--ro",
            "/",
            "--rw",
            "/dev/null",
            "--rw",
            workspace,
            "--rw",
            extra,
            "--",
            "true",
        ]);
    });

    it("widens the seatbelt profile's writable subpath form", () => {
        const workspace = tempDir("dsh-acp-seatbelt-workspace-");
        const extra = tempDir("dsh-acp-seatbelt-extra-");
        // SBPL string literals escape \ and " the same way dialects.sbplString does.
        // Build the fixture profile with the same quoting so both roots match.
        const sbplLiteral = (path: string): string =>
            `"${path.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
        const profile = `(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) (allow file-write* (subpath "/tmp") (subpath ${sbplLiteral(workspace)}))`;
        const upstream = confined(["sandbox-exec", "-p", profile, "--", "true"]);
        const widened = widenConfinedArgv(upstream, ["true"], policy(workspace), [extra]);
        const widenedProfile = widened.argv[2] ?? "";
        expect(widenedProfile).toContain(`(subpath ${sbplLiteral(extra)})`);
        expect(widenedProfile).toContain(`(subpath ${sbplLiteral(workspace)})`);
        expect(widened.argv.slice(-2)).toEqual(["--", "true"]);
    });

    it("fails closed on an unrecognized profile shape", () => {
        const workspace = tempDir("dsh-acp-unknown-workspace-");
        expect(() =>
            widenConfinedArgv(confined(["mystery", "--", "true"]), ["true"], policy(workspace), ["/extra"]),
        ).toThrow(DialectUnrecognizedError);
    });
});

describe("multi-root filesystem fence", () => {
    it("allows writes under a scoped root and restores the single-root fence when empty", async () => {
        const workspace = tempDir("dsh-acp-fence-workspace-");
        // Outside /tmp so the upstream temp-area grant cannot mask the
        // additional-root grant being tested.
        const extra = mkdtempSync(join(process.cwd(), ".dsh-acp-fence-extra-"));
        roots.push(extra);
        // Deliberately outside /tmp: the upstream workspace-write policy
        // grants the platform temp areas, so a temp-dir target would pass
        // even without the scoped root.
        const outside = mkdtempSync(join(process.cwd(), ".dsh-acp-fence-outside-"));
        roots.push(outside);
        const sessionId = "session-1" as never;
        const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: workspace, sessionId };

        const ctx = new Context();
        const scope = new AcpMultiRootScope(ctx);
        ctx.provide("sandboxPolicy", {
            defaultMode: "workspace-write",
            resolve: () => policy,
        } as never);
        const fs = new MultiRootFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 10 * 1024 * 1024 });

        scope.set("session-1", [extra]);
        await expect(fs.writeText(await fs.resolve(join(extra, "allowed.txt")), "ok", undefined, undefined, policy))
            .resolves.toMatchObject({ operation: "create" });

        await expect(fs.writeText(await fs.resolve(join(outside, "denied.txt")), "no", undefined, undefined, policy))
            .rejects.toMatchObject({ code: "FS_SANDBOX_DENIED" });

        // Empty scope is the upstream single-root fence: the extra root is
        // no longer writable, while the primary root still is.
        scope.set("session-1", []);
        await expect(fs.writeText(await fs.resolve(join(extra, "denied.txt")), "no", undefined, undefined, policy))
            .rejects.toMatchObject({ code: "FS_SANDBOX_DENIED" });
        await expect(fs.writeText(await fs.resolve(join(workspace, "primary.txt")), "ok", undefined, undefined, policy))
            .resolves.toMatchObject({ operation: "create" });
    });
});

describe("multi-root sandbox provider", () => {
    it("widens the selected bwrap profile with the session's roots", async () => {
        const workspace = tempDir("dsh-acp-sandbox-workspace-");
        const extra = tempDir("dsh-acp-sandbox-extra-");
        const sessionId = "session-sandbox" as never;
        const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: workspace, sessionId };

        const ctx = new Context();
        const scope = new AcpMultiRootScope(ctx);
        const provider = new MultiRootSandboxProvider(ctx, {
            runnerCommand: [],
            runnerFailureSignatures: [],
            probeTimeoutMs: 5_000,
        });
        // A chain of one is selected without probing; bwrap's profile shape is
        // then widened by the additional root.
        provider.internals.chain = ["bwrap"];

        scope.set("session-sandbox", [extra]);
        const confined = await provider.confine(["true"], policy);
        const separator = confined.argv.indexOf("--");
        expect(separator).toBeGreaterThan(0);
        const canonicalExtra = canonicalRoot(extra);
        expect(confined.argv.slice(0, separator)).toEqual(
            expect.arrayContaining(["--bind", canonicalExtra, canonicalExtra]),
        );

        scope.set("session-sandbox", []);
        const singleRoot = await provider.confine(["true"], policy);
        expect(singleRoot.argv).not.toContain(canonicalExtra);
    });
});
