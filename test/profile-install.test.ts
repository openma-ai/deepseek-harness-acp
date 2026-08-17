import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
let tarball = "";
let toolBin = "";

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
        timeout: 180_000,
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
}, 180_000);

describe("ACP package installation", () => {
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
    }, 180_000);

    it("installs into a dsh profile without installing a second dsh runtime", () => {
        const home = mkdtempSync(join(tmpdir(), "dsh-acp-profile-home-"));
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
        const profileDir = join(home, "profiles", "acp");
        const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8")) as {
            dsh?: { profile?: { bundles?: string[] } };
        };
        expect(manifest.dsh?.profile?.bundles).toContain("@openma/deepseek-harness-acp");
        expect(existsSync(join(profileDir, "node_modules/@deepseek-ai/dsh"))).toBe(false);
        const privateDshPackages = existsSync(join(profileDir, "node_modules/@deepseek-ai"))
            ? readdirSync(join(profileDir, "node_modules/@deepseek-ai")).filter((name) => name.startsWith("dsh-"))
            : [];
        expect(privateDshPackages).toEqual([]);
    }, 120_000);

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
    }, 120_000);
});
