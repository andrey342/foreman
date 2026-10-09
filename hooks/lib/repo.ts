// Paths and the profile's resolved values.

import type { ParsedProfile } from './profile'

export function join(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`
}

export function claudeExe(p: ParsedProfile): string {
  return p.profile.claudeExe ?? 'claude'
}
