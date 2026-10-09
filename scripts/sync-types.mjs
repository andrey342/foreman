// Copies this build's plugin API declarations into .claude-plugin/types/ when
// the engine has not laid them there yet (it does on an interactive load).
// Usage: node scripts/sync-types.mjs [--force] [path/to/claude-code.d.ts]
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const root = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const target = join(root, '.claude-plugin', 'types', 'claude-code', 'index.d.ts')
const force = process.argv.includes('--force')
const given = process.argv.slice(2).find(a => !a.startsWith('--'))

if (existsSync(target) && !force) {
  console.log(`types present: ${target}`)
  process.exit(0)
}

function newestBundled() {
  const base = join(tmpdir(), 'claude', 'bundled-skills')
  if (!existsSync(base)) return undefined
  let best
  for (const version of readdirSync(base)) {
    for (const hash of readdirSync(join(base, version))) {
      const file = join(base, version, hash, 'plugin-authoring', 'types', 'claude-code.d.ts')
      if (existsSync(file) && (!best || statSync(file).mtimeMs > statSync(best).mtimeMs)) best = file
    }
  }
  return best
}

const source = given ?? newestBundled()
if (!source) {
  console.error('No claude-code.d.ts found: load the plugin once with `claude --plugin-dir .` or pass the file.')
  process.exit(1)
}
mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(`copied ${source} -> ${target}`)
