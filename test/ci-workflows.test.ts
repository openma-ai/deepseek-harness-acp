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
        steps?: Array<{
            name?: string;
            run?: string;
            env?: Record<string, unknown>;
        }>;
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

describe("dsh compatibility host", () => {
    it.each(["ci.yml", "release.yml"])("reuses %s's locked 0.1.1 host without a second install", (workflow) => {
        const steps = readWorkflow(workflow).jobs?.["dsh-compatibility"]?.steps ?? [];
        const commands = steps.flatMap((step) => step.run ?? []);
        const exercise = steps.find((step) => step.name === "Exercise session controls through the host");

        expect(commands.some((command) => command.includes("npm install"))).toBe(false);
        expect(exercise?.env?.["DSH_ACP_TEST_HOST"]).toBe("${{ github.workspace }}");
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
