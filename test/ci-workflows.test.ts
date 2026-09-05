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
    it.each(["ci.yml", "release.yml"])("checks three independent RC hosts through %s's profile matrix", (workflow) => {
        const job = readWorkflow(workflow).jobs?.["dsh-compatibility"];
        const steps = job?.steps ?? [];
        const commands = steps.flatMap((step) => step.run ?? []);
        const exercise = steps.find((step) => step.name === "Exercise the installed dsh profile");

        expect(job?.strategy?.matrix?.dsh).toBe("${{ fromJSON(needs.compatibility-versions.outputs.versions) }}");
        expect(job?.needs).toBe("compatibility-versions");
        const versions = JSON.parse(readFileSync(join(import.meta.dirname, "../runtime/compatibility.json"), "utf8")) as string[];
        expect(versions).toHaveLength(3);
        expect(new Set(versions).size).toBe(3);
        for (const version of versions) expect(version).toMatch(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
        const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));
        expect(versions).toContain(manifest.dshAcp.standaloneDsh);
        expect(commands.some((command) => command.includes('"@deepseek-ai/dsh@${{ matrix.dsh }}"'))).toBe(true);
        expect(exercise?.run).toContain("scripts/profile-smoke.mjs");
        expect(exercise?.run).toContain("$RUNNER_TEMP/dsh-host/");
    });
});

describe("release provenance", () => {
    it.each(["ci.yml", "release.yml"])("boots the same bundled artifact across platforms in %s", (workflow) => {
        const jobs = readWorkflow(workflow).jobs;
        expect(jobs?.["standalone"]?.strategy?.matrix?.os).toContain("macos-latest");
        expect(jobs?.["standalone"]?.strategy?.matrix?.os).toContain("macos-15-intel");
        expect(jobs?.["standalone"]?.steps?.some((step) => step.run?.includes("scripts/standalone-smoke.mjs"))).toBe(true);
        if (workflow === "release.yml") expect(jobs?.["publish"]?.needs).toContain("standalone");
    });
    it("gates release tests on verifying that the tag commit belongs to main", () => {
        const jobs = readWorkflow("release.yml").jobs;
        const guardCommands = jobs?.["verify-tag"]?.steps?.flatMap((step) => step.run ?? []);

        expect(jobs?.["test"]?.needs).toBe("verify-tag");
        expect(jobs?.["publish"]?.needs).toContain("dsh-compatibility");
        expect(guardCommands).toContain(
            'bash scripts/verify-release-tag.sh "$GITHUB_SHA" origin/main',
        );
    });
});
