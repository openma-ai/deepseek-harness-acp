/**
 * The publishable standalone-runtime package.
 *
 * The ACP shell ships without the private DeepSeek Harness runtime: a plugin
 * install must stay light and must never download or load it. The standalone
 * launcher acquires the same pinned runtime from a separate npm package
 * instead, so the runtime travels as its own artifact.
 *
 * The manifest is generated at pack time: its version always matches the
 * shell it ships with, and it carries no install lifecycle script (dsh plugin
 * add installs with pnpm, which refuses preinstall/install/postinstall).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The npm package the standalone launcher fetches its runtime from. */
export const RUNTIME_PACKAGE_NAME = "@openma/deepseek-harness-acp-runtime";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The publishable manifest of the runtime package.
 *
 * @param {string} shellVersion - the ACP shell version; the runtime package
 *   ships the same version so the two artifacts are paired by version.
 */
export function runtimePackageManifest(shellVersion) {
    if (typeof shellVersion !== "string" || !EXACT_VERSION.test(shellVersion)) {
        throw new Error(`runtime package version must be an exact version, got ${String(shellVersion)}`);
    }
    return {
        name: RUNTIME_PACKAGE_NAME,
        version: shellVersion,
        description:
            "Pinned DeepSeek Harness runtime for @openma/deepseek-harness-acp — the standalone ACP launcher acquires it from here.",
        license: "Apache-2.0",
        publishConfig: { access: "public" },
        files: ["dsh-runtime.tgz", "runtime.json"],
        engines: { node: ">=22.15" },
    };
}

/** The file name `npm pack` gives the runtime package. */
export function runtimePackageTarballName(shellVersion) {
    return `${RUNTIME_PACKAGE_NAME.replace("@", "").replace("/", "-")}-${shellVersion}.tgz`;
}

/**
 * The native packages pruned from the runtime archive.
 *
 * They are per-platform binaries (libreoffice-kit, sherpa-onnx) that npm
 * installs for the host platform only. The shell no longer carries them as
 * optional dependencies — a plugin install must not download them — so the
 * standalone launcher fetches the matching ones itself, from the registry,
 * at the exact locked versions recorded here.
 *
 * @param {object} lock - a package-lock.json (the runtime staging lock).
 * @returns {Record<string, {version: string, integrity?: string, os?: string[], cpu?: string[]}>}
 */
export function externalPackageRecords(lock) {
    const records = {};
    for (const [path, pkg] of Object.entries(lock?.packages ?? {})) {
        if (!pkg.optional || typeof pkg.version !== "string") continue;
        if (
            !path.startsWith("node_modules/@deepseek-ai/libreoffice-kit-")
            && !path.startsWith("node_modules/sherpa-onnx-")
        ) continue;
        const name = path.slice("node_modules/".length);
        if (name.startsWith("@") ? name.split("/").length !== 2 : name.includes("/")) continue;
        records[name] = {
            version: pkg.version,
            ...(typeof pkg.integrity === "string" ? { integrity: pkg.integrity } : {}),
            ...(Array.isArray(pkg.os) ? { os: pkg.os } : {}),
            ...(Array.isArray(pkg.cpu) ? { cpu: pkg.cpu } : {}),
        };
    }
    return records;
}

/**
 * Refuse to pack (or republish) a runtime package whose manifest does not
 * match the archive it claims to carry, or whose version drifted from the
 * shell. The pair is generated together at pack time; this check is what
 * keeps a stale vendor/ tree from being published.
 */
export function assertRuntimeManifest({ archive, manifestPath, shellVersion }) {
    if (!existsSync(archive)) throw new Error(`missing runtime archive: ${archive}`);
    if (!existsSync(manifestPath)) throw new Error(`missing runtime manifest: ${manifestPath}`);
    const meta = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (meta.runtimePackage?.name !== RUNTIME_PACKAGE_NAME) {
        throw new Error(`runtime.json names ${String(meta.runtimePackage?.name)}, expected ${RUNTIME_PACKAGE_NAME}`);
    }
    if (meta.runtimePackage?.version !== shellVersion) {
        throw new Error(`runtime.json version ${String(meta.runtimePackage?.version)} does not match shell ${shellVersion}`);
    }
    if (typeof meta.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.sha256)) {
        throw new Error("runtime.json sha256 is missing or not a 64-char hex digest");
    }
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (sha256 !== meta.sha256) {
        throw new Error(`runtime.json sha256 ${meta.sha256} does not match ${archive} (${sha256})`);
    }
    return meta;
}

/**
 * Pack the runtime package from an already built runtime archive.
 *
 * The result is a normal npm tarball (`package/…`) holding the runtime
 * archive and its manifest — not a live `npm ci` of dsh — so installing it
 * never runs a package manager against the registry.
 *
 * @returns {string} the path of the packed runtime package.
 */
export function packRuntimePackage({ root, vendor, shellVersion }) {
    const archive = join(vendor, "dsh-runtime.tgz");
    const staging = join(vendor, "runtime-package");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
        assertRuntimeManifest({
            archive,
            manifestPath: join(vendor, "runtime.json"),
            shellVersion,
        });
        writeFileSync(
            join(staging, "package.json"),
            `${JSON.stringify(runtimePackageManifest(shellVersion), null, 2)}\n`,
        );
        copyFileSync(archive, join(staging, "dsh-runtime.tgz"));
        copyFileSync(join(vendor, "runtime.json"), join(staging, "runtime.json"));
        execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", vendor], {
            cwd: staging,
            stdio: "inherit",
        });
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
    const tarball = join(vendor, runtimePackageTarballName(shellVersion));
    if (!existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`);
    return tarball;
}
