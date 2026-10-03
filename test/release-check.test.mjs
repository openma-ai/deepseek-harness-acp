import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it as vitestIt } from "vitest";

// Windows CI git init/commit is slow; this file builds several temporary repositories.
const it = (name, fn) => vitestIt(name, fn, 60_000);
import { fileURLToPath } from "node:url";
import {
    classifyBump,
    extractPullRequests,
    githubRepository,
    mentionsPullRequest,
    readmePinErrors,
    runReleaseCheck,
} from "../scripts/release-check.mjs";

const script = fileURLToPath(new URL("../scripts/release-check.mjs", import.meta.url));
const roots = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release check parsing", () => {
    it("classifies patch, minor, major, prerelease promotion, and downgrades", () => {
        expect(classifyBump("0.4.35", "0.4.36").kind).toBe("patch");
        expect(classifyBump("0.4.22", "0.4.23-beta.0").kind).toBe("patch");
        expect(classifyBump("0.4.23-beta.0", "0.4.23").kind).toBe("patch");
        expect(classifyBump("0.4.36-beta.0", "0.4.36-beta.1").kind).toBe("patch");
        expect(classifyBump("0.4.36", "0.5.0").kind).toBe("minor");
        expect(classifyBump("0.4.36", "0.5.0-beta.0").kind).toBe("minor");
        expect(classifyBump("0.4.36", "1.0.0").kind).toBe("major");
        expect(classifyBump("0.4.36", "0.4.36").kind).toBe("same");
        expect(classifyBump("0.4.36", "0.4.35").kind).toBe("invalid");
        expect(classifyBump("0.4.36", "0.4.36-beta.1").kind).toBe("invalid");
        expect(classifyBump("0.4", "0.4.1").reason).toMatch(/major\.minor\.patch/);
    });

    it("reads squash subjects and merge commits without treating #100 as #10", () => {
        expect(extractPullRequests([
            "Merge pull request #30 from openma-ai/fix/dsh-0.1.7-permission",
            "fix: support dsh 0.1.7 and stream live tool output",
            "release: v0.4.34",
            "feat: one (#32)",
            "feat: again (#32)",
            "chore: see (#10) and (#100)",
        ])).toEqual([10, 30, 32, 100]);
        expect(mentionsPullRequest("see #100 and /pull/100", 10)).toBe(false);
        expect(mentionsPullRequest("see #10", 1)).toBe(false);
        expect(mentionsPullRequest("landed in #32", 32)).toBe(true);
        expect(mentionsPullRequest("https://github.com/openma-ai/deepseek-harness-acp/pull/33", 33)).toBe(true);
        expect(mentionsPullRequest("https://github.com/openma-ai/deepseek-harness-acp/pull/330", 33)).toBe(false);
    });

    it("pins only this package's version and ignores @latest and the bundled DSH version", () => {
        const readme = "The bundled runtime is DSH `0.1.5-rc.1`.\n\ndsh plugin add @openma/deepseek-harness-acp@latest\n";
        expect(readmePinErrors(readme, "0.4.36")).toEqual([]);
        expect(readmePinErrors(`${readme}@openma/deepseek-harness-acp@0.4.35\n`, "0.4.36")).toEqual([
            "README.md pins @openma/deepseek-harness-acp@0.4.35, expected version 0.4.36",
        ]);
        expect(readmePinErrors("github:openma-ai/deepseek-harness-acp#v0.4.36\n", "0.4.36")).toEqual([]);
        expect(githubRepository("git@github.com:openma-ai/deepseek-harness-acp.git")).toBe("openma-ai/deepseek-harness-acp");
        expect(githubRepository("https://github.com/openma-ai/deepseek-harness-acp")).toBe("openma-ai/deepseek-harness-acp");
    });
});

