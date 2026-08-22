import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Workflow {
    jobs?: Record<string, {
        needs?: unknown;
        "timeout-minutes"?: number;
        strategy?: {
            matrix?: {
                os?: unknown;
                include?: Array<{ id?: string; pattern?: string }>;
            };
        };
        steps?: Array<{ run?: string }>;
    }>;
}

function readWorkflow(workflow: string): Workflow {
    const source = readFileSync(join(import.meta.dirname, "../.github/workflows", workflow), "utf8");
    return parse(source) as Workflow;
}

function testRunners(workflow: string): unknown {
    return readWorkflow(workflow).jobs?.["test"]?.strategy?.matrix?.os;
}

describe("supported CI architectures", () => {
    it.each(["ci.yml", "release.yml"])("runs %s tests on native Linux ARM64", (workflow) => {
        expect(testRunners(workflow)).toContain("ubuntu-24.04-arm");
    });

    it.each(["ci.yml", "release.yml"])("runs %s tests on Windows", (workflow) => {
        expect(testRunners(workflow)).toContain("windows-latest");
    });
});

describe("package installation gates", () => {
    it.each(["ci.yml", "release.yml"])(
        "runs %s package boundaries as independent timeout shards",
        (workflow) => {
            const jobs = readWorkflow(workflow).jobs;
            const install = jobs?.["package-install"];
            const cases = install?.strategy?.matrix?.include;
            const commands = install?.steps?.flatMap((step) => step.run ?? []);
            const regularTestCommands = jobs?.["test"]?.steps?.flatMap((step) => step.run ?? []);

            expect(install?.["timeout-minutes"]).toBe(25);
            expect(cases?.map((entry) => entry.id)).toEqual([
                "standalone",
                "rc7-profile",
                "current-prerelease",
                "remaining",
            ]);
            expect(commands).toContain('npm run test:install -- -t "${{ matrix.pattern }}"');
            expect(regularTestCommands).not.toContain("npm run test:install");
        },
    );

    it("keeps every release package shard ahead of publish", () => {
        const jobs = readWorkflow("release.yml").jobs;

        expect(jobs?.["package-install"]?.needs).toBe("verify-tag");
        expect(jobs?.["publish"]?.needs).toContain("package-install");
    });
});

describe("release provenance", () => {
    it("gates release tests on verifying that the tag commit belongs to main", () => {
        const jobs = readWorkflow("release.yml").jobs;
        const guardCommands = jobs?.["verify-tag"]?.steps?.flatMap((step) => step.run ?? []);

        expect(jobs?.["test"]?.needs).toBe("verify-tag");
        expect(guardCommands).toContain(
            'bash scripts/verify-release-tag.sh "$GITHUB_SHA" origin/main',
        );
    });
});
