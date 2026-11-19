/** Windows-safe CLI main-guard: drive-letter case must not block execution. */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function isExecutedAsCli(importMetaUrl, argv1 = process.argv[1], platform = process.platform) {
    if (!importMetaUrl || !argv1) return false;
    const left = canonicalizeFileUrl(toFileUrl(importMetaUrl, platform), platform);
    const right = canonicalizeFileUrl(toFileUrl(argv1, platform), platform);
    return Boolean(left && right && left === right);
}

function toFileUrl(pathOrUrl, platform) {
    if (pathOrUrl.startsWith("file:")) {
        try { return new URL(pathOrUrl).href; } catch { return null; }
    }
    if (platform === "win32" && process.platform !== "win32") {
        const unified = pathOrUrl.replaceAll("\\", "/");
        const drive = unified.match(/^\/?([A-Za-z]:.*)$/);
        return drive ? `file:///${drive[1]}` : null;
    }
    try {
        return pathToFileURL(resolve(pathOrUrl)).href;
    } catch {
        return null;
    }
}

function canonicalizeFileUrl(href, platform) {
    if (!href) return null;
    if (platform !== "win32") return href;
    try {
        const url = new URL(href);
        url.pathname = url.pathname.replace(/^\/[A-Za-z]:/, (match) => match.toLowerCase());
        return url.href;
    } catch {
        return href.replace(/^file:\/\/\/[A-Za-z]:/, (match) => match.toLowerCase());
    }
}
