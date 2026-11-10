/**
 * Types for the pack-time helpers in `scripts/runtime-package.mjs`.
 *
 * The pack scripts are plain ESM (they run under plain `node`), so their
 * shapes are declared here for the TypeScript tests that cover them.
 */

export interface ExternalPackageRecord {
    version: string;
    integrity?: string;
    os?: string[];
    cpu?: string[];
}

export interface RuntimePackageManifest {
    name: string;
    version: string;
    description: string;
    license: string;
    publishConfig: { access: string };
    files: string[];
    engines: { node: string };
}

export declare const RUNTIME_PACKAGE_NAME: string;

export declare function runtimePackageManifest(shellVersion: string): RuntimePackageManifest;

export declare function runtimePackageTarballName(shellVersion: string): string;

export declare function externalPackageRecords(lock: unknown): Record<string, ExternalPackageRecord>;

export declare function packRuntimePackage(options: {
    root: string;
    vendor: string;
    shellVersion: string;
}): string;
