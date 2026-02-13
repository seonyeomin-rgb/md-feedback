import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['mcp/server.ts'],
  bundle: true,
  outfile: 'dist/mcp-server.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
  external: [],
  sourcemap: true,
})
