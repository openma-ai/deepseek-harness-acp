/**
 * Package version, read from package.json at module load so it can never
 * drift from the published artifact (the tarball ships package.json, and
 * both dist/ entries sit one level below it).
 */
import { createRequire } from "node:module";

export const VERSION: string = (
    createRequire(import.meta.url)("../package.json") as { version: string }
).version;
