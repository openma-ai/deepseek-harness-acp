#!/usr/bin/env node
/**
 * Confirm the slim shell tarball and the runtime package tarball are a
 * matched pair: same version, identical runtime.json, and the sha256 in
 * that manifest equals the archive carried inside the runtime package.
 *
 * Used after `npm pack` (which runs prepack) and again immediately before
 * `npm publish`, so a stale vendor/ tree cannot be released.
 *
 * Usage:
 *   node scripts/verify-release-artifacts.mjs --shell <shell.tgz> --runtime <runtime.tgz>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listTarball, readTarGzEntries } from "./list-tarball.mjs";
import { RUNTIME_PACKAGE_NAME } from "./runtime-package.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const shell = flag("--shell") && resolve(flag("--shell"));
const runtime = flag("--runtime") && resolve(flag("--runtime"));
if (!shell || !runtime) {
    console.error("usage: node scripts/verify-release-artifacts.mjs --shell <shell.tgz> --runtime <runtime.tgz>");
    process.exit(2);
}
if (!existsSync(shell)) throw new Error(`missing shell tarball: ${shell}`);
if (!existsSync(runtime)) throw new Error(`missing runtime tarball: ${runtime}`);

const shellEntries = listTarball(shell);
assert(!shellEntries.some((p) => p.endsWith("dsh-runtime.tgz")), `${shell} still contains dsh-runtime.tgz`);
assert(shellEntries.includes("package/vendor/runtime.json"), `${shell} is missing vendor/runtime.json`);

const shellFiles = readTarGzEntries(shell, ["package/package.json", "package/vendor/runtime.json"]);
const runtimeFiles = readTarGzEntries(runtime, [
    "package/package.json",
    "package/runtime.json",
    "package/dsh-runtime.tgz",
]);

function json(map, name) {
    const buf = map.get(name);
    assert(buf, `missing ${name}`);
    return JSON.parse(buf.toString("utf8"));
}

const shellPkg = json(shellFiles, "package/package.json");
const runtimePkg = json(runtimeFiles, "package/package.json");
const shellManifest = json(shellFiles, "package/vendor/runtime.json");
const runtimeManifest = json(runtimeFiles, "package/runtime.json");
const archive = runtimeFiles.get("package/dsh-runtime.tgz");
assert(archive && archive.length > 0, "runtime package is missing dsh-runtime.tgz");

assert.equal(shellPkg.name, "@openma/deepseek-harness-acp");
assert.equal(runtimePkg.name, RUNTIME_PACKAGE_NAME);
assert.equal(runtimePkg.version, shellPkg.version, "runtime package version must match the shell");
assert.equal(shellManifest.runtimePackage?.name, RUNTIME_PACKAGE_NAME);
assert.equal(shellManifest.runtimePackage?.version, shellPkg.version);
assert.deepEqual(runtimeManifest, shellManifest, "shell and runtime package must carry the same runtime.json");

const sha256 = createHash("sha256").update(archive).digest("hex");
assert.equal(shellManifest.sha256, sha256, "runtime.json sha256 does not match the packed archive");

console.log(`VERIFY_RELEASE_ARTIFACTS_OK ${shellPkg.name}@${shellPkg.version} + ${runtimePkg.name}@${runtimePkg.version} sha256=${sha256}`);
