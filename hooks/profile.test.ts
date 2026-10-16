import { describe, expect, test } from 'claude-code/testing'
import { defaultProfile, initialProfile, parseProfile, roleAt, stripJsonComments } from './lib/profile'

describe('profile (version 2)', () => {
  test('no file: the defaults, no warnings', async () => {
    const p = parseProfile(undefined)
    expect(p.source).toBe('default')
    expect(p.warnings).toEqual([])
    expect(p.profile).toEqual(defaultProfile())
    expect(p.profile).toMatchObject({ version: 2, isolation: 'none', delivery: { mode: 'branch', handoffToApp: false }, guards: { scope: 'threads', rules: [] } })
    // foreman's files live under .git/foreman unless a repo names its own folder (D-70)
    expect(p.profile.runsDir).toBe(undefined)
    expect('claudeExe' in p.profile).toBe(false)
    expect(Object.keys(p.profile.roles)).toEqual(['implementer', 'reviewer', 'supervisor'])
    expect(p.profile.roles.reviewer.model).toBe('fable')
    expect(p.profile.limits).toEqual({ maxParallelThreads: 1, reviewRounds: 3 })
  })

  test('empty file and {}: the defaults, no warnings', async () => {
    for (const text of ['', '   \n', '{}']) {
      const p = parseProfile(text)
      expect(p.warnings).toEqual([])
      expect(p.profile).toEqual(defaultProfile())
    }
  })

  test('broken JSON: one warning, the defaults', async () => {
    const p = parseProfile('{ "runsDir": ')
    expect(p.warnings.length).toBe(1)
    expect(p.warnings[0]).toContain('not valid JSON')
    expect(p.profile).toEqual(defaultProfile())
  })

  test('not an object: one warning, the defaults', async () => {
    const p = parseProfile('[1, 2]')
    expect(p.warnings.length).toBe(1)
    expect(p.profile).toEqual(defaultProfile())
  })

  test('unknown keys warn and are ignored; known keys still apply', async () => {
    const p = parseProfile(JSON.stringify({ runsDir: '.agents/runs', colour: 'red', roles: { wizard: {}, reviewer: { model: 'haiku', vibe: 1 } } }))
    expect(p.profile.runsDir).toBe('.agents/runs')
    expect(p.profile.roles.reviewer.model).toBe('haiku')
    expect(p.warnings.some(w => w.includes('colour') && w.includes('unknown key'))).toBe(true)
    expect(p.warnings.some(w => w.includes('roles.wizard') && w.includes('unknown role'))).toBe(true)
    expect(p.warnings.some(w => w.includes('roles.reviewer.vibe'))).toBe(true)
    expect(p.warnings.length).toBe(3)
  })

  test('a bad value warns with its key and falls back to that key alone', async () => {
    const p = parseProfile(JSON.stringify({
      runsDir: '../outside',
      mode: 'night',
      isolation: 'cloud',
      limits: { maxParallelThreads: 0, reviewRounds: 4 },
      delivery: { mode: 'force-push' },
      roles: { implementer: { model: 'gpt-5', effort: 'extreme', extra: 'hi' } },
    }))
    const d = defaultProfile()
    expect(p.profile.runsDir).toBe(d.runsDir)
    expect(p.profile.isolation).toBe('none')
    expect(p.profile.limits).toEqual({ maxParallelThreads: 1, reviewRounds: 4 })
    expect(p.profile.delivery.mode).toBe('branch')
    expect(p.profile.roles.implementer).toMatchObject({ model: 'opus', effort: 'high', extra: 'hi' })
    for (const key of ['runsDir', 'mode', 'isolation', 'limits.maxParallelThreads', 'delivery.mode', 'roles.implementer.model', 'roles.implementer.effort']) {
      expect(p.warnings.some(w => w.includes(`: ${key}: `))).toBe(true)
    }
    expect(p.warnings.length).toBe(7)
  })

  test('jsonc comments are accepted', async () => {
    const p = parseProfile('{\n  // a repo\n  "runsDir": ".agents/runs", /* runs */ "notify": { "toast": false, "quiet": true }\n}')
    expect(p.warnings).toEqual([])
    expect(p.profile.runsDir).toBe('.agents/runs')
    expect(p.profile.notify).toEqual({ toast: false, quiet: true })
    expect(stripJsonComments('{"a":"http://x//y"}')).toBe('{"a":"http://x//y"}')
  })

  test('the new keys: isolation branch, delivery, guards.scope, notify.quiet', async () => {
    const p = parseProfile(JSON.stringify({ version: 2, isolation: 'branch', delivery: { mode: 'pr', handoffToApp: true }, guards: { scope: 'everywhere', rules: [] }, notify: { quiet: true } }))
    expect(p.warnings).toEqual([])
    expect(p.profile).toMatchObject({ isolation: 'branch', delivery: { mode: 'pr', handoffToApp: true }, guards: { scope: 'everywhere' }, notify: { toast: true, quiet: true } })
    expect(roleAt(p.profile, 'implementer')).toMatchObject({ model: 'opus', effort: 'high' })
  })

  test('guards: invalid rules are dropped with a warning', async () => {
    const p = parseProfile(JSON.stringify({ guards: { rules: [
      { when: { tool: 'Bash', commandRegex: 'rm\\s+-rf' }, mode: 'deny', reason: 'no mass deletes' },
      { when: { tool: 'Bash', commandRegex: '(' }, mode: 'deny' },
      { mode: 'deny' },
    ] } }))
    expect(p.profile.guards.rules.length).toBe(1)
    expect(p.profile.guards.scope).toBe('threads')
    expect(p.warnings.length).toBe(2)
  })

  test('init profile: version 2 and the gates found, parses back without warnings', async () => {
    const p = parseProfile(JSON.stringify(initialProfile(['npm test', 'dotnet test App.sln'])))
    expect(p.warnings).toEqual([])
    expect(p.profile.gates).toEqual({ checks: ['npm test', 'dotnet test App.sln'] })
    expect(parseProfile(JSON.stringify(initialProfile([]))).profile.gates).toEqual({})
  })
})

