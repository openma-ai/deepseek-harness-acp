import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const runtimeRequire = createRequire(process.argv[2]);
assert(runtimeRequire("koffi").version);
const png = await runtimeRequire("sharp")({
    create: { width: 1, height: 1, channels: 3, background: "red" },
}).png().toBuffer();
assert(png.length > 0);
const { rgPath } = runtimeRequire("@vscode/ripgrep");
assert.match(execFileSync(rgPath, ["--version"], { encoding: "utf8" }), /ripgrep/);
