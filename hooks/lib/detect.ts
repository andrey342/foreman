// What a repo holds, read from listings and a few files (D-71, D-72, D-73,
// D-74): its stack, the gates it runs, the command that installs its
// dependencies, its own rules (CLAUDE.md, AGENTS.md, skills, hooks…), and what
// makes a worktree a bad idea (submodules, services by path). Pure:
// register.tsx lists the folders and reads the files; `setup` and `go` use it.

export type RepoFacts = {
  /** The names in the repo's root folder. */
  root: readonly string[]
  /** The names in its `.claude/` folder, when there is one. */
  claude?: readonly string[]
  /** The texts of the files that say how the repo works, by root-relative name (package.json, CLAUDE.md, AGENTS.md, CONTRIBUTING.md). */
  texts?: Readonly<Record<string, string>>
}

export type Detected = {
  stacks: string[]
  /** Commands the repo's checks run, each ready to run as written. */
  gates: string[]
  /** The command that installs the dependencies a fresh worktree lacks. */
  install?: string
  /** The repo's own rules: files and `.claude/` folders that steer Claude here. */
  rules: string[]
  submodules: boolean
  /** docker-compose / compose files: services that may depend on the checkout's path. */
  services: boolean
  /** What the rules say about delivery, and the words that said it. */
  delivery: { mode: 'pr' | 'branch' | 'none'; why: string }
}

const has = (names: readonly string[], name: string) => names.some(n => n.toLowerCase() === name.toLowerCase())

function packageScripts(text: string | undefined): Record<string, string> {
  if (!text) return {}
  try {
    const raw = JSON.parse(text) as { scripts?: unknown }
    return typeof raw.scripts === 'object' && raw.scripts !== null ? (raw.scripts as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** The Node package manager the lockfile names. */
function nodeTool(root: readonly string[]): 'npm' | 'pnpm' | 'yarn' {
  if (has(root, 'pnpm-lock.yaml')) return 'pnpm'
  if (has(root, 'yarn.lock')) return 'yarn'
  return 'npm'
}

/** A gate per check the repo declares, in a stable order. */
function gatesOf(f: RepoFacts, stacks: string[]): string[] {
  const out: string[] = []
  if (stacks.includes('node')) {
    const scripts = packageScripts(f.texts?.['package.json'])
    const tool = nodeTool(f.root)
    if (scripts.test && !/no test specified/i.test(scripts.test)) out.push(tool === 'npm' ? 'npm test' : `${tool} test`)
    if (scripts.lint) out.push(tool === 'npm' ? 'npm run lint' : `${tool} lint`)
  }
  if (stacks.includes('dotnet')) {
    const sln = f.root.find(n => /\.sln$/i.test(n))
    out.push(sln ? `dotnet test ${sln}` : 'dotnet test')
  }
  if (stacks.includes('python')) out.push('python -m pytest')
  if (stacks.includes('go')) out.push('go test ./...')
  if (stacks.includes('rust')) out.push('cargo test')
  return out
}

function installOf(f: RepoFacts, stacks: string[]): string | undefined {
  if (stacks.includes('node')) {
    if (has(f.root, 'pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile'
    if (has(f.root, 'yarn.lock')) return 'yarn install'
    return has(f.root, 'package-lock.json') ? 'npm ci' : 'npm install'
  }
  if (stacks.includes('dotnet')) return 'dotnet restore'
  if (stacks.includes('python')) return 'pip install -e .'
  if (stacks.includes('go')) return 'go mod download'
  if (stacks.includes('rust')) return 'cargo fetch'
  return undefined
}

const PR_RE = /\b(?:pull request|pull-request|gh pr create|open a pr|abre una pr|merge request)\b/i
const NO_BRANCH_RE = /\b(?:no (?:crees|creas|cre[ée]is) ramas|do not create branches|don't create branches|never create branches|no branches)\b/i
const HUMAN_GATE_RE = /\b(?:(?:human|user|person) (?:approval|authori[sz]ation)|autorizaci[oó]n (?:humana|del usuario)|ask before (?:you )?(?:push|merg)|pide (?:permiso|autorizaci[oó]n) antes de (?:hacer )?(?:push|merge))\b/i

function deliveryOf(texts: Readonly<Record<string, string>>): Detected['delivery'] {
  const rules = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'].map(n => [n, texts[n]] as const).filter((x): x is readonly [string, string] => typeof x[1] === 'string')
  for (const [name, text] of rules) {
    const m = NO_BRANCH_RE.exec(text)
    if (m) return { mode: 'none', why: `${name}: "${m[0]}"` }
  }
  for (const [name, text] of rules) {
    const m = HUMAN_GATE_RE.exec(text)
    if (m) return { mode: 'branch', why: `${name}: "${m[0]}" (publishing waits for a person)` }
  }
  for (const [name, text] of rules) {
    const m = PR_RE.exec(text)
    if (m) return { mode: 'pr', why: `${name}: "${m[0]}"` }
  }
  return { mode: 'branch', why: 'no delivery rule found: nothing is published (the safe default)' }
}

/** What the repo holds and what that means for a plan run (D-71…D-74). */
export function detect(f: RepoFacts): Detected {
  const stacks: string[] = []
  if (has(f.root, 'package.json')) stacks.push('node')
  if (f.root.some(n => /\.(?:sln|csproj|fsproj)$/i.test(n))) stacks.push('dotnet')
  if (has(f.root, 'pyproject.toml') || has(f.root, 'setup.py') || has(f.root, 'requirements.txt')) stacks.push('python')
  if (has(f.root, 'go.mod')) stacks.push('go')
  if (has(f.root, 'Cargo.toml')) stacks.push('rust')
  const rules: string[] = []
  for (const n of ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', '.mcp.json']) if (has(f.root, n)) rules.push(n)
  for (const n of ['rules', 'skills', 'agents', 'hooks', 'settings.json']) if (f.claude && has(f.claude, n)) rules.push(`.claude/${n}`)
  return {
    stacks,
    gates: gatesOf(f, stacks),
    ...(installOf(f, stacks) ? { install: installOf(f, stacks) as string } : {}),
    rules,
    submodules: has(f.root, '.gitmodules'),
    services: f.root.some(n => /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i.test(n)),
    delivery: deliveryOf(f.texts ?? {}),
  }
}
