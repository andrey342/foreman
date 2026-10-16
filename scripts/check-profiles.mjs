// Parses every profiles/*.json with the plugin's own parseProfile and fails on any warning.
// Usage: node scripts/check-profiles.mjs [file ...]   (Node 22.6+ strips the TypeScript types)
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProfile } from '../hooks/lib/profile.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(join(root, 'profiles')).filter(f => f.endsWith('.json')).map(f => join(root, 'profiles', f))
let bad = 0
for (const f of files) {
  const { warnings, profile } = parseProfile(readFileSync(f, 'utf8'))
  console.log(`${f}: ${warnings.length} warning(s); version ${profile.version}; ${profile.guards.rules.length} guard(s), scope ${profile.guards.scope}; ${profile.limits.reviewRounds} review round(s); delivery ${profile.delivery.mode}`)
  for (const w of warnings) console.log(`  - ${w}`)
  bad += warnings.length
}
process.exit(bad ? 1 : 0)
