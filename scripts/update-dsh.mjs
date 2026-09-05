import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const npm = (args) => JSON.parse(execFileSync("npm", [...args, "--json", "--registry=https://registry.npmjs.org"], { encoding: "utf8" }));
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const latest = npm(["view", "@deepseek-ai/dsh", "dist-tags.latest"]);
const supported = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
if (!supported.test(latest)) throw new Error(`Refusing non-release dsh dist-tag: ${latest}`);
if (latest === manifest.dshAcp.standaloneDsh) {
    console.log(`Bundled dsh is already ${latest}`);
    process.exit(0);
}
const versions = npm(["view", "@deepseek-ai/dsh", "versions"]);
const latestIndex = versions.indexOf(latest);
if (latestIndex < 0) throw new Error("Latest dist-tag is absent from published versions");
if (versions.indexOf(manifest.dshAcp.standaloneDsh) > latestIndex) {
    console.log("Bundled dsh is newer than the latest dist-tag; refusing to downgrade");
    process.exit(0);
}
const matrix = versions.slice(0, latestIndex + 1).filter((version) => supported.test(version)).slice(-3);
if (matrix.length !== 3) throw new Error("Need three published release/RC versions");
const previous = manifest.dshAcp.standaloneDsh;
manifest.dshAcp.standaloneDsh = latest;
for (const name of Object.keys(manifest.devDependencies)) {
    if (name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-")) manifest.devDependencies[name] = latest;
}
const runtime = JSON.parse(readFileSync("runtime/package.json", "utf8"));
runtime.dependencies["@deepseek-ai/dsh"] = latest;
writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync("runtime/package.json", `${JSON.stringify(runtime, null, 2)}\n`);
writeFileSync("runtime/compatibility.json", `${JSON.stringify(matrix)}\n`);
console.log(`Upgrade dsh ${previous} -> ${latest}; profile matrix: ${matrix.join(", ")}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=true\nversion=${latest}\nprevious=${previous}\n`);
