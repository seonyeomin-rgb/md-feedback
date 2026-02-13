/**
 * Sync shared files from md-feedback webapp to this extension.
 * Run: node scripts/sync-shared.mjs
 */
import { copyFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const source = resolve(root, '..', 'md-feedback', 'src')
const target = resolve(root, 'shared')

const files = [
  { from: 'types.ts', to: 'types.ts' },
  { from: 'lib/context-generator.ts', to: 'context-generator.ts' },
  { from: 'lib/markdown-roundtrip.ts', to: 'markdown-roundtrip.ts' },
]

for (const { from, to } of files) {
  const src = resolve(source, from)
  const dst = resolve(target, to)

  if (!existsSync(src)) {
    console.warn(`  SKIP  ${from} (not found)`)
    continue
  }

  copyFileSync(src, dst)
  console.log(`  SYNC  ${from} → shared/${to}`)
}

console.log('\nDone. Remember to fix import paths (../types → ./types) after syncing.')
