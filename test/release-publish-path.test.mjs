import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReleaseArtifact } from "../scripts/resolve-release-artifact.mjs";

describe("release publish artifact paths", () => {
    it.each(["runtime", "shell"])("turns a %s-relative tarball path into an absolute local file", (directory) => {
        const root = join(tmpdir(), `dsh-acp-release-path-${process.pid}-${Date.now()}`);
        const relative = join(directory, "openma-deepseek-harness-acp-0.4.42-beta.2.tgz");
        try {
            mkdirSync(join(root, directory), { recursive: true });
            writeFileSync(join(root, relative), "test artifact");

            const result = resolveReleaseArtifact(relative, { cwd: root });

            expect(result).toBe(resolve(root, relative));
            expect(isAbsolute(result)).toBe(true);
            expect(result).not.toBe(relative);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("makes the workflow resolve both publish arguments before npm publish", () => {
        const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");

        expect(workflow).toContain('SHELL_TARBALL=$(node scripts/resolve-release-artifact.mjs "$SHELL_TARBALL")');
        expect(workflow).toContain('RUNTIME_TARBALL=$(node scripts/resolve-release-artifact.mjs "$RUNTIME_TARBALL")');

        const publishArgs = [...workflow.matchAll(/npm publish "([^"]+)"/g)].map((match) => match[1]);
        expect(publishArgs).toEqual(["$RUNTIME_TARBALL", "$SHELL_TARBALL"]);
        for (const arg of publishArgs) expect(arg).not.toMatch(/^(?:runtime|shell)\/.*\.tgz$/);
        const firstPublish = workflow.indexOf("          npm publish");
        for (const resolution of [
            'SHELL_TARBALL=$(node scripts/resolve-release-artifact.mjs "$SHELL_TARBALL")',
            'RUNTIME_TARBALL=$(node scripts/resolve-release-artifact.mjs "$RUNTIME_TARBALL")',
        ]) {
            expect(workflow.indexOf(resolution)).toBeGreaterThanOrEqual(0);
            expect(workflow.indexOf(resolution)).toBeLessThan(firstPublish);
        }
    });
});
