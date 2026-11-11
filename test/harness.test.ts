import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const runtimeDir = vi.hoisted(() => ({ dir: undefined as string | undefined }));

vi.mock("../src/runtime.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/runtime.ts")>();
    return {
        ...actual,
        // The runtime is acquired on demand now: a missing runtime is an
        // acquisition failure, not an absent value.
        resolveStandaloneRuntime: async (): Promise<string> => {
            if (runtimeDir.dir === undefined) throw new actual.RuntimeUnavailableError("runtime not acquired");
            return runtimeDir.dir;
        },
    };
});

import {
    HarnessCompatibilityError,
    HarnessNotFoundError,
    resolveHost,
    supportedDshRange,
} from "../src/harness.ts";

const roots: string[] = [];

const SUPPORTED_VERSION = "0.2.0-rc.2";
const STALE_VERSION = "0.1.1-rc.2";

function makeTree(): string {
    const root = mkdtempSync(join(tmpdir(), "dsh-acp-host-"));
    roots.push(root);
    return root;
}

function writePackage(
    dir: string,
    name: string,
    version: string = SUPPORTED_VERSION,
    extra: Record<string, unknown> = {},
): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, ...extra }));
}

/** A host tree at `base` carrying dsh + dsh-agent at `version`. */
function writeHost(base: string, version: string = SUPPORTED_VERSION): void {
    writePackage(join(base, "node_modules", "@deepseek-ai", "dsh"), "@deepseek-ai/dsh", version);
    writePackage(join(base, "node_modules", "@deepseek-ai", "dsh-agent"), "@deepseek-ai/dsh-agent", version);
}

/** A `dsh` launcher symlink laid out like `npm install -g @deepseek-ai/dsh`. */
function writeGlobalLayout(root: string, version: string = SUPPORTED_VERSION): string {
    const dshDir = join(root, "lib", "node_modules", "@deepseek-ai", "dsh");
    writePackage(dshDir, "@deepseek-ai/dsh", version, { bin: { dsh: "lib/bin.js" } });
    mkdirSync(join(dshDir, "lib"), { recursive: true });
    writeFileSync(join(dshDir, "lib", "bin.js"), "// launcher");
    writePackage(
        join(root, "lib", "node_modules", "@deepseek-ai", "dsh-agent"),
        "@deepseek-ai/dsh-agent",
        version,
    );
    mkdirSync(join(root, "bin"), { recursive: true });
    symlinkSync(join(dshDir, "lib", "bin.js"), join(root, "bin", "dsh"));
    return join(root, "bin", "dsh");
}

/** An `npm` shim on PATH that prints `root` for `npm root -g`. */
function writeNpmShim(binDir: string, root: string): void {
    mkdirSync(binDir, { recursive: true });
    const script = `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo ${JSON.stringify(root)}; exit 0; fi\nexit 1\n`;
    writeFileSync(join(binDir, "npm"), script);
    chmodSync(join(binDir, "npm"), 0o755);
}

const originalEnv = { PATH: process.env["PATH"], DSH_PATH: process.env["DSH_PATH"], DSH_ACP_HOST: process.env["DSH_ACP_HOST"] };
const originalCwd = process.cwd();

afterEach(() => {
    process.env["PATH"] = originalEnv.PATH;
    if (originalEnv.DSH_PATH === undefined) delete process.env["DSH_PATH"];
    else process.env["DSH_PATH"] = originalEnv.DSH_PATH;
    if (originalEnv.DSH_ACP_HOST === undefined) delete process.env["DSH_ACP_HOST"];
    else process.env["DSH_ACP_HOST"] = originalEnv.DSH_ACP_HOST;
    process.chdir(originalCwd);
    runtimeDir.dir = undefined;
    vi.restoreAllMocks();
});

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function stderrWrites(): string[] {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
    });
    return writes;
}

describe("resolveHost", () => {
    it("accepts a directory whose node_modules carries the harness", async () => {
        const root = makeTree();
        writeHost(root);
        const host = await resolveHost(root);
        expect(host.base).toBe(root);
        expect(host.version).toBe(SUPPORTED_VERSION);
        expect(host.dshVersion).toBe(SUPPORTED_VERSION);
        expect(host.source).toContain(root);
    });

    it("accepts an npm prefix (lib/node_modules layout)", async () => {
        const root = makeTree();
        writeHost(join(root, "lib", "node_modules"));
        const host = await resolveHost(root);
        expect(host.base).toBe(join(root, "lib", "node_modules"));
    });

    it("accepts the dsh launcher path and walks up through symlinks", async () => {
        const root = makeTree();
        const dsh = writeGlobalLayout(root);
        const host = await resolveHost(dsh);
        expect(host.version).toBe(SUPPORTED_VERSION);
    });

    it("fails loudly naming the configured source when the explicit path has no harness", async () => {
        const root = makeTree();
        await expect(resolveHost(root)).rejects.toThrow(HarnessNotFoundError);
        // The refusal names the explicit path, not the bundled runtime.
        await expect(resolveHost(root)).rejects.toThrow(/--dsh-path\/DSH_PATH is missing or invalid/);
        await expect(resolveHost(root)).rejects.toThrow(root);
        await expect(resolveHost(root)).rejects.toThrow(/--dsh-path bundled/);
    });

    it("rejects a partial module tree that has dsh-agent but not the dsh profile launcher", async () => {
        const root = makeTree();
        writePackage(join(root, "node_modules", "@deepseek-ai", "dsh-agent"), "@deepseek-ai/dsh-agent");
        await expect(resolveHost(root)).rejects.toThrow(HarnessNotFoundError);
    });

});

