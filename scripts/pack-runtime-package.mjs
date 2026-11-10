/**
 * Pack the publishable runtime package from an existing runtime archive.
 *
 * `npm run runtime:pack` builds the archive and the runtime package in one
 * go; this script only re-packs the runtime package, so a CI job that
 * already has `vendor/dsh-runtime.tgz` does not have to rebuild the runtime
 * tree.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packRuntimePackage } from "./runtime-package.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

console.log(`runtime package: ${packRuntimePackage({ root, vendor: join(root, "vendor"), shellVersion: manifest.version })}`);
