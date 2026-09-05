import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as tar from "tar";

const targets = ["darwin", "linux", "win32"].flatMap((os) =>
    ["x64", "arm64"].map((cpu) => ({ os, cpu })));
const matches = (values, target) => !values || (
    !values.includes(`!${target}`)
    && (!values.some((value) => !value.startsWith("!")) || values.includes(target))
);

export function platformPackages(lock) {
    return Object.entries(lock.packages).filter(([, pkg]) =>
        pkg.optional && (pkg.os || pkg.cpu)
        && targets.some(({ os, cpu }) => matches(pkg.os, os) && matches(pkg.cpu, cpu)));
}

export function verifyIntegrity(bytes, integrity) {
    if (typeof integrity !== "string") throw new Error("Missing locked package integrity");
    const valid = integrity.split(/\s+/).some((entry) => {
        const separator = entry.indexOf("-");
        const algorithm = entry.slice(0, separator);
        if (!["sha512", "sha384", "sha256"].includes(algorithm)) return false;
        return createHash(algorithm).update(bytes).digest("base64") === entry.slice(separator + 1);
    });
    if (!valid) throw new Error("Platform package integrity mismatch");
}

// npm ci omits foreign optional binaries. Restore those exact locked packages
// into the archive at build time, without executing package install scripts.
export async function completePlatformPackages(staging) {
    const lock = JSON.parse(readFileSync(join(staging, "package-lock.json"), "utf8"));
    for (const [path, pkg] of platformPackages(lock)) {
        const destination = join(staging, path);
        if (!existsSync(join(destination, "package.json"))) {
            const url = new URL(pkg.resolved);
            if (url.protocol !== "https:" || !["registry.npmjs.org", "registry.npmmirror.com"].includes(url.hostname)) {
                throw new Error(`Unexpected platform package URL: ${path}`);
            }
            // Existing lockfiles use the npm mirror; the locked integrity also
            // authenticates the identical tarball from the upstream registry.
            url.hostname = "registry.npmjs.org";
            console.log(`Bundling ${path}@${pkg.version}`);
            const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
            if (!response.ok) throw new Error(`Download failed: ${path}: ${response.status}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            verifyIntegrity(bytes, pkg.integrity);
            const archive = join(staging, ".platform.tgz");
            writeFileSync(archive, bytes);
            mkdirSync(destination, { recursive: true });
            try {
                await tar.x({ file: archive, cwd: destination, strip: 1, strict: true });
            } finally {
                rmSync(archive, { force: true });
            }
        }
        const installed = JSON.parse(readFileSync(join(destination, "package.json"), "utf8"));
        if (installed.version !== pkg.version) throw new Error(`Platform package version mismatch: ${path}`);
    }
}
