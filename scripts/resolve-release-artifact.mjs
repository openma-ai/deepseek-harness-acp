import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve an artifact path to a form npm cannot interpret as a GitHub
 * owner/repository shorthand.
 */
export function resolveReleaseArtifact(input, { cwd = process.cwd() } = {}) {
    if (typeof input !== "string" || input.length === 0) {
        throw new Error("release artifact path is required");
    }

    const artifact = resolve(cwd, input);
    if (!artifact.endsWith(".tgz")) {
        throw new Error(`release artifact is not an npm tarball: ${input}`);
    }

    let stats;
    try {
        stats = statSync(artifact);
    } catch {
        throw new Error(`release artifact does not exist: ${input}`);
    }
    if (!stats.isFile()) {
        throw new Error(`release artifact is not a file: ${input}`);
    }

    return artifact;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.stdout.write(`${resolveReleaseArtifact(process.argv[2])}\n`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
