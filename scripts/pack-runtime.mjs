import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { completePlatformPackages, pruneExternalPackages } from "./runtime-platforms.mjs";
import { externalPackageRecords, packRuntimePackage, RUNTIME_PACKAGE_NAME } from "./runtime-package.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dshVersion = manifest.dshAcp?.standaloneDsh;
if (typeof dshVersion !== "string" || dshVersion.length === 0) {
    throw new Error("package.json dshAcp.standaloneDsh must be an exact version");
}

const runtimeManifest = JSON.parse(readFileSync(join(root, "runtime/package.json"), "utf8"));
if (runtimeManifest.dependencies?.["@deepseek-ai/dsh"] !== dshVersion) {
    throw new Error("runtime/package.json must match package.json dshAcp.standaloneDsh");
}

/**
 * The native packages pruned from the runtime archive.
 *
 * They are per-platform binaries (libreoffice-kit, sherpa-onnx) that npm
 * installs for the host platform only. The shell no longer carries them as
 * optional dependencies — a plugin install must not download them — so the
 * standalone launcher fetches the matching ones itself, from the registry,
 * at the exact locked versions recorded in the pinned manifest.
 */

const staging = mkdtempSync(join(tmpdir(), "dsh-acp-runtime-"));
const vendor = join(root, "vendor");
const archive = join(vendor, "dsh-runtime.tgz");
try {
    copyFileSync(join(root, "runtime/package.json"), join(staging, "package.json"));
    copyFileSync(join(root, "runtime/package-lock.json"), join(staging, "package-lock.json"));
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: staging,
        stdio: "inherit",
    });
    await completePlatformPackages(staging);
    pruneExternalPackages(staging);
    const lock = JSON.parse(readFileSync(join(root, "runtime/package-lock.json"), "utf8"));
    const externalPackages = externalPackageRecords(lock);
    if (Object.keys(externalPackages).length === 0) {
        throw new Error("runtime/package-lock.json declares no external native packages");
    }
    mkdirSync(vendor, { recursive: true });
    await tar.c(
        {
            cwd: staging,
            file: archive,
            gzip: true,
            portable: true,
        },
        ["package.json", "package-lock.json", "node_modules"],
    );
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    // The manifest is the only thing the slim shell ships: it pins the exact
    // dsh build, the archive checksum, the native packages, and the runtime
    // package the standalone launcher acquires the archive from.
    writeFileSync(
        join(vendor, "runtime.json"),
        `${JSON.stringify({
            archive: "dsh-runtime.tgz",
            dsh: dshVersion,
            sha256,
            runtimePackage: { name: RUNTIME_PACKAGE_NAME, version: manifest.version },
            externalPackages,
        }, null, 2)}\n`,
    );
    // The runtime ships as its own npm package: the shell tarball stays slim
    // and the standalone launcher fetches this artifact by exact version.
    const runtimePackage = packRuntimePackage({ root, vendor, shellVersion: manifest.version });
    console.log(`runtime package: ${runtimePackage}`);
} finally {
    rmSync(staging, { recursive: true, force: true });
}
