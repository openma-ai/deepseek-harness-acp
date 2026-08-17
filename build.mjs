import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Keep all node_modules dependencies external; only bundle our own sources.
  packages: 'external',
};

await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
// The bridge as a dsh bundle plugin (dsh plugin --profile acp add …): bare
// @deepseek-ai imports stay external and resolve inside the profile.
await build({ ...shared, entryPoints: ['src/bundle.ts'], outfile: 'dist/bridge.js' });
// Reusable transport-independent server provider consumed by surface plugins.
await build({ ...shared, entryPoints: ['src/server.ts'], outfile: 'dist/server.js' });
// Complete embeddable Cordis plugin plus the ordinary profile's stdio adapter.
await build({ ...shared, entryPoints: ['src/plugin.ts'], outfile: 'dist/plugin.js' });
await build({ ...shared, entryPoints: ['src/stdio.ts'], outfile: 'dist/stdio.js' });
