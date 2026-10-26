import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Keep all node_modules dependencies external; only bundle our own sources.
  packages: 'external',
};

await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
// Thin standalone bootstrap: resolve one DSH tree and register a synchronous
// Node module hook before the main CLI evaluates any @deepseek-ai imports.
await build({ ...shared, entryPoints: ['src/bin.ts'], outfile: 'dist/bin.js' });
// The bridge as a dsh bundle plugin (dsh plugin --profile acp add …): bare
// @deepseek-ai imports stay external and resolve inside the profile.
await build({ ...shared, entryPoints: ['src/bundle.ts'], outfile: 'dist/bridge.js' });
// Reusable transport-independent server provider consumed by surface plugins.
await build({ ...shared, entryPoints: ['src/server.ts'], outfile: 'dist/server.js' });
// Complete embeddable Cordis plugin plus the ordinary profile's stdio adapter.
await build({ ...shared, entryPoints: ['src/plugin.ts'], outfile: 'dist/plugin.js' });
await build({ ...shared, entryPoints: ['src/stdio.ts'], outfile: 'dist/stdio.js' });
// Built-in multi-root replacements: a session scope plus the fs and sandbox
// providers that read it. Separate entries because the profile patch mounts
// each as its own Cordis row (the upstream rows are disabled first).
await build({ ...shared, entryPoints: ['src/multi-root/index.ts'], outfile: 'dist/multi-root.js' });
await build({ ...shared, entryPoints: ['src/multi-root/fs.ts'], outfile: 'dist/multi-root-fs.js' });
await build({ ...shared, entryPoints: ['src/multi-root/sandbox.ts'], outfile: 'dist/multi-root-sandbox.js' });
