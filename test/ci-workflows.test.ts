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
                dsh?: unknown;
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

describe("supported dsh versions", () => {
    it.each(["ci.yml", "release.yml"])("keeps %s compatibility checks on the 0.1.1 line", (workflow) => {
        expect(readWorkflow(workflow).jobs?.["dsh-compatibility"]?.strategy?.matrix?.dsh).toEqual([
            "0.1.1-rc.1",
        ]);
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
