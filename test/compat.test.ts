import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
    COMPAT_PACKAGE,
    dshRangeOf,
    dshVersionAt,
    dshVersionSupported,
    refusalMessage,
    supportedDshRange,
} from "../src/compat.ts";
import { dshAcpRuntimeOf } from "../src/bridge/index.ts";

const roots: string[] = [];

function makeTree(): string {
    const root = mkdtempSync(join(tmpdir(), "dsh-acp-compat-"));
    roots.push(root);
    return root;
}

function writeDsh(root: string, manifest: Record<string, unknown>): string {
    const dir = join(root, "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    return dir;
}

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("supported dsh range", () => {
    it("reads the declared range from package.json peerDependencies", () => {
        expect(supportedDshRange()).toBe("0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2");
        expect(COMPAT_PACKAGE).toBe("@deepseek-ai/dsh");
    });

    it("falls back to * when a manifest declares no peer range", () => {
        expect(dshRangeOf({})).toBe("*");
        expect(dshRangeOf({ peerDependencies: {} })).toBe("*");
        expect(dshRangeOf({ peerDependencies: { "@deepseek-ai/dsh": ">=1" } })).toBe(">=1");
    });
});

describe("dshVersionSupported", () => {
    it("accepts versions inside the declared range and refuses others", () => {
        expect(dshVersionSupported("0.2.0-rc.2")).toBe(true);
        expect(dshVersionSupported("0.1.7-rc.2")).toBe(true);
        expect(dshVersionSupported("0.1.1-rc.2")).toBe(false);
        expect(dshVersionSupported("9.9.9")).toBe(false);
        expect(dshVersionSupported(undefined)).toBe(false);
    });

    it("honours an explicit range override", () => {
        expect(dshVersionSupported("0.1.1-rc.2", "0.1.1-rc.2")).toBe(true);
        expect(dshVersionSupported("0.1.1-rc.2", "0.2.x")).toBe(false);
    });
});

describe("dshVersionAt", () => {
    it("reports the launcher version and package dir resolvable from an anchor", () => {
        const root = makeTree();
        const dir = writeDsh(root, { name: "@deepseek-ai/dsh", version: "0.2.0-rc.2" });
        // Module resolution realpaths the package dir (macOS /var → /private/var).
        expect(dshVersionAt(join(root, "probe.mjs"))).toEqual({ version: "0.2.0-rc.2", base: realpathSync(dir) });
    });

    it("reports an unknown version when the manifest carries no string version", () => {
        const root = makeTree();
        const dir = writeDsh(root, { name: "@deepseek-ai/dsh" });
        expect(dshVersionAt(join(root, "probe.mjs"))).toEqual({ version: undefined, base: realpathSync(dir) });
    });

    it("returns undefined when no @deepseek-ai/dsh resolves from the anchor", () => {
        const root = makeTree();
        expect(dshVersionAt(join(root, "probe.mjs"))).toBeUndefined();
    });
});

describe("refusalMessage", () => {
    it("names the version found, its source, and the supported range", () => {
        expect(refusalMessage("0.1.1-rc.2", "global npm (/usr/lib/node_modules)", "0.2.x")).toBe(
            "incompatible DeepSeek Harness: @deepseek-ai/dsh 0.1.1-rc.2 found at global npm (/usr/lib/node_modules) — supported versions: 0.2.x",
        );
    });
});

describe("dshAcpRuntimeOf", () => {
    it("returns undefined without a structured host", () => {
        expect(dshAcpRuntimeOf(undefined)).toBeUndefined();
        expect(dshAcpRuntimeOf(null)).toBeUndefined();
        expect(dshAcpRuntimeOf("bundled")).toBeUndefined();
        expect(dshAcpRuntimeOf({ base: "/dsh" })).toBeUndefined();
        expect(dshAcpRuntimeOf({ source: "host" })).toBeUndefined();
        expect(dshAcpRuntimeOf({ base: 7, source: "host" })).toBeUndefined();
    });

    it("shapes a valid host identity, keeping a missing version unknown", () => {
        expect(dshAcpRuntimeOf({ base: "/dsh", source: "bundled standalone runtime" })).toEqual({
            base: "/dsh",
            version: undefined,
            source: "bundled standalone runtime",
        });
        expect(
            dshAcpRuntimeOf({ base: "/dsh", source: "dsh plugin host (/dsh)", version: "0.2.0-rc.1", extra: 1 }),
        ).toEqual({ base: "/dsh", version: "0.2.0-rc.1", source: "dsh plugin host (/dsh)" });
        expect(dshAcpRuntimeOf({ base: "/dsh", source: "host", version: 12 })).toEqual({
            base: "/dsh",
            version: undefined,
            source: "host",
        });
    });
});
