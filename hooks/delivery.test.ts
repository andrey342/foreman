// Phase 4, pure: where a plan works (isolation.ts, D-71), how it is delivered
// (delivery.ts, D-72) and what its report says (report.ts, M4).
import { describe, expect, test } from 'claude-code/testing'
import type { ForemanCycle, ForemanPlanRun, ForemanReview, ForemanThread } from '../types'
import { NEVER_FLAGS, deliveredWords, deliveryMode, deliverySteps, existingPr, prUrl } from './lib/delivery'
import type { DeliveryFacts } from './lib/delivery'
import { DEFAULT_PREFIX, EXCLUDE_LINE, branchFor, branchPrefixes, freeBranch, gitArgv, inPlanWorktree, isolationFor, withExclude, worktreePath } from './lib/isolation'
import { reportMarkdown } from './lib/report'

/** foreman-lab's CLAUDE.md, as it is. */
const LAB_RULES = '# foreman-lab\n\n## Rules\n\n- One branch per task, named `fix/<slug>` or `feat/<slug>`, created from `main`. Never commit to `main` directly.\n- Every behaviour change comes with a test in `test/` (see the `lab-conventions` skill).\n- Delivery is by pull request to `main` (`gh pr create`); a human merges.\n'

describe('the plan\'s tree (D-71)', () => {
  test('the worktree lives under the main tree, and is told apart from the person\'s own folders', async () => {
    expect(worktreePath('C:\\demo', 'plan')).toBe('C:\\demo\\.claude\\worktrees\\foreman-plan')
    expect(worktreePath('/home/a/repo', 'p-2')).toBe('/home/a/repo/.claude/worktrees/foreman-p-2')
    expect(inPlanWorktree('C:\\demo\\.claude\\worktrees\\foreman-plan', 'C:\\demo')).toBe(true)
    expect(inPlanWorktree('c:/demo/.claude/worktrees/foreman-plan/src', 'C:\\demo')).toBe(true)
    expect(inPlanWorktree('C:\\demo\\.claude\\worktrees\\mine', 'C:\\demo')).toBe(false)
    expect(inPlanWorktree('C:\\demo', 'C:\\demo')).toBe(false)
  })
  test('.git/info/exclude gets foreman\'s line once', async () => {
    expect(withExclude(undefined)).toBe(`# foreman's plan worktrees (D-71)\n${EXCLUDE_LINE}\n`)
    expect(withExclude('# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n')).toBe(`# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n# foreman's plan worktrees (D-71)\n${EXCLUDE_LINE}\n`)
    expect(withExclude(`*.log\n${EXCLUDE_LINE}\n`)).toBe(undefined)
    expect(withExclude('.claude/worktrees/\n')).toBe(undefined)
  })
  test('the branch: the prefix the repo\'s rules name (foreman-lab: fix/ or feat/), by what the plan does; foreman/ when they name none', async () => {
    expect(branchPrefixes({ 'CLAUDE.md': LAB_RULES })).toEqual(['fix/', 'feat/'])
    // a path that looks like a prefix on a line about tests is no branch prefix
    expect(branchPrefixes({ 'CLAUDE.md': 'Tests live in `test/<module>.test.js` and docs in `docs/<x>.md`.' })).toEqual([])
    expect(branchFor(['fix/', 'feat/'], 'Fix median for even-length lists', 'median')).toBe('fix/median')
    expect(branchFor(['fix/', 'feat/'], 'Add range', 'range')).toBe('feat/range')
    expect(branchFor(['fix/', 'feat/'], 'Phase 3 acceptance', 'v02-fase3')).toBe('fix/v02-fase3')
    expect(branchFor([], 'Anything', 'plan')).toBe(`${DEFAULT_PREFIX}plan`)
    // whole words (O-3 of the Phase 4 review): "fixture", "address" and "news" pick nothing
    expect(branchFor(['feat/', 'fix/'], 'Fixture cleanup', 'x')).toBe('feat/x')
    expect(branchFor(['fix/', 'feat/'], 'Address the reviewers', 'x')).toBe('fix/x')
    expect(branchFor(['fix/', 'feat/'], 'News page', 'x')).toBe('fix/x')
    expect(branchFor(['feat/', 'fix/'], 'Fixes the parser', 'x')).toBe('fix/x')
    expect(freeBranch('foreman/plan', b => b === 'foreman/plan' || b === 'foreman/plan-2')).toBe('foreman/plan-3')
  })
  test('submodules or compose services: the plan runs on a branch in the checkout, and says why (Phase 4 criterion 9)', async () => {
    expect(isolationFor('worktree', { submodules: false, services: false })).toEqual({ isolation: 'worktree' })
    expect(isolationFor('worktree', { submodules: true, services: false })).toMatchObject({ isolation: 'branch', why: expect.stringContaining('submodules') })
    expect(isolationFor('worktree', { submodules: false, services: true })).toMatchObject({ isolation: 'branch' })
    expect(isolationFor('none', { submodules: true, services: true })).toEqual({ isolation: 'none' })
  })
})

