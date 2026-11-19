#!/usr/bin/env node
/**
 * Wait until the exact runtime tarball just published is visible on npmjs.
 * The shell must not be published while npm is still processing the runtime.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readTarGzEntries } from "./list-tarball.mjs";

export const PUBLIC_REGISTRY = "https://registry.npmjs.org";
export const RUNTIME_PACKAGE_NAME = "@openma/deepseek-harness-acp-runtime";

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const now = () => Date.now();

export function artifactIdentity(tarball) {
    const packageJson = readTarGzEntries(tarball, ["package/package.json"]).get("package/package.json");
    if (!packageJson) throw new Error(`tarball is missing package/package.json: ${tarball}`);
    const pkg = JSON.parse(packageJson.toString("utf8"));
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
        throw new Error(`tarball is missing package name or version: ${tarball}`);
    }
    const bytes = readFileSync(tarball);
    return {
        name: pkg.name,
        version: pkg.version,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sha1: createHash("sha1").update(bytes).digest("hex"),
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
}

function exactMetadata(body, version) {
    if (body?.version === version) return body;
    if (body?.versions?.[version]?.version === version) return body.versions[version];
    return undefined;
}

class DeadlineExceededError extends Error {
    constructor() { super("timed out: registry request exceeded its deadline"); this.name = "DeadlineExceededError"; }
}

class PermanentRegistryError extends Error {
    constructor(message) { super(message); this.name = "PermanentRegistryError"; }
}

async function fetchBodyWithinDeadline(fetchImpl, url, deadline, nowImpl, read) {
    const remaining = deadline - nowImpl();
    if (remaining <= 0) throw new DeadlineExceededError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
        const response = await fetchImpl(url, { signal: controller.signal });
        const body = await read(response);
        if (nowImpl() > deadline) throw new DeadlineExceededError();
        return { response, body };
    } catch (error) {
        if (error?.name === "AbortError") throw new DeadlineExceededError();
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

export async function verifyPublishedArtifact({ tarball, registryBaseUrl = PUBLIC_REGISTRY, timeoutMs = 30_000, fetchImpl = fetch, nowImpl = now }) {
    const identity = artifactIdentity(resolve(tarball));
    const base = registryBaseUrl.replace(/\/$/, "");
    const metadataUrl = `${base}/${encodeURIComponent(identity.name)}/${encodeURIComponent(identity.version)}`;
    const deadline = nowImpl() + timeoutMs;
    const { response: metadataResponse, body: metadata } = await fetchBodyWithinDeadline(fetchImpl, metadataUrl, deadline, nowImpl, (response) => {
        if (response.status === 401 || response.status === 403) throw new PermanentRegistryError(`registry metadata returned HTTP ${response.status}`);
        return response.ok ? response.json() : undefined;
    });
    if (metadataResponse.status === 404) return undefined;
    if (!metadataResponse.ok) throw new Error(`registry metadata returned HTTP ${metadataResponse.status}`);
    const exact = exactMetadata(metadata, identity.version);
    if (!exact) throw new Error(`metadata did not contain exact version ${identity.version}`);
    const dist = exact.dist;
    if (!dist?.tarball) throw new Error("exact artifact metadata has no dist.tarball");
    if (dist.integrity && dist.integrity !== identity.integrity) throw new Error(`registry integrity mismatch for ${identity.name}@${identity.version}`);
    if (dist.shasum && dist.shasum !== identity.sha1) throw new Error(`registry shasum mismatch for ${identity.name}@${identity.version}`);
    const { response: tarballResponse, body: bytes } = await fetchBodyWithinDeadline(fetchImpl, new URL(dist.tarball, `${base}/`).href, deadline, nowImpl, (response) => {
        if (response.status === 401 || response.status === 403) throw new PermanentRegistryError(`registry tarball returned HTTP ${response.status}`);
        return response.ok ? response.arrayBuffer() : undefined;
    });
    if (tarballResponse.status === 404) return undefined;
    if (!tarballResponse.ok) throw new Error(`published tarball returned HTTP ${tarballResponse.status}`);
    const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    if (sha256 !== identity.sha256) throw new Error(`downloaded artifact sha256 mismatch for ${identity.name}@${identity.version}`);
    return { ...identity, metadataUrl, tarballUrl: dist.tarball };
}

/**
 * @param {object} options
 * @param {string} options.runtimeTarball
 * @param {string} [options.registryBaseUrl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms:number)=>Promise<void>} [options.sleepImpl]
 * @param {()=>number} [options.nowImpl]
 */
