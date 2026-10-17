// Where a plan's files live (D-70) and what a repo holds (D-71…D-74).
import { describe, expect, test } from 'claude-code/testing'
import { detect } from './lib/detect'
import { planDir, planFile, storageOf } from './lib/storage'

describe('storage (D-70)', () => {
  test('under git: <common dir>/foreman/<slug>, with the work root\'s separators', async () => {
    const s = storageOf({ work: 'C:\\demo', gitCommonDir: 'C:/demo/.git', home: 'C:\\Users\\me' })
    expect(s).toEqual({ kind: 'git', base: 'C:\\demo\\.git\\foreman' })
    if (!s) return
    expect(planDir(s, 'plan')).toBe('C:\\demo\\.git\\foreman\\plan')
    expect(planFile(planDir(s, 'plan'), 'progress.md')).toBe('C:\\demo\\.git\\foreman\\plan\\progress.md')
    // from a worktree git names the main repository's folder: the same place
    expect(storageOf({ work: 'C:\\demo\\.claude\\worktrees\\x', gitCommonDir: 'C:/demo/.git' })?.base).toBe('C:\\demo\\.git\\foreman')
    expect(storageOf({ work: '/home/me/demo', gitCommonDir: '/home/me/demo/.git' })?.base).toBe('/home/me/demo/.git/foreman')
  })
  test('a repo\'s own runsDir wins; outside git the home folder', async () => {
    expect(storageOf({ work: 'C:\\demo', gitCommonDir: 'C:/demo/.git', runsDir: '.agents/runs' })).toEqual({ kind: 'runsDir', base: 'C:\\demo\\.agents\\runs' })
    expect(storageOf({ work: 'C:\\loose', home: 'C:\\Users\\me' })).toEqual({ kind: 'home', base: 'C:\\Users\\me\\.claude\\foreman' })
    expect(storageOf({ work: 'C:\\loose' })).toBe(undefined)
  })
})

describe('detect (D-71…D-74)', () => {
  test('.claude/settings.json is one of the repo\'s rules only when it holds more than turning plugins on (live round of Phase 5)', () => {
    const only = JSON.stringify({ extraKnownMarketplaces: { foreman: { source: { source: 'directory', path: 'C:/repos/foreman' } } }, enabledPlugins: { 'foreman@foreman': true } })
    expect(detect({ root: ['.claude'], claude: ['settings.json'], texts: { '.claude/settings.json': only } }).rules).toEqual([])
    const hooks = JSON.stringify({ hooks: { SessionStart: [] }, enabledPlugins: { 'foreman@foreman': true } })
    expect(detect({ root: ['.claude'], claude: ['settings.json', 'skills'], texts: { '.claude/settings.json': hooks } }).rules).toEqual(['.claude/skills', '.claude/settings.json'])
    // unread or not JSON: it may hold anything, so it counts
    expect(detect({ root: ['.claude'], claude: ['settings.json'] }).rules).toEqual(['.claude/settings.json'])
    expect(detect({ root: ['.claude'], claude: ['settings.json'], texts: { '.claude/settings.json': '{ oops' } }).rules).toEqual(['.claude/settings.json'])
  })

  test('a Node repo: npm gates from its scripts, npm ci for a lockfile, its rules', async () => {
    const d = detect({
      root: ['package.json', 'package-lock.json', 'CLAUDE.md', 'src', '.claude'],
      claude: ['skills', 'settings.json', 'hooks'],
      texts: { 'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }), 'CLAUDE.md': '# Rules\nDelivery is by pull request to main (`gh pr create`).' },
    })
    expect(d).toMatchObject({ stacks: ['node'], gates: ['npm test', 'npm run lint'], install: 'npm ci', submodules: false, services: false })
    expect(d.rules).toEqual(['CLAUDE.md', '.claude/skills', '.claude/hooks', '.claude/settings.json'])
    expect(d.delivery.mode).toBe('pr')
  })
  test('the npm placeholder test script is no gate; pnpm and yarn are named by their lockfiles', async () => {
    const placeholder = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })
    expect(detect({ root: ['package.json'], texts: { 'package.json': placeholder } }).gates).toEqual([])
    const vitest = JSON.stringify({ scripts: { test: 'vitest' } })
    expect(detect({ root: ['package.json', 'pnpm-lock.yaml'], texts: { 'package.json': vitest } })).toMatchObject({ gates: ['pnpm test'], install: 'pnpm install --frozen-lockfile' })
  })
  test('.NET, Python, Go, Rust', async () => {
    expect(detect({ root: ['App.sln', 'src'] })).toMatchObject({ stacks: ['dotnet'], gates: ['dotnet test App.sln'], install: 'dotnet restore' })
    expect(detect({ root: ['pyproject.toml'] }).gates).toEqual(['python -m pytest'])
    expect(detect({ root: ['go.mod'] }).gates).toEqual(['go test ./...'])
    expect(detect({ root: ['Cargo.toml'] }).gates).toEqual(['cargo test'])
  })
  test('submodules and compose files make a worktree risky; the delivery rules', async () => {
    expect(detect({ root: ['.gitmodules', 'docker-compose.dev.yml'] })).toMatchObject({ submodules: true, services: true })
    expect(detect({ root: ['AGENTS.md'], texts: { 'AGENTS.md': 'Push and PRs need human approval first.' } }).delivery.mode).toBe('branch')
    expect(detect({ root: ['CLAUDE.md'], texts: { 'CLAUDE.md': 'No crees ramas: todo va a main.' } }).delivery.mode).toBe('none')
    expect(detect({ root: [] }).delivery).toEqual({ mode: 'branch', why: 'no delivery rule found: nothing is published (the safe default)' })
  })
})
