import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Upgrade the bundled @deepseek-ai/dsh to the latest dist-tag and refresh
 * the compatibility matrix. The manifest logic takes injectable seams so
 * the release path is covered by unit tests (issue #157).
 */
function packagePublishesVersion(npm, name, version) {
    try {
        const published = npm(["view", name, "versions"]);
        const list = Array.isArray(published) ? published : [published];
        return list.includes(version);
    } catch {
        return false;
    }
}

export function updateDshManifests({ npm, fs, env = process.env, log = console.log }) {
    const manifest = fs.readJson("package.json");
    const latest = npm(["view", "@deepseek-ai/dsh", "dist-tags.latest"]);
    const supported = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
    if (!supported.test(latest)) throw new Error(`Refusing non-release dsh dist-tag: ${latest}`);
    if (latest === manifest.dshAcp.standaloneDsh) {
        log(`Bundled dsh is already ${latest}`);
        return { changed: false };
    }
    const versions = npm(["view", "@deepseek-ai/dsh", "versions"]);
    const latestIndex = versions.indexOf(latest);
    if (latestIndex < 0) throw new Error("Latest dist-tag is absent from published versions");
    if (versions.indexOf(manifest.dshAcp.standaloneDsh) > latestIndex) {
        log("Bundled dsh is newer than the latest dist-tag; refusing to downgrade");
        return { changed: false };
    }
    const matrix = versions.slice(0, latestIndex + 1).filter((version) => supported.test(version)).slice(-3);
    if (matrix.length !== 3) throw new Error("Need three published release/RC versions");
    const previous = manifest.dshAcp.standaloneDsh;
    manifest.dshAcp.standaloneDsh = latest;
    // The declared compatibility is a minimum-version floor (`engines.dsh`),
    // not the tested matrix: newer dsh releases stay attempted.
    // Raising the floor is a deliberate maintainer change, never automatic.
    for (const name of Object.keys(manifest.devDependencies)) {
        if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
        // Some @deepseek-ai/dsh-* packages lag the CLI release (e.g. dsh-invariants
        // stopped at 0.2.0-rc.2). Only rewrite pins that actually publish `latest`.
        if (!packagePublishesVersion(npm, name, latest)) {
            log(`Keeping ${name}@${manifest.devDependencies[name]} (no ${latest} on npm)`);
            continue;
        }
        manifest.devDependencies[name] = latest;
    }
    const runtime = fs.readJson("runtime/package.json");
    runtime.dependencies["@deepseek-ai/dsh"] = latest;
    fs.writeJson("package.json", manifest);
    fs.writeJson("runtime/package.json", runtime);
    // Single-line: CI feeds this file into GITHUB_OUTPUT / fromJSON matrices.
    fs.writeText("runtime/compatibility.json", `${JSON.stringify(matrix)}\n`);
    log(`Upgrade dsh ${previous} -> ${latest}; profile matrix: ${matrix.join(", ")}`);
    if (env.GITHUB_OUTPUT) fs.append(env.GITHUB_OUTPUT, `changed=true\nversion=${latest}\nprevious=${previous}\n`);
    return { changed: true, latest, previous, matrix };
}

const realSeams = {
    npm: (args) => JSON.parse(execFileSync("npm", [...args, "--json", "--registry=https://registry.npmjs.org"], { encoding: "utf8" })),
    fs: {
        readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
        writeJson: (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`),
        writeText: (path, text) => writeFileSync(path, text),
        append: (path, text) => appendFileSync(path, text),
    },
};

const invokedDirectly = typeof process.argv[1] === "string"
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
    updateDshManifests(realSeams);
}