describe('the delivery (D-72, Phase 4 criteria 7 and 8)', () => {
  const facts = (o: Partial<DeliveryFacts>): DeliveryFacts => ({ mode: 'pr', isolation: 'worktree', branch: 'fix/plan', base: 'main', remote: true, gh: true, ...o })
  test('the profile\'s mode, lowered when the repo, gh or the isolation cannot carry it', async () => {
    expect(deliveryMode(facts({}))).toEqual({ mode: 'pr' })
    expect(deliveryMode(facts({ mode: 'branch' }))).toEqual({ mode: 'branch' })
    expect(deliveryMode(facts({ mode: 'merge' }))).toEqual({ mode: 'merge' })
    expect(deliveryMode(facts({ mode: 'none' }))).toEqual({ mode: 'none' })
    expect(deliveryMode(facts({ gh: false }))).toMatchObject({ mode: 'branch', note: expect.stringContaining('`gh` is missing or not signed in') })
    expect(deliveryMode(facts({ remote: false }))).toMatchObject({ mode: 'branch', note: expect.stringContaining('origin remote') })
    expect(deliveryMode(facts({ humanGate: 'CLAUDE.md: "ask before you push"' }))).toMatchObject({ mode: 'branch', note: expect.stringContaining('ask a person before publishing') })
    expect(deliveryMode(facts({ isolation: 'none', branch: undefined }))).toMatchObject({ mode: 'none', note: expect.stringContaining('isolation "none"') })
    expect(deliveryMode(facts({ base: undefined }))).toMatchObject({ mode: 'branch', note: expect.stringContaining('detached HEAD') })
    expect(deliveryMode(facts({ mode: 'merge', base: undefined }))).toMatchObject({ mode: 'branch' })
  })
  test('the steps are exactly D-72\'s argv, and none forces, deletes or mirrors', async () => {
    const o = { branch: 'fix/plan', base: 'main', title: 'Fix median', report: 'C:\\demo\\.git\\foreman\\plan\\report.md' }
    expect(deliverySteps('pr', o).map(s => s.argv)).toEqual([
      ['git', 'push', '-u', 'origin', 'fix/plan'],
      ['gh', 'pr', 'create', '--base', 'main', '--head', 'fix/plan', '--title', 'Fix median', '--body-file', 'C:\\demo\\.git\\foreman\\plan\\report.md'],
    ])
    expect(deliverySteps('merge', o).map(s => s.argv)).toEqual([['git', 'merge', '--no-ff', 'fix/plan']])
    expect(deliverySteps('branch', o)).toEqual([])
    expect(deliverySteps('none', o)).toEqual([])
    // a title that reads as a flag is not passed as one
    expect(deliverySteps('pr', { ...o, title: '--draft' })[1]?.argv[8]).toBe('draft')
    const every = [
      ...(['pr', 'merge', 'branch', 'none'] as const).flatMap(m => deliverySteps(m, o).map(s => s.argv)),
      gitArgv.worktreeAdd('C:\\x', 'b', 'HEAD'), gitArgv.worktreeRemove('C:\\x'), gitArgv.switchCreate('b'), gitArgv.switchTo('main'),
      gitArgv.branchExists('b'), [...gitArgv.currentBranch], [...gitArgv.dirty], [...gitArgv.mergeHead], [...gitArgv.mergeAbort],
    ]
    for (const argv of every) for (const flag of NEVER_FLAGS) expect(argv.includes(flag)).toBe(false)
  })
  test('the pull request\'s URL, and the words of a delivery', async () => {
    expect(prUrl('Creating pull request for fix/plan into main in acme/demo\n\nhttps://github.com/acme/demo/pull/12\n')).toBe('https://github.com/acme/demo/pull/12')
    expect(prUrl('no url')).toBe(undefined)
    expect(existingPr('a pull request for branch "fix/plan" into branch "main" already exists:\nhttps://github.com/acme/demo/pull/5')).toBe('https://github.com/acme/demo/pull/5')
    expect(existingPr('HTTP 401: Bad credentials\nhttps://github.com/acme/demo/pull/5')).toBe(undefined)
    expect(deliveredWords({ mode: 'pr', state: 'delivered', url: 'https://github.com/acme/demo/pull/12' })).toBe('pull request https://github.com/acme/demo/pull/12')
    expect(deliveredWords({ mode: 'branch', state: 'delivered' }, 'fix/plan')).toBe('on branch `fix/plan`')
    expect(deliveredWords({ mode: 'merge', state: 'failed', reason: 'your checkout has changes not committed' })).toBe('not delivered: your checkout has changes not committed')
  })
})

