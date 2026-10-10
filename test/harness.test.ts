import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const vendoredDir = vi.hoisted(() => ({ dir: undefined as string | undefined }));

vi.mock("../src/runtime.ts", () => ({
    resolveVendoredRuntime: () => vendoredDir.dir,
}));

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
    vendoredDir.dir = undefined;
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
    it("accepts a directory whose node_modules carries the harness", () => {
        const root = makeTree();
        writeHost(root);
        const host = resolveHost(root);
        expect(host.base).toBe(root);
        expect(host.version).toBe(SUPPORTED_VERSION);
        expect(host.dshVersion).toBe(SUPPORTED_VERSION);
        expect(host.source).toContain(root);
    });

    it("accepts an npm prefix (lib/node_modules layout)", () => {
        const root = makeTree();
        writeHost(join(root, "lib", "node_modules"));
        const host = resolveHost(root);
        expect(host.base).toBe(join(root, "lib", "node_modules"));
    });

    it("accepts the dsh launcher path and walks up through symlinks", () => {
        const root = makeTree();
        const dsh = writeGlobalLayout(root);
        const host = resolveHost(dsh);
        expect(host.version).toBe(SUPPORTED_VERSION);
    });

    it("fails loudly with installation guidance when the explicit path has no harness", () => {
        const root = makeTree();
        expect(() => resolveHost(root)).toThrow(HarnessNotFoundError);
        expect(() => resolveHost(root)).toThrow(/Reinstall @openma\/deepseek-harness-acp/);
    });

    it("rejects a partial module tree that has dsh-agent but not the dsh profile launcher", () => {
        const root = makeTree();
        writePackage(join(root, "node_modules", "@deepseek-ai", "dsh-agent"), "@deepseek-ai/dsh-agent");
        expect(() => resolveHost(root)).toThrow(HarnessNotFoundError);
    });

});

describe("resolveHost default selection", () => {
    it("uses the packaged runtime with no explicit selection", () => {
        const vendored = makeTree();
        writeHost(vendored);
        vendoredDir.dir = vendored;
        const host = resolveHost();
        expect(host.base).toBe(vendored);
        expect(host.source).toBe("bundled standalone runtime");
    });

    it("ignores ambient dsh installs in the invoking directory, on PATH and in global npm", () => {
        // Stale installs must never hijack the runtime (Martty issue #157):
        // implicit discovery is gone entirely, so these fixtures stay unused.
        const ambient = makeTree();
        writeHost(ambient, STALE_VERSION);
        writeGlobalLayout(join(ambient, "prefix"), STALE_VERSION);
        writeNpmShim(join(ambient, "shim"), ambient);
        process.chdir(ambient);
        process.env["PATH"] = [join(ambient, "prefix", "bin"), join(ambient, "shim"), originalEnv.PATH].join(delimiter);

        const vendored = makeTree();
        writeHost(vendored);
        vendoredDir.dir = vendored;

        const writes = stderrWrites();
        const host = resolveHost();
        expect(host.base).toBe(vendored);
        expect(host.source).toBe("bundled standalone runtime");
        expect(writes.join("")).not.toContain(STALE_VERSION);
    });

    it("fails when the packaged runtime is missing and nothing was selected", () => {
        vendoredDir.dir = undefined;
        expect(() => resolveHost()).toThrow(HarnessNotFoundError);
        expect(() => resolveHost()).toThrow(/bundled standalone runtime/);
    });

    it("fails when the packaged runtime resolves to a tree without the dsh packages", () => {
        vendoredDir.dir = makeTree();
        expect(() => resolveHost()).toThrow(HarnessNotFoundError);
        expect(() => resolveHost()).toThrow(/bundled standalone runtime/);
    });
});

describe("resolveHost bundled selection", () => {
    it("resolves the packaged runtime and ignores ambient installs", () => {
        // A stale dsh in the invoking directory, on PATH and in global npm must
        // never hijack the bundled selection (Martty issue #157).
        const ambient = makeTree();
        writeHost(ambient, STALE_VERSION);
        writeGlobalLayout(join(ambient, "prefix"), STALE_VERSION);
        writeNpmShim(join(ambient, "shim"), ambient);
        process.chdir(ambient);
        process.env["PATH"] = [join(ambient, "prefix", "bin"), join(ambient, "shim"), originalEnv.PATH].join(delimiter);

        const vendored = makeTree();
        writeHost(vendored);
        vendoredDir.dir = vendored;

        const host = resolveHost("bundled");
        expect(host.base).toBe(vendored);
        expect(host.source).toBe("bundled standalone runtime");
    });

    it("fails when the packaged runtime is missing", () => {
        vendoredDir.dir = undefined;
        expect(() => resolveHost("bundled")).toThrow(HarnessNotFoundError);
    });
});

describe("resolveHost compatibility checks", () => {
    it("refuses an explicit path outside the supported range, naming version, source and range", () => {
        const root = makeTree();
        writeHost(root, STALE_VERSION);
        expect(() => resolveHost(root)).toThrow(HarnessCompatibilityError);
        expect(() => resolveHost(root)).toThrow(new RegExp(STALE_VERSION.replaceAll(".", "\\.")));
        expect(() => resolveHost(root)).toThrow(/supported versions:/);
        expect(() => resolveHost(root)).toThrow(new RegExp(root.replaceAll("/", "\\/")));
    });

    it("reports the supported range from package metadata", () => {
        expect(supportedDshRange()).toBe("0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2");
    });

    it("refuses a packaged runtime outside the supported range", () => {
        const vendored = makeTree();
        writeHost(vendored, STALE_VERSION);
        vendoredDir.dir = vendored;
        for (const pick of [undefined, "bundled"] as const) {
            expect(() => resolveHost(pick)).toThrow(HarnessCompatibilityError);
            expect(() => resolveHost(pick)).toThrow(new RegExp(STALE_VERSION.replaceAll(".", "\\.")));
            expect(() => resolveHost(pick)).toThrow(/bundled standalone runtime/);
        }
    });

    it("reports an unversioned packaged runtime as 'unknown version'", () => {
        const vendored = makeTree();
        for (const name of ["dsh", "dsh-agent"]) {
            const dir = join(vendored, "node_modules", "@deepseek-ai", name);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}` }));
        }
        vendoredDir.dir = vendored;
        expect(() => resolveHost()).toThrow(HarnessCompatibilityError);
        expect(() => resolveHost()).toThrow(/unknown version/);
    });

    it("keeps the not-found message terse when nothing was probed", () => {
        expect(new HarnessNotFoundError([]).message).not.toContain("Looked at");
        expect(new HarnessNotFoundError(["a"]).message).toContain("Looked at");
    });
});