describe("release check on a pull request", () => {
    it("notices unreleased pull requests and does not fail when the version is unchanged", () => {
        const cwd = releasedRepo("0.4.36");
        writeFileSync(join(cwd, "feature.txt"), "one\n");
        commitAll(cwd, "fix: keep Cursor review prompt substitution literal (#34)");
        writeFileSync(join(cwd, "README.md"), readme("0.4.1"));
        commitAll(cwd, "docs: stale readme pin");

        const result = run(cwd);

        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("::notice::Unreleased PRs on main since v0.4.36: #34\n");
        expect(result.stdout).toContain("package.json version is unchanged (0.4.36); release gate skipped.");
        expect(result.stdout).not.toContain("::error");
        expect(result.stderr).toBe("");
    });

    it("stays quiet when nothing is unreleased", () => {
        const result = run(releasedRepo("0.4.35"));
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("No unreleased pull requests on main since v0.4.35.");
        expect(result.stdout).not.toContain("::notice");
        expect(result.stdout).not.toContain("::error");
    });

    it("accepts a patch version commit that only bumps the manifest and lockfile", () => {
        const cwd = releasedRepo("0.4.35");
        writeFileSync(join(cwd, "feature.txt"), "landed\n");
        commitAll(cwd, "chore: upgrade bundled dsh to 0.2.0-rc.2 (#32)");
        release(cwd, "0.4.36");

        const result = run(cwd, { RELEASE_LABELS: "" });

        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("::notice::Unreleased PRs on main since v0.4.35: #32");
        expect(result.stdout).toContain("Release check passed for 0.4.35 -> 0.4.36.");
        expect(result.stderr).not.toContain("missing PR");
    });

    it("requires both package-lock versions to match", () => {
        const rootMismatch = releasedRepo("0.4.35");
        release(rootMismatch, "0.4.36", { root: "0.4.35", nested: "0.4.36" });
        const rootResult = run(rootMismatch, { RELEASE_LABELS: "" });
        expect(rootResult.code).toBe(1);
        expect(rootResult.stderr).toContain('package-lock.json version is "0.4.35", expected 0.4.36');
        expect(rootResult.stderr).not.toContain('packages[""].version');

        const nestedMismatch = releasedRepo("0.4.35");
        release(nestedMismatch, "0.4.36", { root: "0.4.36", nested: "0.4.35" });
        const nestedResult = run(nestedMismatch, { RELEASE_LABELS: "" });
        expect(nestedResult.code).toBe(1);
        expect(nestedResult.stderr).toContain('package-lock.json packages[""].version is "0.4.35", expected 0.4.36');
    });

    it("allows a patch or prerelease promotion without a label and requires one for minor or major", () => {
        const patch = releasedRepo("0.4.22");
        release(patch, "0.4.23-beta.0");
        expect(run(patch, { RELEASE_LABELS: "" }).code, "beta patch").toBe(0);

        const promotion = releasedRepo("0.4.23-beta.0");
        release(promotion, "0.4.23");
        expect(run(promotion, { RELEASE_LABELS: "" }).code, "stable promotion").toBe(0);

        const minor = releasedRepo("0.4.35");
        release(minor, "0.5.0");
        expect(run(minor, { RELEASE_LABELS: "" }).stderr).toContain(
            "Minor bump 0.4.35 -> 0.5.0 requires the release:minor label",
        );
        expect(run(minor, { RELEASE_LABELS: "release:major" }).stderr).toContain(
            "requires the release:minor label",
        );
        expect(run(minor, { RELEASE_LABELS: "other, release:minor" }).code).toBe(0);

        const prereleaseMinor = releasedRepo("0.4.36");
        release(prereleaseMinor, "0.5.0-beta.0");
        expect(run(prereleaseMinor, { RELEASE_LABELS: "" }).stderr).toContain(
            "Minor bump 0.4.36 -> 0.5.0-beta.0 requires the release:minor label",
        );

        const major = releasedRepo("0.4.35");
        release(major, "1.0.0");
        expect(run(major, { RELEASE_LABELS: "release:minor" }).stderr).toContain(
            "Major bump 0.4.35 -> 1.0.0 requires the release:major label",
        );
        expect(run(major, { PR_LABELS: "release:major" }).code).toBe(0);

        const downgrade = releasedRepo("0.4.36");
        release(downgrade, "0.4.35");
        expect(run(downgrade, { RELEASE_LABELS: "" }).stderr).toContain(
            "Version change 0.4.36 -> 0.4.35 is not a patch, minor, or major upgrade",
        );
    });

    it("fails when a version bump leaves a README pin behind", () => {
        const cwd = releasedRepo("0.4.35");
        release(cwd, "0.4.36", undefined, readme("0.4.35"));
        const result = run(cwd, { RELEASE_LABELS: "" });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("README.md pins @openma/deepseek-harness-acp@0.4.35, expected version 0.4.36");

        const unpinned = releasedRepo("0.4.35");
        release(unpinned, "0.4.36", undefined, readme());
        expect(run(unpinned, { RELEASE_LABELS: "" }).code, run(unpinned, { RELEASE_LABELS: "" }).stderr).toBe(0);
    });
});

