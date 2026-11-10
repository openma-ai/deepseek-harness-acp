#!/usr/bin/env node
/**
 * Isolated real-install matrix for the slim shell + on-demand runtime split.
 *
 * Uses packed artifacts only (never publishes, never touches a user-global
 * prefix). The public npm registry path for @openma/deepseek-harness-acp-runtime
 * is recorded as unverified when the package is not on the registry.
 *
 * Usage:
 *   node scripts/install-matrix.mjs --shell <slim.tgz> --runtime-pack <runtime.tgz> [--dsh <dsh-bin>]
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { createInterface } from "node:readline";
import { listTarball } from "./list-tarball.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const shell = flag("--shell") && resolve(flag("--shell"));
const runtimePack = flag("--runtime-pack") && resolve(flag("--runtime-pack"));
const dshBin = flag("--dsh") && resolve(flag("--dsh"));
assert(shell && runtimePack, "usage: node scripts/install-matrix.mjs --shell <slim.tgz> --runtime-pack <runtime.tgz> [--dsh <dsh-bin>]");

const root = mkdtempSync(join(tmpdir(), "dsh-acp-matrix-"));
const results = [];
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmArgs = existsSync(npmCli) ? [process.execPath, npmCli] : ["npm"];

function record(id, status, detail) {
    results.push({ id, status, detail, platform: `${process.platform}/${process.arch}`, node: process.version });
    const mark = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
    console.log(`[install-matrix] ${mark}  ${id}${detail ? ` — ${detail}` : ""}`);
}

function npm(args, opts = {}) {
    const [cmd, ...cmdArgs] = npmArgs[0] === process.execPath
        ? [process.execPath, npmCli, ...args]
        : ["npm", ...args];
    return execFileSync(cmd, cmdArgs, {
        encoding: "utf8",
        timeout: opts.timeout ?? 180_000,
        stdio: opts.stdio ?? "pipe",
        env: opts.env ?? process.env,
        cwd: opts.cwd ?? root,
    });
}

async function withServer(handler, fn) {
    const server = createServer(handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    try {
        return await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((r) => server.close(r));
    }
}

function baseEnv(overrides = {}) {
    const env = { ...process.env };
    delete env.DSH_PATH;
    delete env.DSH_ACP_HOST;
    env.DSH_TELEMETRY_DISABLED = "1";
    env.DEEPSEEK_API_KEY = "sk-test-matrix-not-a-real-key";
    env.DEEPSEEK_BASE_URL = "http://127.0.0.1:1";
    Object.assign(env, overrides);
    return env;
}

async function acpInitialize(binary, env, timeoutMs = 180_000) {
    const workspace = mkdtempSync(join(root, "ws-"));
    const child = spawn(process.execPath, [binary], {
        cwd: workspace,
        env: { ...env, DSH_HOME: env.DSH_HOME ?? join(workspace, "home"), DSH_SESSION_ROOT: env.DSH_SESSION_ROOT ?? join(workspace, "sessions") },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (c) => stderr.push(c));
    const pending = new Map();
    let id = 0;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
    });
    const exit = once(child, "exit").then(([code, signal]) => {
        const text = Buffer.concat(stderr).toString("utf8");
        const err = new Error(`process exited: code=${code} signal=${signal}\n${text}`);
        for (const w of pending.values()) {
            clearTimeout(w.timer);
            w.reject(err);
        }
        pending.clear();
        return { code, signal, stderr: text };
    });
    const request = (method, params) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`timeout: ${method}\n${Buffer.concat(stderr).toString("utf8")}`));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    });
    try {
        const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        return { init, stderr: Buffer.concat(stderr).toString("utf8") };
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await exit.catch(() => undefined);
        }
    }
}

function cacheMarker(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .filter((e) => existsSync(join(dir, e.name, ".dsh-acp-runtime")))
        .map((e) => e.name);
}

function nativesIn(dir) {
    const hits = [];
    const walk = (d) => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) {
                if (e.name.includes("sherpa-onnx") || e.name.includes("libreoffice-kit")) hits.push(p);
                else if (e.name === "node_modules" || e.name.startsWith("@")) walk(p);
            }
        }
    };
    walk(join(dir, "node_modules"));
    return hits;
}

async function runCase(id, fn) {
    try {
        const detail = await fn();
        record(id, "pass", typeof detail === "string" ? detail : undefined);
    } catch (error) {
        record(id, "fail", error instanceof Error ? error.message.split("\n")[0] : String(error));
        console.error(`[install-matrix] ${id} error:\n`, error);
    }
}

try {
    const entries = listTarball(shell);
    assert(!entries.some((p) => p.endsWith("dsh-runtime.tgz")), "shell tarball still contains dsh-runtime.tgz");
    assert(entries.some((p) => p === "package/vendor/runtime.json"), "shell tarball missing vendor/runtime.json");
    record("pack/slim-inventory", "pass", `${entries.length} files, no dsh-runtime.tgz, has vendor/runtime.json`);

    // --- 2 + omit-optional: isolated "global" prefix ---
    const globalPrefix = join(root, "npm-global");
    mkdirSync(globalPrefix);
    await runCase("install/npm-global-prefix", async () => {
        npm(["install", "-g", "--prefix", globalPrefix, "--ignore-scripts", "--no-audit", "--no-fund", shell], { stdio: "inherit" });
        const pkg = join(globalPrefix, "lib/node_modules/@openma/deepseek-harness-acp");
        // Windows / some npm layouts use node_modules at prefix root for -g --prefix
        const installed = existsSync(pkg) ? pkg : join(globalPrefix, "node_modules/@openma/deepseek-harness-acp");
        assert(existsSync(join(installed, "package.json")), `missing installed package at ${pkg} or ${installed}`);
        assert(!existsSync(join(installed, "vendor/dsh-runtime.tgz")), "global install carried vendor/dsh-runtime.tgz");
        assert(!existsSync(join(dirname(installed), "@openma/deepseek-harness-acp-runtime")), "global install pulled the runtime package");
        assert.equal(nativesIn(installed).length, 0, `global install pulled native packages: ${nativesIn(installed).join(", ")}`);
        return installed;
    });

    const installedShell = existsSync(join(globalPrefix, "lib/node_modules/@openma/deepseek-harness-acp"))
        ? join(globalPrefix, "lib/node_modules/@openma/deepseek-harness-acp")
        : join(globalPrefix, "node_modules/@openma/deepseek-harness-acp");
    const bin = join(installedShell, "dist/bin.js");

    await runCase("install/npm-omit-optional", async () => {
        const prefix = join(root, "omit-optional");
        mkdirSync(prefix);
        npm(["install", "--prefix", prefix, "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", shell], { stdio: "inherit" });
        const pkg = join(prefix, "node_modules/@openma/deepseek-harness-acp");
        assert(existsSync(join(pkg, "package.json")));
        assert(!existsSync(join(pkg, "vendor/dsh-runtime.tgz")));
        assert.equal(nativesIn(pkg).length, 0, "omit=optional still installed natives (or default install leaked them)");
        // Compare with a default install in a sibling prefix: also no natives,
        // because the shell no longer declares optionalDependencies.
        const def = join(root, "default-install");
        mkdirSync(def);
        npm(["install", "--prefix", def, "--ignore-scripts", "--no-audit", "--no-fund", shell], { stdio: "inherit" });
        const defPkg = join(def, "node_modules/@openma/deepseek-harness-acp");
        assert.equal(nativesIn(defPkg).length, 0, "default npm install pulled native optional packages");
        return "omit=optional and default both have no sherpa/libreoffice";
    });

    // --- 3 npx / npm exec ---
    await runCase("install/npm-exec", async () => {
        const prefix = join(root, "npm-exec");
        mkdirSync(prefix);
        const out = npm(["exec", "--yes", "--prefix", prefix, "--package", shell, "--", "dsh-acp", "--version"]);
        assert.match(out, /@openma\/deepseek-harness-acp 0\.4\.41|0\.4\.41/);
        return out.trim().split("\n").pop();
    });

    // --- 4 cold start from local runtime pack (not public registry) ---
    const coldCache = join(root, "cache-cold");
    await runCase("standalone/cold-local-pack", async () => {
        const { init, stderr } = await acpInitialize(bin, baseEnv({
            DSH_ACP_CACHE_DIR: coldCache,
            DSH_ACP_RUNTIME_PACK: runtimePack,
        }));
        assert.equal(init.agentInfo.name, "dsh-acp");
        assert.match(stderr, /bundled standalone runtime|standalone runtime:/);
        assert.equal(cacheMarker(coldCache).length, 1);
        const tree = join(coldCache, cacheMarker(coldCache)[0]);
        const office = process.platform === "linux"
            ? "@deepseek-ai/libreoffice-kit-wasm"
            : `@deepseek-ai/libreoffice-kit-${process.platform}-${process.arch}`;
        assert(existsSync(join(tree, "node_modules", office, "package.json")), `native ${office} not installed into runtime cache`);
        assert.equal(nativesIn(installedShell).length, 0, "natives leaked into the shell install");
        return `cached ${cacheMarker(coldCache)[0]}, native ${office}`;
    });

    try {
        const version = execFileSync("npm", ["view", "@openma/deepseek-harness-acp-runtime", "version"], {
            encoding: "utf8", timeout: 30_000,
        }).trim();
        record("standalone/public-registry", "untested",
            `package unexpectedly present at ${version}; this matrix still did not boot from the public registry`);
    } catch (error) {
        const text = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`;
        if (/E404|404|Not found/i.test(text)) {
            record("standalone/public-registry", "untested",
                "public registry 404: @openma/deepseek-harness-acp-runtime is not published; cold start was verified with --runtime-pack only");
        } else {
            record("standalone/public-registry", "fail", text.split("\n")[0]);
        }
    }

    // --- 5 warm cache, unreachable registry, no pack/tarball ---
    await runCase("standalone/warm-cache-offline", async () => {
        const { init, stderr } = await acpInitialize(bin, baseEnv({
            DSH_ACP_CACHE_DIR: coldCache,
            DSH_ACP_REGISTRY: "http://127.0.0.1:1",
        }));
        assert.equal(init.agentInfo.name, "dsh-acp");
        assert(!/fetching @openma\/deepseek-harness-acp-runtime/.test(stderr), "warm start fetched the runtime package");
        return "initialize from warm cache, registry unreachable";
    });

    // --- 6 prefetch then offline first session on a fresh cache ---
    await runCase("standalone/prefetch-then-offline-first", async () => {
        const cache = join(root, "cache-prefetch");
        const prefetchEnv = baseEnv({
            DSH_ACP_CACHE_DIR: cache,
            DSH_ACP_RUNTIME_PACK: runtimePack,
        });
        execFileSync(process.execPath, [bin, "--prefetch-runtime"], {
            encoding: "utf8", timeout: 300_000, stdio: "inherit", env: prefetchEnv, cwd: root,
        });
        assert.equal(cacheMarker(cache).length, 1, "prefetch did not materialize a cache");
        const { init } = await acpInitialize(bin, baseEnv({
            DSH_ACP_CACHE_DIR: cache,
            DSH_ACP_REGISTRY: "http://127.0.0.1:1",
        }));
        assert.equal(init.agentInfo.name, "dsh-acp");
        return "prefetch warmed cache; first ACP session ran offline";
    });

    // --- 7 explicit --dsh-path must not download ---
    await runCase("standalone/explicit-dsh-path-no-download", async () => {
        const host = resolve("node_modules/@deepseek-ai/dsh");
        assert(existsSync(join(host, "package.json")), "dev dsh tree missing; cannot exercise --dsh-path");
        const cache = join(root, "cache-dshpath");
        mkdirSync(cache);
        const { init, stderr } = await acpInitialize(bin, baseEnv({
            DSH_ACP_CACHE_DIR: cache,
            DSH_ACP_RUNTIME_PACK: runtimePack,
            DSH_ACP_REGISTRY: "http://127.0.0.1:1",
            DSH_PATH: host,
        }));
        assert.equal(init.agentInfo.name, "dsh-acp");
        assert.equal(cacheMarker(cache).length, 0, "explicit DSH_PATH still materialized the private runtime");
        assert(!/standalone runtime: (preparing|fetching)/.test(stderr), "explicit DSH_PATH still acquired the runtime");
        assert.match(stderr, /via --dsh-path\/DSH_PATH|via DSH_PATH/);
        return "explicit host used; cache stayed empty";
    });

    // --- 8 concurrent prefetch ---
    await runCase("standalone/concurrent-prefetch", async () => {
        const cache = join(root, "cache-concurrent");
        const env = baseEnv({ DSH_ACP_CACHE_DIR: cache, DSH_ACP_RUNTIME_PACK: runtimePack });
        const kids = Array.from({ length: 3 }, () => spawn(process.execPath, [bin, "--prefetch-runtime"], {
            env, cwd: root, stdio: ["ignore", "pipe", "pipe"],
        }));
        const codes = await Promise.all(kids.map((c) => once(c, "exit").then(([code]) => code)));
        assert(codes.every((c) => c === 0), `prefetch exits: ${codes.join(",")}`);
        assert.equal(cacheMarker(cache).length, 1, `expected one cache tree, got ${cacheMarker(cache).join(",")}`);
        const leftover = existsSync(cache) ? readdirSync(cache).filter((n) => n.endsWith(".lock") || n.startsWith(".extract-")) : [];
        assert.equal(leftover.length, 0, `leftover lock/extract: ${leftover.join(",")}`);
        return `3 processes, 1 cache tree, exits ${codes.join(",")}`;
    });

    // --- 9 checksum / 404 / corrupt cache recovery ---
    await runCase("standalone/checksum-mismatch", async () => {
        const bad = join(root, "bad-runtime.tgz");
        writeFileSync(bad, "this is not the pinned archive\n");
        const cache = join(root, "cache-badsum");
        try {
            await acpInitialize(bin, baseEnv({
                DSH_ACP_CACHE_DIR: cache,
                DSH_ACP_RUNTIME_TARBALL: bad,
            }), 30_000);
            throw new Error("expected checksum failure to refuse boot");
        } catch (error) {
            const text = String(error.message);
            assert(/integrity check failed|expected sha256|RuntimeUnavailable|could not be acquired|pinned standalone/i.test(text), text);
            assert.equal(cacheMarker(cache).length, 0, "bad archive was still cached");
            return "refused boot, cache empty";
        }
    });

    await runCase("standalone/404-then-recover", async () => {
        const cache = join(root, "cache-404");
        try {
            await acpInitialize(bin, baseEnv({
                DSH_ACP_CACHE_DIR: cache,
                DSH_ACP_REGISTRY: "http://127.0.0.1:1",
            }), 30_000);
            throw new Error("expected 404/unreachable registry to refuse boot");
        } catch (error) {
            const text = String(error.message);
            assert(/cannot fetch|ECONNREFUSED|HTTP|could not be acquired|pinned standalone|fetch/i.test(text), text);
            assert.equal(cacheMarker(cache).length, 0);
        }
        const { init } = await acpInitialize(bin, baseEnv({
            DSH_ACP_CACHE_DIR: cache,
            DSH_ACP_RUNTIME_PACK: runtimePack,
        }));
        assert.equal(init.agentInfo.name, "dsh-acp");
        assert.equal(cacheMarker(cache).length, 1);
        return "unreachable registry refused; local pack recovered";
    });

    await runCase("standalone/corrupt-cache-recovers", async () => {
        const cache = join(root, "cache-corrupt");
        const env = baseEnv({ DSH_ACP_CACHE_DIR: cache, DSH_ACP_RUNTIME_PACK: runtimePack });
        execFileSync(process.execPath, [bin, "--prefetch-runtime"], { env, timeout: 300_000, stdio: "inherit", cwd: root });
        const [name] = cacheMarker(cache);
        const tree = join(cache, name);
        rmSync(join(tree, ".dsh-acp-runtime"));
        writeFileSync(join(tree, "CORRUPT"), "truncated\n");
        const { init } = await acpInitialize(bin, env);
        assert.equal(init.agentInfo.name, "dsh-acp");
        assert(existsSync(join(tree, ".dsh-acp-runtime")) || cacheMarker(cache).length === 1);
        return "unmarked/corrupt tree was replaced and initialize succeeded";
    });

    // --- 1 plugin add (requires a dsh host binary) ---
    if (dshBin && existsSync(dshBin)) {
        await runCase("plugin/dsh-plugin-add", async () => {
            const report = execFileSync(process.execPath, [
                fileURL(import.meta, "./profile-smoke.mjs"),
                dshBin,
                shell,
            ], { encoding: "utf8", timeout: 180_000, stdio: "pipe", cwd: root });
            // profile-smoke prints PROFILE_SMOKE_OK and now asserts no runtime leak.
            assert.match(report, /PROFILE_SMOKE_OK/);
            return "profile-smoke initialize + no runtime artifact under DSH_HOME/cache";
        });
    } else {
        record("plugin/dsh-plugin-add", "skip", "no --dsh binary given");
    }
} finally {
    const summary = {
        root,
        platform: `${process.platform}/${process.arch}`,
        node: process.version,
        results,
        passed: results.filter((r) => r.status === "pass").length,
        failed: results.filter((r) => r.status === "fail").length,
        skipped: results.filter((r) => r.status === "skip" || r.status === "untested").length,
    };
    writeFileSync(join(root, "report.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`[install-matrix] report: ${join(root, "report.json")}`);
    console.log(`[install-matrix] ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped/untested`);
    // Keep the root on failure for evidence; delete on full success.
    if (summary.failed === 0) rmSync(root, { recursive: true, force: true });
    if (summary.failed > 0) process.exitCode = 1;
}

function fileURL(meta, rel) {
    return resolve(dirname(decodeURIComponent(new URL(meta.url).pathname)), rel);
}