describe('the 0.1 profile, read through the aliases (D-80, Phase 1 criterion 3)', () => {
  /** An anonymised 0.1 profile with every key 0.2 retired or renamed. */
  const V1 = {
    version: 1,
    runsDir: '.agents/runs',
    repos: [{ name: 'root', path: '.' }, { name: 'api', path: 'Services/Api' }],
    roles: {
      implementer: { model: 'opus', effort: 'high', kind: 'thread', contract: 'docs/contract.md', byLevel: { N1: { model: 'sonnet' } } },
      reviewer: { model: 'fable', effort: 'high', tools: ['Read', 'Bash', 'Write'] },
      critic: { model: 'fable' },
    },
    gates: { node: ['npm test'] },
    limits: { maxParallelThreads: 1, maxReviewCycles: 2, serialBuilds: true },
    hooks: { onRunCreate: 'powershell -File scripts/new-run.ps1 {{runId}}' },
    injectHandoff: true,
    notify: { toast: true },
  }

  test('one warning per retired key, and a valid version 2 profile', async () => {
    const p = parseProfile(JSON.stringify(V1))
    const keys = p.warnings.map(w => w.split(': ')[1])
    expect(keys).toEqual([
      'repos', 'hooks', 'injectHandoff',
      'roles.implementer.kind', 'roles.implementer.contract', 'roles.implementer.byLevel',
      'roles.reviewer.tools', 'roles.critic',
      'limits.serialBuilds', 'limits.maxReviewCycles',
    ])
    expect(p.warnings.every(w => /retired in 0\.2|the 0\.1 name of/.test(w))).toBe(true)
    expect(p.unusable).toBe(undefined)
    expect(p.profile).toMatchObject({ version: 2, runsDir: '.agents/runs', gates: { node: ['npm test'] }, limits: { maxParallelThreads: 1, reviewRounds: 2 } })
    expect(roleAt(p.profile, 'implementer')).toMatchObject({ model: 'opus', effort: 'high' })
    expect(Object.keys(p.profile.roles)).toEqual(['implementer', 'reviewer', 'supervisor'])
    // the result parses again as version 2 with no warning at all
    expect(parseProfile(JSON.stringify(p.profile)).warnings).toEqual([])
  })

  test('maxReviewCycles gives way to reviewRounds when both are set', async () => {
    const p = parseProfile(JSON.stringify({ limits: { maxReviewCycles: 2, reviewRounds: 3 } }))
    expect(p.profile.limits.reviewRounds).toBe(3)
    expect(p.warnings).toEqual(['.claude/foreman.json: limits.maxReviewCycles: the 0.1 name of limits.reviewRounds, which is also set: ignored'])
  })

  test('a 0.1 list of guards: read as rules for the threads, said once', async () => {
    const p = parseProfile(JSON.stringify({ guards: [{ when: { tool: 'Edit', pathGlob: 'migrations/**' }, mode: 'deny' }] }))
    expect(p.profile.guards).toEqual({ scope: 'threads', rules: [{ when: { tool: 'Edit', pathGlob: 'migrations/**' }, mode: 'deny' }] })
    expect(p.warnings.length).toBe(1)
    expect(p.warnings[0]).toContain('a list is the 0.1 form')
  })

  test('claudeExe and notify.command stay in the plugin settings (C-13)', async () => {
    const p = parseProfile(JSON.stringify({ claudeExe: 'tools/evil.cmd', notify: { command: 'evil.cmd' } }))
    expect(p.warnings.map(w => w.split(': ')[1])).toEqual(['claudeExe', 'notify.command'])
  })
})

describe('one mode, read-only processes (D-111, D-112)', () => {
  test('mode "review" is said and ignored, "auto" says nothing; the reviewer\'s and the supervisor\'s permission mode is ignored', async () => {
    const p = parseProfile(JSON.stringify({ mode: 'review', roles: { implementer: { permissionMode: 'acceptEdits' }, reviewer: { permissionMode: 'auto' }, supervisor: { permissionMode: 'bypassPermissions' } } }))
    expect(p.warnings.find(w => w.includes(': mode: '))).toContain('one mode in 0.2')
    expect(p.profile.roles.implementer.permissionMode).toBe('acceptEdits')
    for (const role of ['reviewer', 'supervisor']) {
      expect(p.warnings.find(w => w.includes(`: roles.${role}.permissionMode: `))).toContain('always run in dontAsk; ignored')
      expect(p.profile.roles[role as 'reviewer'].permissionMode).toBe('dontAsk')
    }
    expect(p.warnings.length).toBe(3)
    expect(parseProfile(JSON.stringify({ mode: 'auto' })).warnings).toEqual([])
  })
})
