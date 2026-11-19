#!/usr/bin/env node
/** Publish one tested tarball, tolerating only a digest-verified immutable retry. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { verifyPublishedArtifact } from "./wait-for-runtime-registry.mjs";

const execFileAsync = promisify(execFile);
const conflictPattern = /(?:E(?:PUBLISH)?CONFLICT|cannot publish over(?: the)? previously published versions|previously published versions|already published|cannot overwrite|version already exists)/i;

export function isAlreadyPublishedConflict(error) {
    const text = [error?.code, error?.status, error?.message, error?.stderr, error?.stdout].filter(Boolean).join(" ");
    return Number(error?.status) === 409 || conflictPattern.test(text);
}

export async function publishReleaseArtifact({ tarball, tag, registryBaseUrl, publishImpl = defaultPublish, fetchImpl = fetch }) {
    const absoluteTarball = resolve(tarball);
    try {
        await publishImpl(absoluteTarball, tag);
        return { published: true, verifiedExisting: false };
    } catch (error) {
        if (!isAlreadyPublishedConflict(error)) throw error;
        const verification = await verifyPublishedArtifact({ tarball: absoluteTarball, registryBaseUrl, fetchImpl });
        return { published: false, verifiedExisting: Boolean(verification), pendingVisibility: !verification };
    }
}

async function defaultPublish(tarball, tag) {
    try {
        const result = await execFileAsync("npm", ["publish", tarball, "--tag", tag], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
    } catch (error) {
        if (error.stdout) process.stdout.write(error.stdout);
        if (error.stderr) process.stderr.write(error.stderr);
        throw error;
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
    const tarball = value("--tarball");
    const tag = value("--tag") || "latest";
    if (!tarball) { console.error("usage: node scripts/publish-release-artifact.mjs --tarball <file.tgz> --tag <tag>"); process.exit(2); }
    await publishReleaseArtifact({ tarball, tag, registryBaseUrl: value("--registry") });
}