export async function waitForRuntimeRegistry({
    runtimeTarball,
    registryBaseUrl = PUBLIC_REGISTRY,
    timeoutMs = 90 * 60 * 1000,
    intervalMs = 30 * 1000,
    fetchImpl = fetch,
    sleepImpl = sleep,
    nowImpl = now,
}) {
    const identity = artifactIdentity(resolve(runtimeTarball));
    if (identity.name !== RUNTIME_PACKAGE_NAME) throw new Error(`runtime tarball is not ${RUNTIME_PACKAGE_NAME}@<version>`);
    const base = registryBaseUrl.replace(/\/$/, "");
    const metadataUrl = `${base}/${encodeURIComponent(identity.name)}/${encodeURIComponent(identity.version)}`;
    const deadline = nowImpl() + timeoutMs;
    let lastPending = "registry metadata is not available yet";

    while (nowImpl() <= deadline) {
        try {
            const { response: metadataResponse, body: metadata } = await fetchBodyWithinDeadline(fetchImpl, metadataUrl, deadline, nowImpl, (response) => {
                if (response.status === 401 || response.status === 403) throw new PermanentRegistryError(`registry metadata returned HTTP ${response.status}`);
                return response.ok ? response.json() : undefined;
            });
            if (metadataResponse.status === 404) {
                lastPending = `metadata returned 404 for ${identity.name}@${identity.version}`;
            } else if (!metadataResponse.ok) {
                lastPending = `metadata returned HTTP ${metadataResponse.status}`;
            } else {
                const exact = exactMetadata(metadata, identity.version);
                if (!exact) throw new Error(`metadata did not contain exact version ${identity.version}`);
                const dist = exact.dist;
                if (!dist?.tarball) throw new Error("exact runtime metadata has no dist.tarball");
                if (dist.integrity && dist.integrity !== identity.integrity) {
                    throw new Error(`registry integrity mismatch for ${identity.name}@${identity.version}`);
                }
                if (dist.shasum && dist.shasum !== identity.sha1) {
                    throw new Error(`registry shasum mismatch for ${identity.name}@${identity.version}`);
                }
                const { response: tarballResponse, body: bytes } = await fetchBodyWithinDeadline(fetchImpl, new URL(dist.tarball, `${base}/`).href, deadline, nowImpl, (response) => {
                    if (response.status === 401 || response.status === 403) throw new PermanentRegistryError(`registry tarball returned HTTP ${response.status}`);
                    return response.ok ? response.arrayBuffer() : undefined;
                });
                if (!tarballResponse.ok) {
                    lastPending = `tarball returned HTTP ${tarballResponse.status}`;
                } else {
                    const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
                    if (sha256 !== identity.sha256) throw new Error(`downloaded runtime sha256 mismatch for ${identity.name}@${identity.version}`);
                    return { ...identity, metadataUrl, tarballUrl: dist.tarball };
                }
            }
        } catch (error) {
            if (error instanceof DeadlineExceededError || error instanceof PermanentRegistryError) throw error;
            if (error?.message?.includes("integrity mismatch") || error?.message?.includes("shasum mismatch") || error?.message?.includes("sha256 mismatch") || error?.message?.includes("did not contain exact") || error?.message?.includes("no dist.tarball")) throw error;
            lastPending = `registry request failed: ${error?.message || error}`;
        }
        if (nowImpl() >= deadline) break;
        await sleepImpl(Math.min(intervalMs, Math.max(0, deadline - nowImpl())));
    }
    throw new Error(`timed out waiting for public runtime ${identity.name}@${identity.version}: ${lastPending}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
    const runtimeTarball = value("--runtime");
    if (!runtimeTarball) {
        console.error("usage: node scripts/wait-for-runtime-registry.mjs --runtime <runtime.tgz>");
        process.exit(2);
    }
    await waitForRuntimeRegistry({ runtimeTarball, timeoutMs: Number(value("--timeout-ms") ?? 90 * 60 * 1000), intervalMs: Number(value("--interval-ms") ?? 30 * 1000) });
    console.log(`RUNTIME_REGISTRY_VISIBLE ${runtimeTarball}`);
}
