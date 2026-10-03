/**
 * Release gate for @openma/deepseek-harness-acp.
 *
 * Version commits stay `release: vX.Y.Z` on main and only need package.json
 * plus package-lock.json. This repo has no changelog: `release.yml` publishes
 * the GitHub Release with `gh release create --generate-notes`.
 *
 * On pull requests and other non-tag CI runs, print one non-blocking notice
 * listing pull requests merged to the base branch since the previous v* tag.
 * If the tree changes package.json "version", also require:
 * - package-lock.json version and packages[""].version match
 * - README pins of this package, when any exist, match (no pin is fine;
 *   `@latest` is not a pin; the bundled DSH version is not this package)
 * - the bump is a patch, unless labels include release:minor or release:major
 *
 * `node scripts/release-check.mjs --tag` checks a v* tag before npm publish:
 * - the tag is v plus package.json version
 * - the lockfile and any README pin agree
 * - a minor bump has release:minor, a major bump has release:major
 *   (labels come from RELEASE_LABELS / PR_LABELS, or from a pull request
 *   associated with the tagged commit)
 * - the release notes list every pull request merged since the previous tag
 *   (`(#N)` squash subjects and `Merge pull request #N` merge commits;
 *   `release: vX.Y.Z` itself is not a pull request)
 *
 * Notes are read from --notes-file, else the published GitHub Release body,
 * else the generate-notes preview used by `gh release create --generate-notes`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/;
const VERSION_SOURCE = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?`;
const SQUASH_PR = /\(#(\d+)\)/g;
const MERGE_PR = /^Merge pull request #(\d+)\b/;

export function classifyBump(from, to) {
    const previous = parseVersion(from);
    const next = parseVersion(to);
    if (!previous || !next) {
        return {
            kind: "invalid",
            reason: `Cannot classify bump ${from} -> ${to}; versions must be major.minor.patch with an optional prerelease`,
        };
    }
    if (previous.raw === next.raw) return { kind: "same" };
    if (next.major !== previous.major) {
        return next.major > previous.major
            ? { kind: "major" }
            : invalidBump(from, to);
    }
    if (next.minor !== previous.minor) {
        return next.minor > previous.minor
            ? { kind: "minor" }
            : invalidBump(from, to);
    }
    if (next.patch !== previous.patch) {
        return next.patch > previous.patch
            ? { kind: "patch" }
            : invalidBump(from, to);
    }
    const order = comparePrerelease(previous.prerelease, next.prerelease);
    if (order < 0) return { kind: "patch" };
    return invalidBump(from, to);
}

export function extractPullRequests(subjects) {
    const seen = new Set();
    const numbers = [];
    const add = (value) => {
        const number = Number(value);
        if (seen.has(number)) return;
        seen.add(number);
        numbers.push(number);
    };
    for (const subject of subjects) {
        const merge = MERGE_PR.exec(subject);
        if (merge?.[1]) add(merge[1]);
        for (const match of subject.matchAll(SQUASH_PR)) {
            if (match[1]) add(match[1]);
        }
    }
    return numbers.sort((left, right) => left - right);
}

export function mentionsPullRequest(notes, number) {
    const token = String(number);
    if (!/^\d+$/.test(token)) return false;
    const hash = new RegExp(`(?:^|[^0-9])#${token}(?![0-9])`);
    const pull = new RegExp(`/pulls?/${token}(?![0-9])`);
    return hash.test(notes) || pull.test(notes);
}

export function readmePinErrors(readme, version) {
    const patterns = [
        new RegExp(`@openma\\/deepseek-harness-acp@(${VERSION_SOURCE})`, "g"),
        new RegExp(`github:openma-ai\\/deepseek-harness-acp#v(${VERSION_SOURCE})`, "g"),
    ];
    const errors = [];
    for (const pattern of patterns) {
        for (const match of readme.matchAll(pattern)) {
            const pin = match[1];
            if (pin !== version) {
                errors.push(`README.md pins ${match[0]}, expected version ${version}`);
            }
        }
    }
    return errors;
}

export function githubRepository(remoteUrl) {
    const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
    if (!match?.[1] || !match?.[2]) return null;
    return `${match[1]}/${match[2].replace(/\.git$/, "")}`;
}

export function runReleaseCheck(cwd, env, argv, deps = {}) {
    const report = createReport(env);
    const io = {
        git: deps.git ?? defaultGit,
        gh: deps.gh ?? defaultGh,
    };
    try {
        const options = parseArgs(argv);
        if (options.tag) checkTag(cwd, env, io, report, options);
        else checkOngoing(cwd, env, io, report);
        return report.done(report.errors ? 1 : 0);
    } catch (error) {
        report.error(message(error));
        return report.done(1);
    }
}

function checkOngoing(cwd, env, io, report) {
    const headVersion = readPackageVersion(cwd);
    const base = resolveBase(cwd, env, io);
    const baseVersion = packageVersionAt(io, cwd, base.ref);
    const previousTag = gitOrNull(io, cwd, ["describe", "--tags", "--abbrev=0", "--match", "v*", base.ref]);
    const subjects = previousTag ? subjectsBetween(io, cwd, previousTag, base.ref) : [];
    const numbers = extractPullRequests(subjects);
    if (!previousTag) {
        report.notice(`No previous v* tag is reachable from ${base.name}; unreleased pull requests were not listed.`);
    } else if (numbers.length > 0) {
        const listed = numbers.map((number) => `#${number}`).join(", ");
        report.notice(`Unreleased PRs on ${base.name} since ${previousTag}: ${listed}`);
    } else {
        report.log(`No unreleased pull requests on ${base.name} since ${previousTag}.`);
    }

    if (headVersion === baseVersion) {
        report.log(`package.json version is unchanged (${headVersion}); release gate skipped.`);
        return;
    }

    let lock = null;
    try {
        lock = readLock(cwd);
    } catch (error) {
        report.error(message(error));
    }
    reportErrors(report, consistencyErrors(cwd, headVersion, lock, readText(join(cwd, "README.md"))));
    const found = labelsFor(cwd, env, io, headRevision(io, cwd), classifyBump(baseVersion, headVersion).kind);
    reportErrors(report, bumpErrors(baseVersion, headVersion, found.labels, found.detail));
    if (report.errors === 0) {
        report.log(`Release check passed for ${baseVersion} -> ${headVersion}.`);
    }
}

function checkTag(cwd, env, io, report, options) {
    const tag = resolveTag(cwd, env, io, options.tagName);
    const sha = io.git(cwd, ["rev-parse", "--verify", `${tag}^{commit}`]);
    const version = versionOf(jsonAt(io, cwd, tag, "package.json"), `${tag}:package.json`);
    if (tag !== `v${version}`) {
        report.error(`Git tag ${tag} does not match package.json version ${version} (expected v${version})`);
    }
    const lockText = textAt(io, cwd, tag, "package-lock.json");
    let lock = null;
    if (lockText == null) report.error(`${tag}:package-lock.json does not exist`);
    else {
        try {
            lock = parseJson(lockText, `${tag}:package-lock.json`);
        } catch (error) {
            report.error(message(error));
        }
    }
    reportErrors(report, consistencyErrors(cwd, version, lock, textAt(io, cwd, tag, "README.md")));

    const previousTag = gitOrNull(io, cwd, ["describe", "--tags", "--abbrev=0", "--match", "v*", `${tag}^`]);
    if (!previousTag) {
        report.error(`No previous v* tag is reachable from ${tag}`);
        return;
    }
    const previousVersion = versionOf(jsonAt(io, cwd, previousTag, "package.json"), `${previousTag}:package.json`);
    const bump = classifyBump(previousVersion, version);
    const found = labelsFor(cwd, env, io, sha, bump.kind);
    reportErrors(report, bumpErrors(previousVersion, version, found.labels, found.detail));

    const numbers = extractPullRequests(subjectsBetween(io, cwd, previousTag, tag));
    let notes = null;
    try {
        notes = loadNotes(cwd, env, io, report, tag, previousTag, sha, options.notesFile);
    } catch (error) {
        report.error(message(error));
    }
    const haystack = notes ?? "";
    for (const number of numbers) {
        if (!mentionsPullRequest(haystack, number)) {
            report.error(`Release notes for ${version} are missing PR #${number}`);
        }
    }
    if (report.errors === 0) {
        const listed = numbers.length > 0 ? numbers.map((number) => `#${number}`).join(", ") : "no pull requests";
        report.log(`Release notes for ${tag} include ${listed} since ${previousTag}.`);
        report.log(`release tag check passed for ${tag}.`);
    }
}

function loadNotes(cwd, env, io, report, tag, previousTag, sha, notesFile) {
    if (notesFile) {
        const path = resolve(cwd, notesFile);
        try {
            const text = readFileSync(path, "utf8");
            report.log(`Using release notes from ${notesFile}.`);
            return text;
        } catch (error) {
            throw new Error(`Cannot read release notes file ${notesFile}: ${message(error)}`);
        }
    }
    const repo = repository(cwd, env, io);
    try {
        const stdout = io.gh(cwd, env, ["release", "view", tag, "--repo", repo, "--json", "body"]);
        const parsed = JSON.parse(stdout);
        const body = typeof parsed.body === "string" ? parsed.body : "";
        report.log(`Using published release notes for ${tag}.`);
        return body;
    } catch (error) {
        if (!/not found/i.test(message(error))) throw error;
    }
    const stdout = io.gh(cwd, env, [
        "api",
        "--method",
        "POST",
        `repos/${repo}/releases/generate-notes`,
        "-f",
        `tag_name=${tag}`,
        "-f",
        `previous_tag_name=${previousTag}`,
        "-f",
        `target_commitish=${sha}`,
    ]);
    const parsed = JSON.parse(stdout);
    if (typeof parsed.body !== "string") {
        throw new Error(`generate-notes response for ${tag} has no body`);
    }
    report.log(`Using generated release notes for ${tag} (no GitHub release yet).`);
    return parsed.body;
}

function labelsFor(cwd, env, io, sha, kind) {
    const explicit = explicitLabels(env);
    if (explicit) return { labels: explicit.labels, detail: "" };
    if (kind !== "minor" && kind !== "major") return { labels: [], detail: "" };
    try {
        return { labels: discoverLabels(cwd, env, io, sha), detail: "" };
    } catch (error) {
        return { labels: [], detail: message(error) };
    }
}

function explicitLabels(env) {
    if (Object.hasOwn(env, "RELEASE_LABELS")) return { labels: splitLabels(env.RELEASE_LABELS) };
    if (Object.hasOwn(env, "PR_LABELS")) return { labels: splitLabels(env.PR_LABELS) };
    return null;
}

function discoverLabels(cwd, env, io, sha) {
    const repo = repository(cwd, env, io);
    const stdout = io.gh(cwd, env, [
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${repo}/commits/${sha}/pulls`,
    ]);
    const pulls = JSON.parse(stdout);
    if (!Array.isArray(pulls)) throw new Error(`Pull requests for ${sha} were not a list`);
    const labels = [];
    for (const pull of pulls) {
        for (const label of pull.labels ?? []) {
            if (typeof label?.name === "string" && label.name.length > 0) labels.push(label.name);
        }
    }
    return labels;
}

function consistencyErrors(_cwd, version, lock, readme) {
    const errors = [];
    if (lock) {
        if (lock.version !== version) {
            errors.push(`package-lock.json version is ${shown(lock.version)}, expected ${version}`);
        }
        const nested = lock.packages?.[""]?.version;
        if (nested !== version) {
            errors.push(`package-lock.json packages[""].version is ${shown(nested)}, expected ${version}`);
        }
    }
    errors.push(...readmePinErrors(readme ?? "", version));
    return errors;
}

function bumpErrors(from, to, labels, detail = "") {
    const bump = classifyBump(from, to);
    if (bump.kind === "invalid") return [bump.reason];
    const suffix = detail ? ` (${detail})` : "";
    if (bump.kind === "minor" && !labels.includes("release:minor")) {
        return [`Minor bump ${from} -> ${to} requires the release:minor label${suffix}`];
    }
    if (bump.kind === "major" && !labels.includes("release:major")) {
        return [`Major bump ${from} -> ${to} requires the release:major label${suffix}`];
    }
    return [];
}

function parseArgs(argv) {
    const args = [...argv];
    let tag = false;
    let tagName = "";
    let notesFile = "";
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === "--tag") {
            tag = true;
            if (args[0] && !args[0].startsWith("--")) tagName = args.shift() ?? "";
            continue;
        }
        if (arg === "--notes-file") {
            notesFile = args.shift() ?? "";
            if (!notesFile) throw new Error("--notes-file requires a path");
            continue;
        }
        throw new Error(`Unknown arguments: ${argv.join(" ")}`);
    }
    if (notesFile && !tag) throw new Error("--notes-file is only valid with --tag");
    return { tag, tagName, notesFile };
}

function resolveTag(cwd, env, io, requested) {
    if (requested) return requested;
    const ref = env.GITHUB_REF ?? "";
    if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
    if (env.GITHUB_REF_NAME && ref === "") return env.GITHUB_REF_NAME;
    const exact = gitOrNull(io, cwd, ["describe", "--tags", "--exact-match", "HEAD"]);
    if (exact) return exact;
    throw new Error("Cannot determine the release tag (pass --tag vX.Y.Z or set GITHUB_REF)");
}

function resolveBase(cwd, env, io) {
    const name = baseName(env);
    for (const ref of [`origin/${name}`, name]) {
        if (gitOrNull(io, cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) {
            return { name, ref };
        }
    }
    throw new Error(`Cannot resolve base ref ${name}`);
}

function baseName(env) {
    if (typeof env.BASE_REF === "string" && env.BASE_REF.length > 0) return env.BASE_REF;
    if (env.GITHUB_EVENT_NAME === "pull_request" && typeof env.GITHUB_BASE_REF === "string" && env.GITHUB_BASE_REF.length > 0) {
        return env.GITHUB_BASE_REF;
    }
    return "main";
}

function subjectsBetween(io, cwd, from, to) {
    const raw = io.git(cwd, ["log", "--format=%s", `${from}..${to}`]);
    if (!raw) return [];
    return raw.split("\n").filter((line) => line.length > 0);
}

function repository(cwd, env, io) {
    if (typeof env.GITHUB_REPOSITORY === "string" && env.GITHUB_REPOSITORY.length > 0) return env.GITHUB_REPOSITORY;
    const remote = io.git(cwd, ["remote", "get-url", "origin"]);
    const slug = githubRepository(remote);
    if (!slug) throw new Error(`Cannot determine GitHub repository from origin remote ${remote}`);
    return slug;
}

function readPackageVersion(cwd) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    } catch (error) {
        throw new Error(`Cannot read package.json: ${message(error)}`);
    }
    return versionOf(parsed, "package.json");
}

function packageVersionAt(io, cwd, ref) {
    return versionOf(jsonAt(io, cwd, ref, "package.json"), `${ref}:package.json`);
}

function readLock(cwd) {
    let text;
    try {
        text = readFileSync(join(cwd, "package-lock.json"), "utf8");
    } catch (error) {
        throw new Error(`Cannot read package-lock.json: ${message(error)}`);
    }
    return parseJson(text, "package-lock.json");
}

function readText(path) {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

function headRevision(io, cwd) {
    return io.git(cwd, ["rev-parse", "HEAD"]);
}

function jsonAt(io, cwd, rev, file) {
    const text = textAt(io, cwd, rev, file);
    if (text == null) throw new Error(`${rev}:${file} does not exist`);
    return parseJson(text, `${rev}:${file}`);
}

function textAt(io, cwd, rev, file) {
    try {
        return io.git(cwd, ["show", `${rev}:${file}`]);
    } catch {
        return null;
    }
}

function parseJson(text, label) {
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${message(error)}`);
    }
}

function versionOf(manifest, label) {
    if (typeof manifest?.version !== "string" || manifest.version.length === 0) {
        throw new Error(`${label} version must be a non-empty string`);
    }
    return manifest.version;
}

function parseVersion(version) {
    const match = VERSION_RE.exec(version);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ?? "",
        raw: version,
    };
}

function comparePrerelease(left, right) {
    if (left === right) return 0;
    if (left === "") return 1;
    if (right === "") return -1;
    const a = left.split(".");
    const b = right.split(".");
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const ap = a[index];
        const bp = b[index];
        if (ap === undefined) return -1;
        if (bp === undefined) return 1;
        const an = /^\d+$/.test(ap);
        const bn = /^\d+$/.test(bp);
        if (an && bn) {
            const delta = Number(ap) - Number(bp);
            if (delta !== 0) return delta < 0 ? -1 : 1;
        } else if (an !== bn) {
            return an ? -1 : 1;
        } else if (ap !== bp) {
            return ap < bp ? -1 : 1;
        }
    }
    return 0;
}

function invalidBump(from, to) {
    return {
        kind: "invalid",
        reason: `Version change ${from} -> ${to} is not a patch, minor, or major upgrade`,
    };
}

function splitLabels(value) {
    return String(value ?? "")
        .split(",")
        .map((label) => label.trim())
        .filter((label) => label.length > 0);
}

function reportErrors(report, errors) {
    for (const error of errors) report.error(error);
}

function gitOrNull(io, cwd, args) {
    try {
        const value = io.git(cwd, args);
        return value.length > 0 ? value : null;
    } catch {
        return null;
    }
}

function defaultGit(cwd, args) {
    return capture("git", args, cwd, process.env);
}

function defaultGh(cwd, env, args) {
    const ghEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" };
    if (Object.hasOwn(env, "GH_TOKEN")) ghEnv.GH_TOKEN = env.GH_TOKEN;
    if (Object.hasOwn(env, "GITHUB_TOKEN")) ghEnv.GITHUB_TOKEN = env.GITHUB_TOKEN;
    return capture("gh", args, cwd, ghEnv);
}

function capture(command, args, cwd, env) {
    try {
        return execFileSync(command, args, {
            cwd,
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 20_000,
        }).trim();
    } catch (error) {
        const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "").trim() : "";
        const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "").trim() : "";
        const detail = stderr || stdout || message(error);
        throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
    }
}

function shown(value) {
    if (value === undefined) return "missing";
    return JSON.stringify(value);
}

function message(error) {
    return error instanceof Error ? error.message : String(error);
}

function createReport(env) {
    const out = [];
    const err = [];
    const actions = env.GITHUB_ACTIONS === "true";
    const escape = (value) => actions
        ? value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
        : value;
    return {
        errors: 0,
        notice(text) {
            out.push(`::notice::${escape(text)}`);
        },
        error(text) {
            this.errors += 1;
            out.push(`::error::${escape(text)}`);
            err.push(`release-check: ${text}`);
        },
        log(text) {
            out.push(text);
        },
        done(code) {
            return {
                code,
                stdout: out.length > 0 ? `${out.join("\n")}\n` : "",
                stderr: err.length > 0 ? `${err.join("\n")}\n` : "",
            };
        },
    };
}

const invokedDirectly = typeof process.argv[1] === "string"
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
    const result = runReleaseCheck(process.cwd(), process.env, process.argv.slice(2));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
}
