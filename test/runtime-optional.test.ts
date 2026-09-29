import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyExternalPackages } from "../src/runtime.ts";

describe("standalone native packages", () => {
    it("copies the platform package installed by npm into the isolated runtime", () => {
        const root = mkdtempSync(join(tmpdir(), "acp-native-test-"));
        try {
            const packageRoot = join(root, "node_modules/@openma/deepseek-harness-acp");
            const native = join(root, "node_modules/sherpa-onnx-linux-x64");
            const runtime = join(root, "runtime");
            mkdirSync(packageRoot, { recursive: true });
            mkdirSync(native, { recursive: true });
            mkdirSync(runtime, { recursive: true });
            writeFileSync(join(native, "package.json"), JSON.stringify({ version: "1.13.8" }));
            writeFileSync(join(native, "native.node"), "native bytes");
            copyExternalPackages(packageRoot, runtime, { "sherpa-onnx-linux-x64": "1.13.8" });
            expect(readFileSync(join(runtime, "node_modules/sherpa-onnx-linux-x64/native.node"), "utf8"))
                .toBe("native bytes");
            expect(existsSync(join(runtime, "node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64")))
                .toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
