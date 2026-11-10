/**
 * Standalone runtime acquisition (experimental packaging split).
 *
 * The shell ships without the private runtime: the standalone launcher
 * acquires it on demand, verifies it against the pinned sha256, and caches
 * it. These cases run against fixtures and a local fake registry — no
 * network, no 175 MiB pack.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as tar from "tar";

import { resolveStandaloneRuntime, RuntimeUnavailableError } from "../src/runtime.ts";

const DSH_VERSION = "0.2.1-rc.5";

/** sherpa-onnx platform package name for a Node (platform, arch) pair. */
function sherpaPackage(platform: string = process.platform, arch: string = process.arch): string {
    const os = platform === "win32" ? "win" : platform;
    return `sherpa-onnx-${os}-${arch}`;
}

function sherpaConstraints(name: string): { os: string[]; cpu: string[] } {
    const id = name.replace(/^sherpa-onnx-/, "");
    if (id.startsWith("win-")) return { os: ["win32"], cpu: [id.slice(4)] };
    const dash = id.lastIndexOf("-");
    return { os: [id.slice(0, dash)], cpu: [id.slice(dash + 1)] };
}

const roots: string[] = [];

function makeRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Build a runtime archive: a package.json plus a minimal dsh tree. */
async function buildRuntimeArchive(target: string): Promise<string> {
    const staging = makeRoot("acp-runtime-archive-");
    mkdirSync(join(staging, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
    mkdirSync(join(staging, "node_modules", "@deepseek-ai", "dsh-agent"), { recursive: true });
    writeFileSync(
        join(staging, "package.json"),
        JSON.stringify({ name: "dsh-acp-runtime", version: "1.0.0" }),
    );
    writeFileSync(
        join(staging, "node_modules", "@deepseek-ai", "dsh", "package.json"),
        JSON.stringify({ name: "@deepseek-ai/dsh", version: DSH_VERSION }),
    );
    writeFileSync(
        join(staging, "node_modules", "@deepseek-ai", "dsh-agent", "package.json"),
        JSON.stringify({ name: "@deepseek-ai/dsh-agent", version: DSH_VERSION }),
    );
    await tar.c({ cwd: staging, file: target, gzip: true, portable: true }, [
        "package.json",
        "node_modules",
    ]);
    return target;
}

function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A fixture package root carrying the pinned manifest. */
async function makePackageRoot(options: {
    externalPackages?: Record<string, unknown>;
    runtimePackage?: { name: string; version: string };
} = {}): Promise<{ root: string; archive: string; sha256: string }> {
    const root = makeRoot("acp-package-root-");
    // The archive lives outside the package root: the tests that exercise a
    // source point at it explicitly. The in-tree path has its own case.
    const archive = join(makeRoot("acp-archive-"), "dsh-runtime.tgz");
    await buildRuntimeArchive(archive);
    const sha256 = sha256File(archive);
    mkdirSync(join(root, "vendor"), { recursive: true });
    writeFileSync(
        join(root, "vendor", "runtime.json"),
        `${JSON.stringify({
            archive: "dsh-runtime.tgz",
            dsh: DSH_VERSION,
            sha256,
            runtimePackage: options.runtimePackage ?? { name: "@openma/deepseek-harness-acp-runtime", version: "0.4.41" },
            externalPackages: options.externalPackages ?? {},
        }, null, 2)}\n`,
    );
    return { root, archive, sha256 };
}

/** A packed runtime package: an npm tarball carrying the runtime archive. */
async function makeRuntimePackage(archive: string): Promise<string> {
    const staging = makeRoot("acp-runtime-package-");
    mkdirSync(join(staging, "package"), { recursive: true });
    writeFileSync(
        join(staging, "package", "package.json"),
        JSON.stringify({ name: "@openma/deepseek-harness-acp-runtime", version: "0.4.41" }),
    );
    writeFileSync(join(staging, "package", "dsh-runtime.tgz"), readFileSync(archive));
    const packed = join(staging, "runtime-package.tgz");
    await tar.c({ cwd: staging, file: packed, gzip: true, portable: true }, ["package"]);
    return packed;
}

/** A fake npm registry serving one package version. */
interface FakeRegistry {
    url: string;
    server: Server;
    requests: string[];
}

async function startRegistry(packages: Record<string, { tarball: Buffer; integrity: string }>): Promise<FakeRegistry> {
    const requests: string[] = [];
    const server = createServer((request, response) => {
        const raw = request.url ?? "";
        requests.push(raw);
        const path = decodeURIComponent(raw);
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        // `/<name>` is the packument, `/<name>/-/.<file>.tgz` the tarball.
        const name = path.endsWith(".tgz")
            ? path.slice(1, path.indexOf("/-/"))
            : path.slice(1, path.lastIndexOf("/"));
        const entry = packages[name];
        if (entry === undefined) {
            response.writeHead(404).end("not found");
            return;
        }
        if (path.endsWith(".tgz")) {
            response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(entry.tarball);
            return;
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
                name,
                versions: { "0.4.41": {} },
                dist: { tarball: `${base}/${name}/-/${name}.tgz`, integrity: entry.integrity },
            }),
        );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, server, requests };
}

/** Build an npm-style tarball for one native package. */
async function buildNativePackage(name: string, version: string): Promise<{ tarball: Buffer; integrity: string }> {
    const staging = makeRoot("acp-native-");
    mkdirSync(join(staging, "package"), { recursive: true });
    writeFileSync(join(staging, "package", "package.json"), JSON.stringify({ name, version }));
    writeFileSync(join(staging, "package", "native.bin"), `${name}@${version}`);
    const file = join(staging, "package.tgz");
    await tar.c({ cwd: staging, file, gzip: true, portable: true }, ["package"]);
    const bytes = readFileSync(file);
    return { tarball: bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

describe("standalone runtime acquisition", () => {
    it("materializes the runtime from a local archive and marks the cache", async () => {
        const { root, archive } = await makePackageRoot();
        const cache = makeRoot("acp-cache-");
        process.env["DSH_ACP_CACHE_DIR"] = cache;
        process.env["DSH_ACP_RUNTIME_TARBALL"] = archive;
        try {
            const target = await resolveStandaloneRuntime(root);
            expect(target).toBe(join(cache, `${DSH_VERSION}-${sha256File(archive).slice(0, 12)}`));
            expect(readFileSync(join(target, ".dsh-acp-runtime"), "utf8").trim()).toBe(DSH_VERSION);
            expect(existsSync(join(target, "node_modules", "@deepseek-ai", "dsh", "package.json"))).toBe(true);
        } finally {
            delete process.env["DSH_ACP_CACHE_DIR"];
            delete process.env["DSH_ACP_RUNTIME_TARBALL"];
        }
    });

    it("creates the cache directory when it does not exist yet", async () => {
        const { root, archive } = await makePackageRoot();
        // A fresh machine has no cache directory at all.
        const cache = join(makeRoot("acp-cache-"), "dsh-acp");
        process.env["DSH_ACP_CACHE_DIR"] = cache;
        process.env["DSH_ACP_RUNTIME_TARBALL"] = archive;
        try {
            const target = await resolveStandaloneRuntime(root);
            expect(existsSync(join(target, ".dsh-acp-runtime"))).toBe(true);
        } finally {
            delete process.env["DSH_ACP_CACHE_DIR"];
            delete process.env["DSH_ACP_RUNTIME_TARBALL"];
        }
    });

    it("reuses a warm cache without touching the network", async () => {
        const { root, archive } = await makePackageRoot();
        const cache = makeRoot("acp-cache-");
        process.env["DSH_ACP_CACHE_DIR"] = cache;
        process.env["DSH_ACP_RUNTIME_TARBALL"] = archive;
        try {
            const first = await resolveStandaloneRuntime(root);
            // No source is reachable any more: the cache must serve the start.
            delete process.env["DSH_ACP_RUNTIME_TARBALL"];
            process.env["DSH_ACP_REGISTRY"] = "http://127.0.0.1:1";
            const second = await resolveStandaloneRuntime(root);
            expect(second).toBe(first);
        } finally {
            delete process.env["DSH_ACP_CACHE_DIR"];
            delete process.env["DSH_ACP_RUNTIME_TARBALL"];
            delete process.env["DSH_ACP_REGISTRY"];
        }
    });

    it("refuses a corrupt archive instead of booting it", async () => {
        const { root, archive } = await makePackageRoot();
        const cache = makeRoot("acp-cache-");
        process.env["DSH_ACP_CACHE_DIR"] = cache;
        process.env["DSH_ACP_RUNTIME_TARBALL"] = archive;
        try {
            await resolveStandaloneRuntime(root);
            // Corrupt the cached artifact and drop the marker: the next start
            // must refuse rather than extract a broken runtime.
            const target = join(cache, `${DSH_VERSION}-${sha256File(archive).slice(0, 12)}`);
            rmSync(join(target, ".dsh-acp-runtime"));
            writeFileSync(archive, "not a tarball");
            await expect(resolveStandaloneRuntime(root)).rejects.toThrow(RuntimeUnavailableError);
            await expect(resolveStandaloneRuntime(root)).rejects.toThrow(/integrity check failed/);
            expect(existsSync(join(target, ".dsh-acp-runtime"))).toBe(false);
        } finally {
            delete process.env["DSH_ACP_CACHE_DIR"];
            delete process.env["DSH_ACP_RUNTIME_TARBALL"];
        }
    });

    it("acquires the runtime from a local packed runtime package", async () => {
        const { root, archive } = await makePackageRoot();
        const packed = await makeRuntimePackage(archive);
        const cache = makeRoot("acp-cache-");
        process.env["DSH_ACP_CACHE_DIR"] = cache;
        process.env["DSH_ACP_RUNTIME_PACK"] = packed;
        try {
            const target = await resolveStandaloneRuntime(root);
            expect(existsSync(join(target, ".dsh-acp-runtime"))).toBe(true);
        } finally {
            delete process.env["DSH_ACP_CACHE_DIR"];
            delete process.env["DSH_ACP_RUNTIME_PACK"];
        }
    });

    it("acquires the runtime from the archive still shipped in the package", async () => {
        const { root, archive } = await makePackageRoot();
        // The in-tree path: `npm run runtime:pack` leaves the archive in
        // vendor/, next to the pinned manifest.
        copyFileSync(archive, join(root, "vendor", "dsh-runtime.tgz"));
        const cache = makeRoot("acp-cache-");
        process.env["DSH_ACP_CACHE_DIR"] = cache;
        try {
            const target = await resolveStandaloneRuntime(root);
            expect(existsSync(join(target, ".dsh-acp-runtime"))).toBe(true);
        } finally {
            delete process.env["DSH_ACP_CACHE_DIR"];
        }
    });

    it("fetches the pinned runtime package from the registry", async () => {
        const { root, archive } = await makePackageRoot();
        const packed = await makeRuntimePackage(archive);
        const bytes = readFileSync(packed);
        const registry = await startRegistry({
            "@openma/deepseek-harness-acp-runtime": {
                tarball: bytes,
                integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
            },
        });
        const cache = makeRoot("acp-cache-");
        process.env["DSH_ACP_CACHE_DIR"] = cache;
        process.env["DSH_ACP_REGISTRY"] = registry.url;
        try {
            const target = await resolveStandaloneRuntime(root);
            expect(existsSync(join(target, ".dsh-acp-runtime"))).toBe(true);
            expect(registry.requests.some((path) => path.includes("deepseek-harness-acp-runtime"))).toBe(true);
            // Never `latest`: the pinned version is requested by version.
            expect(registry.requests.some((path) => path.includes("latest"))).toBe(false);
        } finally {
            delete process.env["DSH_ACP_CACHE_DIR"];
            delete process.env["DSH_ACP_REGISTRY"];
            registry.server.close();
        }
    });

    it("serializes concurrent first starts into one cache tree", async () => {
        const { root, archive } = await makePackageRoot();
        const cache = makeRoot("acp-cache-");
        process.env["DSH_ACP_CACHE_DIR"] = cache;
        process.env["DSH_ACP_RUNTIME_TARBALL"] = archive;
        try {
            const results = await Promise.all([
                resolveStandaloneRuntime(root),
                resolveStandaloneRuntime(root),
                resolveStandaloneRuntime(root),
            ]);
            expect(new Set(results).size).toBe(1);
            expect(existsSync(join(results[0], ".dsh-acp-runtime"))).toBe(true);
            // No leftover lock or extraction directory.
            expect(existsSync(join(cache, `.${DSH_VERSION}-${sha256File(archive).slice(0, 12)}.lock`))).toBe(false);
        } finally {
            delete process.env["DSH_ACP_CACHE_DIR"];
            delete process.env["DSH_ACP_RUNTIME_TARBALL"];
        }
    });
});

describe("standalone native packages", () => {
    it("installs the host platform packages and skips the other platforms", async () => {
        const host = sherpaPackage();
        const foreign = host === "sherpa-onnx-darwin-arm64" ? "sherpa-onnx-linux-x64" : "sherpa-onnx-darwin-arm64";
        const native = await buildNativePackage(host, "1.13.8");
        const other = await buildNativePackage(foreign, "1.13.8");
        const registry = await startRegistry({
            [host]: native,
            [foreign]: other,
        });
        const { root, archive } = await makePackageRoot({
            externalPackages: {
                [host]: {
                    version: "1.13.8",
                    integrity: native.integrity,
                    ...sherpaConstraints(host),
                },
                [foreign]: {
                    version: "1.13.8",
                    integrity: other.integrity,
                    ...sherpaConstraints(foreign),
                },
            },
        });
        const cache = makeRoot("acp-cache-");
        process.env["DSH_ACP_CACHE_DIR"] = cache;
        process.env["DSH_ACP_RUNTIME_TARBALL"] = archive;
        process.env["DSH_ACP_REGISTRY"] = registry.url;
        try {
            const target = await resolveStandaloneRuntime(root);
            const installed = join(target, "node_modules", host);
            expect(existsSync(join(installed, "package.json"))).toBe(true);
            expect(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version).toBe("1.13.8");
            // A package for another platform is never fetched nor installed.
            expect(existsSync(join(target, "node_modules", foreign))).toBe(false);
            expect(registry.requests.some((path) => path.includes(foreign))).toBe(false);
        } finally {
            delete process.env["DSH_ACP_CACHE_DIR"];
            delete process.env["DSH_ACP_RUNTIME_TARBALL"];
            delete process.env["DSH_ACP_REGISTRY"];
            registry.server.close();
        }
    });

    it("keeps booting when a native package fails its integrity check", async () => {
        const host = sherpaPackage();
        const native = await buildNativePackage(host, "1.13.8");
        const registry = await startRegistry({ [host]: native });
        const { root, archive } = await makePackageRoot({
            externalPackages: {
                [host]: {
                    version: "1.13.8",
                    integrity: "sha512-not-the-real-digest",
                    ...sherpaConstraints(host),
                },
            },
        });
        const cache = makeRoot("acp-cache-");
        process.env["DSH_ACP_CACHE_DIR"] = cache;
        process.env["DSH_ACP_RUNTIME_TARBALL"] = archive;
        process.env["DSH_ACP_REGISTRY"] = registry.url;
        try {
            const target = await resolveStandaloneRuntime(root);
            expect(existsSync(join(target, ".dsh-acp-runtime"))).toBe(true);
            expect(existsSync(join(target, "node_modules", host, "package.json"))).toBe(false);
        } finally {
            delete process.env["DSH_ACP_CACHE_DIR"];
            delete process.env["DSH_ACP_RUNTIME_TARBALL"];
            delete process.env["DSH_ACP_REGISTRY"];
            registry.server.close();
        }
    });
});
