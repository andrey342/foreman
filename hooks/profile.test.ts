import { describe, expect, test } from 'claude-code/testing'
import { defaultProfile, initialProfile, parseProfile, roleAt, stripJsonComments } from './lib/profile'

describe('profile', () => {
  test('no file: the defaults, no warnings', async () => {
    const p = parseProfile(undefined)
    expect(p.source).toBe('default')
    expect(p.warnings).toEqual([])
    expect(p.profile).toEqual(defaultProfile())
    expect(p.profile.runsDir).toBe('.claude/runs')
    expect(p.profile.injectHandoff).toBe(true)
    expect('claudeExe' in p.profile).toBe(false)
    expect(p.profile.repos).toEqual([{ name: 'root', path: '.' }])
    expect(p.profile.roles.reviewer.model).toBe('fable')
    expect(p.profile.limits.maxParallelThreads).toBe(1)
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
    const p = parseProfile(JSON.stringify({ runsDir: '.agents/runs', colour: 'red', roles: { wizard: {}, qa: { model: 'haiku', vibe: 1 } } }))
    expect(p.profile.runsDir).toBe('.agents/runs')
    expect(p.profile.roles.qa.model).toBe('haiku')
    expect(p.warnings.some(w => w.includes('colour') && w.includes('unknown key'))).toBe(true)
    expect(p.warnings.some(w => w.includes('roles.wizard') && w.includes('unknown role'))).toBe(true)
    expect(p.warnings.some(w => w.includes('roles.qa.vibe'))).toBe(true)
    expect(p.warnings.length).toBe(3)
  })

  test('a bad value warns with its key and falls back to that key alone', async () => {
    const p = parseProfile(JSON.stringify({
      runsDir: '../outside',
      injectHandoff: 'no',
      limits: { maxParallelThreads: 0, maxReviewCycles: 3 },
      roles: { implementer: { model: 'gpt-5', effort: 'extreme', extra: 'hi' } },
    }))
    const d = defaultProfile()
    expect(p.profile.runsDir).toBe(d.runsDir)
    expect(p.profile.injectHandoff).toBe(true)
    expect(p.profile.limits.maxParallelThreads).toBe(1)
    expect(p.profile.limits.maxReviewCycles).toBe(3)
    expect(p.profile.roles.implementer.model).toBe('opus')
    expect(p.profile.roles.implementer.effort).toBe('high')
    expect(p.profile.roles.implementer.extra).toBe('hi')
    for (const key of ['runsDir', 'injectHandoff', 'limits.maxParallelThreads', 'roles.implementer.model', 'roles.implementer.effort']) {
      expect(p.warnings.some(w => w.includes(`: ${key}: `))).toBe(true)
    }
    expect(p.warnings.length).toBe(5)
  })

  test('jsonc comments are accepted', async () => {
    const p = parseProfile('{\n  // MSG\n  "runsDir": ".agents/runs", /* runs */ "notify": { "toast": false }\n}')
    expect(p.warnings).toEqual([])
    expect(p.profile.runsDir).toBe('.agents/runs')
    expect(p.profile.notify.toast).toBe(false)
    expect(stripJsonComments('{"a":"http://x//y"}')).toBe('{"a":"http://x//y"}')
  })

  test('merge by level: byLevel over the role, the rest kept', async () => {
    const p = parseProfile(JSON.stringify({ roles: { implementer: { effort: 'xhigh', skills: ['a'], byLevel: { N1: { model: 'sonnet', effort: 'high' }, N9: {} } } } }))
    expect(roleAt(p.profile, 'implementer', 'N1')).toMatchObject({ model: 'sonnet', effort: 'high', skills: ['a'] })
    expect(roleAt(p.profile, 'implementer', 'N2')).toMatchObject({ model: 'opus', effort: 'xhigh', skills: ['a'] })
    expect(roleAt(p.profile, 'implementer')).toMatchObject({ model: 'opus', effort: 'xhigh' })
    expect(p.warnings.length).toBe(1)
    expect(p.warnings[0]).toContain('byLevel.N9')
  })

  test('default implementer at N1 is sonnet (plan D4)', async () => {
    const p = parseProfile(undefined)
    expect(roleAt(p.profile, 'implementer', 'N1').model).toBe('sonnet')
    expect(roleAt(p.profile, 'implementer', 'N2').model).toBe('opus')
  })

  test('guards: invalid ones are dropped with a warning', async () => {
    const p = parseProfile(JSON.stringify({ guards: [
      { when: { tool: 'Bash', commandRegex: 'git\\s+add\\s+-A' }, mode: 'deny', reason: 'explicit paths' },
      { when: { tool: 'Bash', commandRegex: '(' }, mode: 'deny' },
      { mode: 'deny' },
    ] }))
    expect(p.profile.guards.length).toBe(1)
    expect(p.warnings.length).toBe(2)
  })

  test('init profile guesses gates from the repo and parses back without warnings', async () => {
    const text = JSON.stringify(initialProfile({ hasPackageJson: true, slnFiles: ['App.sln'], hasPyproject: false }))
    const p = parseProfile(text)
    expect(p.warnings).toEqual([])
    expect(p.profile.gates).toEqual({ node: ['npm test'], dotnet: ['dotnet test App.sln'] })
  })
})
