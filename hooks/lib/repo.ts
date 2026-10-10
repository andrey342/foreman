// Paths.

export function join(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`
}
