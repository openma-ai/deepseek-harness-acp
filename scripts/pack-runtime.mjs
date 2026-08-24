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
    writeFileSync(
        join(vendor, "runtime.json"),
        `${JSON.stringify({ archive: "dsh-runtime.tgz", dsh: dshVersion, sha256 }, null, 2)}\n`,
    );
} finally {
    rmSync(staging, { recursive: true, force: true });
}
