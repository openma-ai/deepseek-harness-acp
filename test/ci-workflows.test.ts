import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Workflow {
    jobs?: {
        test?: {
            strategy?: {
                matrix?: {
                    os?: unknown;
                };
            };
        };
    };
}

function testRunners(workflow: string): unknown {
    const source = readFileSync(join(import.meta.dirname, "../.github/workflows", workflow), "utf8");
    return (parse(source) as Workflow).jobs?.test?.strategy?.matrix?.os;
}

describe("supported CI architectures", () => {
    it.each(["ci.yml", "release.yml"])("runs %s tests on native Linux ARM64", (workflow) => {
        expect(testRunners(workflow)).toContain("ubuntu-24.04-arm");
    });
});
