// rx-claude-matrix-bridge — esbuild bundler.
// Produces dist/server.js + dist/daemon.js as standalone ESM bundles
// for Node 20+. All deps (@modelcontextprotocol/sdk etc.) are inlined.
// Native node built-ins stay external.

import { build } from 'esbuild'
import { rmSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  minify: false,
  sourcemap: false,
  // Banner makes the ESM bundle work with require()-style globals that
  // some transitive deps (rare) might expect.
  banner: {
    js:
      `import { createRequire as __mxCreateRequire } from 'node:module';\n` +
      `const require = __mxCreateRequire(import.meta.url);\n`,
  },
}

await build({
  ...common,
  entryPoints: { server: 'server.ts' },
  outdir: 'dist',
})

await build({
  ...common,
  entryPoints: { daemon: 'daemon.ts' },
  outdir: 'dist',
})

console.log('built dist/server.js + dist/daemon.js')
