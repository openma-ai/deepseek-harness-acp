import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
let tarball = "";
let toolBin = "";
// npm 11 can spend several minutes resolving the older dsh peer graph on a
// cold runner. Keep a finite ceiling, but do not turn resolver speed into a
// package-compatibility failure.
const INSTALL_TIMEOUT_MS = 900_000;

function run(command: string, args: string[], env?: NodeJS.ProcessEnv, input?: string) {
    return spawnSync(command, args, {
        cwd: join(import.meta.dirname, ".."),
        env: {
            ...process.env,
            // Profiles are intentionally single-package pnpm workspaces. The
            // released rc.6 host predates its own --workspace-root fix, so
            // keep that host quirk out of this package-boundary regression.
            npm_config_ignore_workspace_root_check: "true",
            PATH: toolBin.length === 0 ? process.env["PATH"] : `${toolBin}:${process.env["PATH"] ?? ""}`,
            ...env,
        },
        input,
        encoding: "utf8",
        timeout: INSTALL_TIMEOUT_MS,
    });
}

async function initializeAcp(
    bin: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    args: string[] = [],
): Promise<unknown> {
    const child = spawn(process.execPath, [bin, ...args], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    const response = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`ACP initialize timed out\n${stderr}`));
        }, 30_000);
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
            const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
            if (line === undefined) return;
            clearTimeout(timer);
            resolve(JSON.parse(line));
        });
        child.on("exit", (code) => {
            if (stdout.trim().length > 0) return;
            clearTimeout(timer);
            reject(new Error(`dsh-acp exited ${code}\n${stderr}`));
        });
        child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: 1 },
        })}\n`);
    });
    child.stdin.end();
    child.kill("SIGTERM");
    return response;
}

describe.skipIf(process.platform === "win32")("ACP package installation", () => {
    beforeAll(() => {
        toolBin = mkdtempSync(join(tmpdir(), "dsh-acp-profile-tools-"));
        roots.push(toolBin);
        writeFileSync(
            join(toolBin, "pnpm"),
            '#!/bin/sh\nexec npx --yes pnpm@10.34.5 "$@"\n',
            { mode: 0o755 },
        );
        const packDir = mkdtempSync(join(tmpdir(), "dsh-acp-profile-pack-"));
        roots.push(packDir);
        const packed = run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir]);
        expect(packed.status, packed.stderr).toBe(0);
        tarball = join(packDir, packed.stdout.trim().split(/\r?\n/).at(-1)!);
        expect(existsSync(tarball)).toBe(true);
    });

    afterAll(() => {
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    }, INSTALL_TIMEOUT_MS);

    it("serves standalone from one complete dsh peer host", async () => {
        const prefix = mkdtempSync(join(tmpdir(), "dsh-acp-standalone-prefix-"));
        const home = mkdtempSync(join(tmpdir(), "dsh-acp-standalone-home-"));
        roots.push(prefix, home);
        const installed = run("npm", [
            "install",
            "--prefix",
            prefix,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            `file:${tarball}`,
        ]);

        expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
        expect(existsSync(join(prefix, "node_modules/@deepseek-ai/dsh/package.json"))).toBe(true);
        const hostVersion = JSON.parse(
            readFileSync(join(prefix, "node_modules/@deepseek-ai/dsh/package.json"), "utf8"),
        ).version as string;
        for (const name of ["dsh-mcp-client", "dsh-attachment"]) {
            const version = JSON.parse(
                readFileSync(join(prefix, `node_modules/@deepseek-ai/${name}/package.json`), "utf8"),
            ).version as string;
            expect(version, `${name} must come from the standalone host release`).toBe(hostVersion);
        }
        const response = await initializeAcp(
            join(prefix, "node_modules/@openma/deepseek-harness-acp/dist/index.js"),
            prefix,
            {
                DSH_HOME: home,
                DEEPSEEK_API_KEY: "sk-test-not-real",
            },
        );
        expect(response).toMatchObject({
            id: 1,
            result: { agentInfo: { name: "dsh-acp" } },
        });
    }, INSTALL_TIMEOUT_MS);

    it("keeps an rc.6 profile coherent instead of mixing rc.7 internals", () => {
        const home = mkdtempSync(join(tmpdir(), "dsh-acp-profile-home-"));
        roots.push(home);
        const hostManifest = JSON.parse(
            readFileSync(join(import.meta.dirname, "../node_modules/@deepseek-ai/dsh/package.json"), "utf8"),
        ) as { version: string };
        expect(hostManifest.version).toBe("0.1.0-rc.6");
        const dshBin = join(
            import.meta.dirname,
            "../node_modules/@deepseek-ai/dsh/lib/bin.js",
        );

        const installed = run(
            process.execPath,
            [dshBin, "plugin", "--profile", "acp", "add", `file:${tarball}`],
            { DSH_HOME: home },
        );

        expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
        const profileDir = join(home, "profiles", "acp");
        const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8")) as {
            dsh?: { profile?: { bundles?: string[] } };
        };
        expect(manifest.dsh?.profile?.bundles).toContain("@openma/deepseek-harness-acp");
        expect(existsSync(join(profileDir, "node_modules/@deepseek-ai/dsh"))).toBe(false);
        expect(existsSync(join(profileDir, "node_modules/@deepseek-ai/dsh-mcp-client"))).toBe(false);
        expect(existsSync(join(profileDir, "node_modules/@deepseek-ai/dsh-attachment"))).toBe(false);
        const privateDshPackages = existsSync(join(profileDir, "node_modules/@deepseek-ai"))
            ? readdirSync(join(profileDir, "node_modules/@deepseek-ai")).filter((name) => name.startsWith("dsh-"))
            : [];
        expect(privateDshPackages).toEqual([]);
    }, INSTALL_TIMEOUT_MS);

    it("is idempotent when the same ACP bundle is added to a profile twice", () => {
        const home = mkdtempSync(join(tmpdir(), "dsh-acp-profile-twice-"));
        roots.push(home);
        const dshBin = join(
            import.meta.dirname,
            "../node_modules/@deepseek-ai/dsh/lib/bin.js",
        );

        for (let index = 0; index < 2; index += 1) {
            const installed = run(
                process.execPath,
                [dshBin, "plugin", "--profile", "acp", "add", `file:${tarball}`],
                { DSH_HOME: home },
            );
            expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
        }

        const manifest = JSON.parse(
            readFileSync(join(home, "profiles/acp/package.json"), "utf8"),
        ) as {
            dependencies?: Record<string, string>;
            dsh?: { profile?: { bundles?: string[] } };
        };
        expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@openma/deepseek-harness-acp"]);
        expect(
            manifest.dsh?.profile?.bundles?.filter((name) => name === "@openma/deepseek-harness-acp"),
        ).toHaveLength(1);
    }, INSTALL_TIMEOUT_MS);

    it("serves as a profile plugin on a coherent rc.7 host", async () => {
        const prefix = mkdtempSync(join(tmpdir(), "dsh-acp-rc7-prefix-"));
        const home = mkdtempSync(join(tmpdir(), "dsh-acp-rc7-home-"));
        roots.push(prefix, home);
        const hostInstalled = run("npm", [
            "install",
            "--prefix",
            prefix,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "@deepseek-ai/dsh@0.1.0-rc.7",
        ]);
        expect(hostInstalled.status, `${hostInstalled.stdout}\n${hostInstalled.stderr}`).toBe(0);
        const dshBin = join(prefix, "node_modules/@deepseek-ai/dsh/lib/bin.js");
        const pluginInstalled = run(
            process.execPath,
            [dshBin, "plugin", "--profile", "acp", "add", `file:${tarball}`],
            { DSH_HOME: home },
        );
        expect(pluginInstalled.status, `${pluginInstalled.stdout}\n${pluginInstalled.stderr}`).toBe(0);
        const profileDir = join(home, "profiles", "acp");
        expect(existsSync(join(profileDir, "node_modules/@deepseek-ai/dsh"))).toBe(false);
        const response = await initializeAcp(
            dshBin,
            prefix,
            {
                DSH_HOME: home,
                DEEPSEEK_API_KEY: "sk-test-not-real",
            },
            ["--profile", "acp"],
        );
        expect(response).toMatchObject({
            id: 1,
            result: { agentInfo: { name: "dsh-acp" } },
        });
    }, INSTALL_TIMEOUT_MS);

    it("rejects an explicitly incompatible standalone host under strict peer resolution", () => {
        const prefix = mkdtempSync(join(tmpdir(), "dsh-acp-incompatible-prefix-"));
        roots.push(prefix);
        const installed = run("npm", [
            "install",
            "--prefix",
            prefix,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--strict-peer-deps",
            "@deepseek-ai/dsh@0.1.0-rc.3",
            `file:${tarball}`,
        ]);

        expect(installed.status).not.toBe(0);
        expect(`${installed.stdout}\n${installed.stderr}`).toMatch(/ERESOLVE|conflicting peer dependency/i);
    }, INSTALL_TIMEOUT_MS);

    it("serves ACP after installation into a dsh profile", async () => {
        const home = mkdtempSync(join(tmpdir(), "dsh-acp-profile-runtime-"));
        roots.push(home);
        const dshBin = join(
            import.meta.dirname,
            "../node_modules/@deepseek-ai/dsh/lib/bin.js",
        );
        const installed = run(
            process.execPath,
            [dshBin, "plugin", "--profile", "acp", "add", `file:${tarball}`],
            { DSH_HOME: home },
        );
        expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);

        const response = await initializeAcp(
            dshBin,
            join(import.meta.dirname, ".."),
            {
                DSH_HOME: home,
                DEEPSEEK_API_KEY: "sk-test-not-real",
            },
            ["--profile", "acp"],
        );
        expect(response).toMatchObject({
            id: 1,
            result: { agentInfo: { name: "dsh-acp" } },
        });
    }, INSTALL_TIMEOUT_MS);
});