describe('report.md (M4)', () => {
  const T = '2026-10-17T10:00:00.000Z'
  const run: ForemanPlanRun = {
    id: 'plan', plan: 'docs/plan.md', title: 'Fix median', dir: 'C:\\demo\\.git\\foreman\\plan', current: 1, status: 'done', startedAt: T, updatedAt: T,
    parts: [{ id: 'A', title: 'Fix median' }, { id: 'B', title: 'Add range' }],
    isolation: 'worktree', tree: 'C:\\demo\\.claude\\worktrees\\foreman-plan', branch: 'fix/plan', base: 'main',
    prepare: { cmd: 'npm ci', state: 'done', at: T, exit: 0 },
    delivery: { mode: 'pr', state: 'delivered', url: 'https://github.com/acme/demo/pull/12', worktree: 'removed; the branch stays' },
  }
  const cycle = (part: string, thread: string): ForemanCycle => ({ id: `plan:${part}`, runId: 'plan', part, plan: 'docs/plan.md', base: 'abc', implThread: thread, maxCycles: 3, rounds: [], phase: 'ready', phaseAt: T, startedAt: T, updatedAt: T })
  const thread = (id: string, summary: string, commits: string[]): ForemanThread => ({ id, sessionId: `${id}-s`, name: `foreman:plan:implementer-${id}`, role: 'implementer', cwd: run.tree as string, model: 'opus', effort: 'high', startedAt: T, updatedAt: T, state: 'done', lastResult: { status: 'done', summary, commits, gates: [{ cmd: 'npm test', exit: 0 }] } })
  const review = (part: string, n: number, verdict: ForemanReview['verdict'], findings: number, costUsd: number): ForemanReview => ({ kind: 'review', runId: 'plan', part, n, file: `r-${part}${n}`, agentId: `process:${part}${n}`, startedAt: T, finishedAt: T, verdict, findings, run: { costUsd } })
  test('the parts, their commits, gates, reviews and decisions; the worktree; the delivery; the cost of the processes', async () => {
    const md = reportMarkdown({
      run,
      cycles: [cycle('A', 'a1'), cycle('B', 'b1')],
      threads: [thread('a1', 'median returns the mean of the two middle values', ['1111111111111']), thread('b1', 'range added, documented', ['2222222222222'])],
      reviews: [review('A', 1, 'OK', 0, 0.05), review('B', 2, 'NO', 2, 0.06), review('B', 3, 'OK', 0, 0.04)],
      decisions: [{ at: '2026-10-17T10:05:00.000Z', part: 'A', stop: 'question', decision: 'answer', by: 'supervisor', text: 'Use the mean of the two middle values.', reason: 'the plan decides it', costUsd: 0.15 }],
    })
    expect(md.startsWith('# Fix median\n\nPlan `docs/plan.md` · 2 part(s) · branch `fix/plan` from `main`.\n')).toBe(true)
    expect(md).toContain('### A · Fix median — done\n\nmedian returns the mean of the two middle values\n\n- Commits: `111111111111`\n- Gates the implementer ran: `npm test` → 0\n- Reviews: r1 OK\n- 10:05 the supervisor: answer — Use the mean of the two middle values.')
    expect(md).toContain('- Reviews: r2 NO (2 findings), r3 OK')
    expect(md).toContain('`npm ci` ran (exit 0) before the first part.')
    expect(md).toContain('- Mode: pr\n- Pull request: https://github.com/acme/demo/pull/12\n- Worktree: removed; the branch stays')
    expect(md).toContain('- Reviews: 0.15 USD\n- Supervisor: 0.15 USD')
  })
})
