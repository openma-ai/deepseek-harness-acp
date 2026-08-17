import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
let tarball = "";

function run(command: string, args: string[], env?: NodeJS.ProcessEnv, input?: string) {
    return spawnSync(command, args, {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, ...env },
        input,
        encoding: "utf8",
        timeout: 120_000,
    });
}

beforeAll(() => {
    const packDir = mkdtempSync(join(tmpdir(), "dsh-acp-profile-pack-"));
    roots.push(packDir);
    const packed = run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir]);
    expect(packed.status, packed.stderr).toBe(0);
    tarball = join(packDir, packed.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(existsSync(tarball)).toBe(true);
});

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
}, 120_000);

describe("ACP package installation", () => {
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

        const child = spawn(process.execPath, [dshBin, "--profile", "acp"], {
            cwd: join(import.meta.dirname, ".."),
            env: {
                ...process.env,
                DSH_HOME: home,
                DEEPSEEK_API_KEY: "sk-test-not-real",
            },
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
                reject(new Error(`dsh profile exited ${code}\n${stderr}`));
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
        expect(response).toMatchObject({
            id: 1,
            result: { agentInfo: { name: "dsh-acp" } },
        });
    }, 120_000);
});
