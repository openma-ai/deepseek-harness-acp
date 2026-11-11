import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/**
 * List names in a gzipped ustar archive without shelling out to system `tar`.
 * GNU tar treats a Windows path like `D:\foo.tgz` as host `D`, which broke
 * the standalone smoke on windows-latest (CI run 42794459100).
 */
export function listTarball(file) {
    const buf = gunzipSync(readFileSync(file));
    const names = [];
    let offset = 0;
    while (offset + 512 <= buf.length) {
        const header = buf.subarray(offset, offset + 512);
        if (header[0] === 0) break;
        const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
        const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
        const sizeField = header.subarray(124, 136).toString("ascii").replace(/\0/g, " ").trim();
        const size = parseInt(sizeField || "0", 8);
        const full = prefix ? `${prefix}/${name}` : name;
        if (full) names.push(full);
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return names;
}

/**
 * Read named files from a gzipped ustar archive. `wanted` is a list of
 * exact entry names (`package/vendor/runtime.json`). Missing names are
 * omitted from the result rather than throwing, so the caller can assert.
 */
export function readTarGzEntries(file, wanted) {
    const want = new Set(wanted);
    const buf = gunzipSync(readFileSync(file));
    const out = new Map();
    let offset = 0;
    while (offset + 512 <= buf.length) {
        const header = buf.subarray(offset, offset + 512);
        if (header[0] === 0) break;
        const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
        const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
        const sizeField = header.subarray(124, 136).toString("ascii").replace(/\0/g, " ").trim();
        const size = parseInt(sizeField || "0", 8);
        const full = prefix ? `${prefix}/${name}` : name;
        const start = offset + 512;
        if (full && want.has(full)) out.set(full, Buffer.from(buf.subarray(start, start + size)));
        offset += 512 + Math.ceil(size / 512) * 512;
        if (out.size === want.size) break;
    }
    return out;
}
