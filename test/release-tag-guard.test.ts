import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const GUARD = join(import.meta.dirname, "../scripts/verify-release-tag.sh");
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
}

function commit(cwd: string, file: string, contents: string, message: string): string {
    writeFileSync(join(cwd, file), contents);
    git(cwd, "add", "--", file);
    git(cwd, "commit", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
}

describe("release tag ancestry guard", () => {
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("accepts main commits and rejects commits that only exist on a side branch", () => {
        const repo = mkdtempSync(join(tmpdir(), "dsh-acp-release-tag-"));
        roots.push(repo);
        git(repo, "init", "-b", "main");
        git(repo, "config", "user.name", "Release Guard Test");
        git(repo, "config", "user.email", "release-guard@example.invalid");
        commit(repo, "base.txt", "base\n", "base");

        git(repo, "switch", "-c", "side");
        const sideCommit = commit(repo, "side.txt", "side\n", "side release");
        git(repo, "switch", "main");
        const mainCommit = commit(repo, "main.txt", "main\n", "main release");
        git(repo, "update-ref", "refs/remotes/origin/main", mainCommit);

        const accepted = spawnSync("bash", [GUARD, mainCommit, "origin/main"], {
            cwd: repo,
            encoding: "utf8",
        });
        const rejected = spawnSync("bash", [GUARD, sideCommit, "origin/main"], {
            cwd: repo,
            encoding: "utf8",
        });

        expect(accepted.status, accepted.stderr).toBe(0);
        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toContain("release tags must point to a commit on origin/main");
    });
});