describe("release check on a tag", () => {
    it("accepts v0.4.35..v0.4.36 notes and rejects a notes body that drops one pull request", () => {
        const cwd = history();
        writeFileSync(join(cwd, "feature.txt"), "later\n");
        commitAll(cwd, "fix: keep Cursor review prompt substitution literal (#34)");
        const notesPath = join(cwd, "notes.md");
        writeFileSync(notesPath, publishedNotes("32"));

        const ongoing = run(cwd);
        expect(ongoing.code, ongoing.stdout + ongoing.stderr).toBe(0);
        expect(ongoing.stdout).toContain("::notice::Unreleased PRs on main since v0.4.36: #34");
        expect(ongoing.stdout).not.toContain("#32");
        expect(ongoing.stdout).not.toContain("#33");

        const passed = run(cwd, {}, ["--tag", "v0.4.36", "--notes-file", notesPath]);
        expect(passed.code, passed.stdout + passed.stderr).toBe(0);
        expect(passed.stdout).toContain("Release notes for v0.4.36 include #32, #33 since v0.4.35.");
        expect(passed.stdout).toContain("release tag check passed for v0.4.36.");
        expect(passed.stderr).not.toContain("missing PR");

        writeFileSync(notesPath, publishedNotes());
        const omitted = run(cwd, {}, ["--tag", "v0.4.36", "--notes-file", notesPath]);
        expect(omitted.code).toBe(1);
        expect(omitted.stderr).toContain("Release notes for 0.4.36 are missing PR #32");
        expect(omitted.stderr).not.toContain("missing PR #33");
        expect(omitted.stderr).not.toContain("missing PR #34");
    });

    it("requires a merge commit's pull request and ignores commits that are not pull requests", () => {
        const cwd = mergedHistory();
        const notesPath = join(cwd, "notes.md");
        writeFileSync(notesPath, "https://github.com/openma-ai/deepseek-harness-acp/pull/30\n");
        const passed = run(cwd, {}, ["--tag", "v0.4.34", "--notes-file", notesPath]);
        expect(passed.code, passed.stdout + passed.stderr).toBe(0);
        expect(passed.stdout).toContain("include #30 since v0.4.33");

        writeFileSync(notesPath, "Full changelog only, plus #300 and /pull/300.\n");
        const omitted = run(cwd, {}, ["--tag", "v0.4.34", "--notes-file", notesPath]);
        expect(omitted.code).toBe(1);
        expect(omitted.stderr).toContain("missing PR #30");
        expect(omitted.stderr).not.toContain("missing PR #300");
    });

    it("checks the tag name and does not call gh for a patch when notes are provided", () => {
        const cwd = history();
        const notesPath = join(cwd, "notes.md");
        writeFileSync(notesPath, publishedNotes("32"));
        const calls = [];
        const gh = (args) => {
            calls.push(args.join(" "));
            throw new Error("gh should not be called");
        };

        git(cwd, ["tag", "v0.4.99", "v0.4.36"]);
        const mismatch = run(cwd, {}, ["--tag", "v0.4.99", "--notes-file", notesPath], gh);
        expect(mismatch.code).toBe(1);
        expect(mismatch.stderr).toContain("Git tag v0.4.99 does not match package.json version 0.4.36 (expected v0.4.36)");

        const fromEnv = run(cwd, { GITHUB_REF: "refs/tags/v0.4.36" }, ["--tag", "--notes-file", notesPath], gh);
        expect(fromEnv.code, fromEnv.stdout + fromEnv.stderr).toBe(0);

        const passed = run(cwd, {}, ["--tag", "v0.4.36", "--notes-file", notesPath], gh);
        expect(passed.code, passed.stdout + passed.stderr).toBe(0);
        expect(calls).toEqual([]);
    });

    it("reads release:minor from the tagged commit's pull request and prefers published notes", () => {
        const cwd = releasedRepo("0.4.36");
        release(cwd, "0.5.0");
        git(cwd, ["tag", "v0.5.0"]);
        const calls = [];
        const gh = (_cwd, _env, args) => {
            const line = args.join(" ");
            calls.push(line);
            if (line.includes("/commits/") && line.includes("/pulls")) {
                return JSON.stringify([{ number: 40, labels: [{ name: "release:minor" }] }]);
            }
            if (line.includes("release view")) {
                return JSON.stringify({
                    body: "https://github.com/openma-ai/deepseek-harness-acp/pull/32\n",
                });
            }
            if (line.includes("generate-notes")) {
                return JSON.stringify({ body: "generated without #32" });
            }
            throw new Error(`unexpected gh ${line}`);
        };
        writeFileSync(join(cwd, "feature.txt"), "landed\n");
        commitAll(cwd, "chore: upgrade bundled dsh (#32)");
        git(cwd, ["tag", "-f", "v0.5.0"]);

        const missingLabel = run(cwd, { GITHUB_REPOSITORY: "openma-ai/deepseek-harness-acp" }, ["--tag", "v0.5.0"], () => {
            throw new Error("no labels on the commit");
        });
        expect(missingLabel.code).toBe(1);
        expect(missingLabel.stderr).toContain("Minor bump 0.4.36 -> 0.5.0 requires the release:minor label");
        expect(missingLabel.stderr).toContain("no labels on the commit");

        const passed = run(
            cwd,
            { GITHUB_REPOSITORY: "openma-ai/deepseek-harness-acp" },
            ["--tag", "v0.5.0"],
            gh,
        );
        expect(passed.code, passed.stdout + passed.stderr).toBe(0);
        expect(passed.stdout).toContain("Using published release notes for v0.5.0.");
        expect(calls.some((line) => line.includes("generate-notes"))).toBe(false);
        expect(passed.stdout).toContain("include #32 since v0.4.36");
    });

    it("previews generate-notes when the GitHub release does not exist yet", () => {
        const cwd = history();
        const gh = (_cwd, _env, args) => {
            const line = args.join(" ");
            if (line.includes("release view")) throw new Error("release not found");
            if (line.includes("generate-notes")) {
                expect(line).toContain("tag_name=v0.4.36");
                expect(line).toContain("previous_tag_name=v0.4.35");
                return JSON.stringify({ body: publishedNotes("32") });
            }
            throw new Error(`unexpected gh ${line}`);
        };
        const result = run(cwd, { GITHUB_REPOSITORY: "openma-ai/deepseek-harness-acp" }, ["--tag", "v0.4.36"], gh);
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("Using generated release notes for v0.4.36 (no GitHub release yet).");
    });

    it("reports each missing pull request when generate-notes omits one", () => {
        const cwd = history();
        const gh = (_cwd, _env, args) => {
            const line = args.join(" ");
            if (line.includes("release view")) throw new Error("release not found");
            if (line.includes("generate-notes")) return JSON.stringify({ body: publishedNotes() });
            throw new Error(`unexpected gh ${line}`);
        };
        const result = run(cwd, { GITHUB_REPOSITORY: "openma-ai/deepseek-harness-acp" }, ["--tag", "v0.4.36"], gh);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("missing PR #32");
        expect(result.stderr).not.toContain("missing PR #33");
    });
});