describe("resolveHost default selection", () => {
    it("uses the packaged runtime with no explicit selection", async () => {
        const runtime = makeTree();
        writeHost(runtime);
        runtimeDir.dir = runtime;
        const host = await resolveHost();
        expect(host.base).toBe(runtime);
        expect(host.source).toBe("bundled standalone runtime");
    });

    it("ignores ambient dsh installs in the invoking directory, on PATH and in global npm", async () => {
        // Stale installs must never hijack the runtime (Martty issue #157):
        // implicit discovery is gone entirely, so these fixtures stay unused.
        const ambient = makeTree();
        writeHost(ambient, STALE_VERSION);
        writeGlobalLayout(join(ambient, "prefix"), STALE_VERSION);
        writeNpmShim(join(ambient, "shim"), ambient);
        process.chdir(ambient);
        process.env["PATH"] = [join(ambient, "prefix", "bin"), join(ambient, "shim"), originalEnv.PATH].join(delimiter);

        const runtime = makeTree();
        writeHost(runtime);
        runtimeDir.dir = runtime;

        const writes = stderrWrites();
        const host = await resolveHost();
        expect(host.base).toBe(runtime);
        expect(host.source).toBe("bundled standalone runtime");
        expect(writes.join("")).not.toContain(STALE_VERSION);
    });

    it("fails when the packaged runtime is missing and nothing was selected", async () => {
        runtimeDir.dir = undefined;
        await expect(resolveHost()).rejects.toThrow(HarnessNotFoundError);
        await expect(resolveHost()).rejects.toThrow(/bundled standalone runtime/);
    });

    it("names how to acquire the runtime when the acquisition fails", async () => {
        runtimeDir.dir = undefined;
        await expect(resolveHost()).rejects.toThrow(/--prefetch-runtime/);
        await expect(resolveHost()).rejects.toThrow(/DSH_ACP_RUNTIME_TARBALL/);
        await expect(resolveHost()).rejects.toThrow(/DSH_PATH=/);
    });

    it("fails when the packaged runtime resolves to a tree without the dsh packages", async () => {
        runtimeDir.dir = makeTree();
        await expect(resolveHost()).rejects.toThrow(HarnessNotFoundError);
        await expect(resolveHost()).rejects.toThrow(/bundled standalone runtime/);
    });
});

describe("resolveHost bundled selection", () => {
    it("resolves the packaged runtime and ignores ambient installs", async () => {
        // A stale dsh in the invoking directory, on PATH and in global npm must
        // never hijack the bundled selection (Martty issue #157).
        const ambient = makeTree();
        writeHost(ambient, STALE_VERSION);
        writeGlobalLayout(join(ambient, "prefix"), STALE_VERSION);
        writeNpmShim(join(ambient, "shim"), ambient);
        process.chdir(ambient);
        process.env["PATH"] = [join(ambient, "prefix", "bin"), join(ambient, "shim"), originalEnv.PATH].join(delimiter);

        const runtime = makeTree();
        writeHost(runtime);
        runtimeDir.dir = runtime;

        const host = await resolveHost("bundled");
        expect(host.base).toBe(runtime);
        expect(host.source).toBe("bundled standalone runtime");
    });

    it("fails when the packaged runtime is missing", async () => {
        runtimeDir.dir = undefined;
        await expect(resolveHost("bundled")).rejects.toThrow(HarnessNotFoundError);
    });
});

describe("resolveHost compatibility checks", () => {
    it("refuses an explicit path outside the supported range, naming version, source and range", async () => {
        const root = makeTree();
        writeHost(root, STALE_VERSION);
        await expect(resolveHost(root)).rejects.toThrow(HarnessCompatibilityError);
        await expect(resolveHost(root)).rejects.toThrow(new RegExp(STALE_VERSION.replaceAll(".", "\\.")));
        await expect(resolveHost(root)).rejects.toThrow(/supported versions:/);
        await expect(resolveHost(root)).rejects.toThrow(root);
    });

    it("reports the supported range from package metadata", () => {
        expect(supportedDshRange()).toBe(">=0.1.7-rc.2");
    });

    it("refuses a packaged runtime outside the supported range", async () => {
        const runtime = makeTree();
        writeHost(runtime, STALE_VERSION);
        runtimeDir.dir = runtime;
        for (const pick of [undefined, "bundled"] as const) {
            await expect(resolveHost(pick)).rejects.toThrow(HarnessCompatibilityError);
            await expect(resolveHost(pick)).rejects.toThrow(new RegExp(STALE_VERSION.replaceAll(".", "\\.")));
            await expect(resolveHost(pick)).rejects.toThrow(/bundled standalone runtime/);
        }
    });

    it("reports an unversioned packaged runtime as 'unknown version'", async () => {
        const runtime = makeTree();
        for (const name of ["dsh", "dsh-agent"]) {
            const dir = join(runtime, "node_modules", "@deepseek-ai", name);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}` }));
        }
        runtimeDir.dir = runtime;
        await expect(resolveHost()).rejects.toThrow(HarnessCompatibilityError);
        await expect(resolveHost()).rejects.toThrow(/unknown version/);
    });

    it("keeps the not-found message terse when nothing was probed", () => {
        expect(new HarnessNotFoundError([]).message).not.toContain("Looked at");
        expect(new HarnessNotFoundError(["a"]).message).toContain("Looked at");
    });
});