describe("release check command", () => {
    it("runs from node and rejects unknown arguments", () => {
        const cwd = releasedRepo("0.4.36");
        const result = spawnCheck(cwd, []);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("No unreleased pull requests on main since v0.4.36.");

        const unknown = run(cwd, {}, ["--publish"]);
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toContain("Unknown arguments: --publish");
        expect(run(cwd, {}, ["--notes-file", "notes.md"]).stderr).toContain("--notes-file is only valid with --tag");
    });
});

function run(cwd, extra = {}, argv = [], gh) {
    const deps = {
        gh: gh ?? (() => {
            throw new Error("gh should not be called");
        }),
    };
    return runReleaseCheck(cwd, extra, argv, deps);
}

function spawnCheck(cwd, args) {
    const env = { ...process.env };
    for (const key of [
        "GITHUB_EVENT_NAME",
        "GITHUB_REF",
        "GITHUB_REF_NAME",
        "GITHUB_BASE_REF",
        "BASE_REF",
        "RELEASE_LABELS",
        "PR_LABELS",
        "GITHUB_ACTIONS",
    ]) {
        delete env[key];
    }
    return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
}

function releasedRepo(version) {
    const cwd = mkdtempSync(join(tmpdir(), "dsh-acp-release-"));
    roots.push(cwd);
    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["config", "user.email", "release-check@example.com"]);
    git(cwd, ["config", "user.name", "release-check"]);
    git(cwd, ["config", "commit.gpgsign", "false"]);
    writePackage(cwd, version);
    writeFileSync(join(cwd, "README.md"), readme());
    commitAll(cwd, `release: v${version}`);
    git(cwd, ["tag", `v${version}`]);
    return cwd;
}

function history() {
    const cwd = releasedRepo("0.4.35");
    writeFileSync(join(cwd, "feature.txt"), "32\n");
    commitAll(cwd, "chore: upgrade bundled dsh to 0.2.0-rc.2 (#32)");
    writeFileSync(join(cwd, "feature.txt"), "33\n");
    commitAll(cwd, "feat: auto-dispatch Cursor agent for dsh upgrade compatibility review (#33)");
    writePackage(cwd, "0.4.36");
    commitAll(cwd, "release: v0.4.36");
    git(cwd, ["tag", "v0.4.36"]);
    return cwd;
}

function mergedHistory() {
    const cwd = releasedRepo("0.4.33");
    git(cwd, ["checkout", "-b", "feature"]);
    writeFileSync(join(cwd, "feature.txt"), "side\n");
    commitAll(cwd, "fix: support dsh 0.1.7 and stream live tool output");
    git(cwd, ["checkout", "main"]);
    git(cwd, ["merge", "--no-ff", "-m", "Merge pull request #30 from openma-ai/fix/dsh-0.1.7-permission", "feature"]);
    writePackage(cwd, "0.4.34");
    commitAll(cwd, "release: v0.4.34");
    git(cwd, ["tag", "v0.4.34"]);
    return cwd;
}

function release(cwd, version, lock, readmeText = readme()) {
    git(cwd, ["checkout", "-b", "release"]);
    writePackage(cwd, version, lock);
    writeFileSync(join(cwd, "README.md"), readmeText);
    commitAll(cwd, `release: v${version}`);
}

function writePackage(cwd, version, lock = { root: version, nested: version }) {
    writeFileSync(
        join(cwd, "package.json"),
        `${JSON.stringify({ name: "@openma/deepseek-harness-acp", version }, null, 2)}\n`,
    );
    writeFileSync(
        join(cwd, "package-lock.json"),
        `${JSON.stringify({
            name: "@openma/deepseek-harness-acp",
            version: lock.root,
            lockfileVersion: 3,
            packages: { "": { name: "@openma/deepseek-harness-acp", version: lock.nested } },
        }, null, 2)}\n`,
    );
}

function readme(pin) {
    const install = pin
        ? `dsh plugin --profile acp add @openma/deepseek-harness-acp@${pin}`
        : "dsh plugin --profile acp add @openma/deepseek-harness-acp@latest";
    return `The bundled runtime is DSH \`0.1.5-rc.1\`.\n\n${install}\n`;
}

function publishedNotes(include32 = "") {
    const upgrade = include32
        ? "* chore: upgrade bundled dsh to 0.2.0-rc.2 by @github-actions[bot] in https://github.com/openma-ai/deepseek-harness-acp/pull/32\n"
        : "";
    return `## What's Changed
* feat: auto-dispatch Cursor agent for dsh upgrade compatibility review by @hrhrng in https://github.com/openma-ai/deepseek-harness-acp/pull/33
${upgrade}
**Full Changelog**: https://github.com/openma-ai/deepseek-harness-acp/compare/v0.4.35...v0.4.36
`;
}

function commitAll(cwd, message) {
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", message]);
}

function git(cwd, args) {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
