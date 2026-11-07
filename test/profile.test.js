import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cloneProfile, parseSkippedBundles, validateCandidate } from '../lib/candidate.js'

const SKIP_OUTPUT = [
  'dsh: skipping profile bundle "dsh-codex-connect": Error: Plugin dsh-codex-connect@0.2.0 is incompatible with dsh 0.2.2-rc.1: requirements {"@deepseek-ai/dsh-agent":"0.2.1"}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime.',
  'dsh: skipping profile bundle "@local/runtime": Error: Plugin @local/runtime@1.1.0 is incompatible with dsh 0.2.2-rc.1: requirements {"engines.dsh":"0.2.1"}. Running it may cause crashes or data loss.',
  'dsh web: http://127.0.0.1:4000/?token=abc',
].join('\n')

test('skipped bundles are parsed from the launcher compatibility gate output', () => {
  assert.deepEqual(parseSkippedBundles(SKIP_OUTPUT), [
    { name: 'dsh-codex-connect', reason: 'Plugin dsh-codex-connect@0.2.0 is incompatible with dsh 0.2.2-rc.1: requirements {"@deepseek-ai/dsh-agent":"0.2.1"}' },
    { name: '@local/runtime', reason: 'Plugin @local/runtime@1.1.0 is incompatible with dsh 0.2.2-rc.1: requirements {"engines.dsh":"0.2.1"}' },
  ])
  assert.deepEqual(parseSkippedBundles('dsh web: http://127.0.0.1:1/'), [])
})

test('profile clone keeps boot inputs, skips backups, and re-points escaping relative links', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshu-profile-'))
  try {
    const external = join(root, 'projects', 'my-plugin')
    mkdirSync(external, { recursive: true })
    writeFileSync(join(external, 'package.json'), '{"name":"my-plugin"}')
    const home = join(root, 'home')
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(join(profileDir, 'node_modules', 'inner'), { recursive: true })
    mkdirSync(join(profileDir, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(profileDir, 'backups', 'old'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"dsh":{"profile":{"bundles":["my-plugin"]}}}')
    writeFileSync(join(profileDir, 'compatibility.json'), '{}')
    writeFileSync(join(profileDir, 'node_modules', 'inner', 'cli.js'), '')
    symlinkSync('../../../../projects/my-plugin', join(profileDir, 'node_modules', 'my-plugin'))
    symlinkSync('../inner/cli.js', join(profileDir, 'node_modules', '.bin', 'inner'))
    writeFileSync(join(home, 'cordis.patch.yml'), '[]\n')

    const candidateHome = join(root, 'candidate')
    const clone = cloneProfile({ name: 'web', dir: profileDir, home }, candidateHome)

    assert.equal(clone, join(candidateHome, 'profiles', 'web'))
    assert.equal(existsSync(join(clone, 'compatibility.json')), true)
    assert.equal(existsSync(join(clone, 'backups')), false)
    assert.equal(readlinkSync(join(clone, 'node_modules', 'my-plugin')), external)
    assert.equal(readFileSync(join(clone, 'node_modules', 'my-plugin', 'package.json'), 'utf8'), '{"name":"my-plugin"}')
    assert.equal(readlinkSync(join(clone, 'node_modules', '.bin', 'inner')), '../inner/cli.js')
    assert.equal(lstatSync(join(clone, 'node_modules', 'inner')).isDirectory(), true)
    assert.equal(readFileSync(join(candidateHome, 'cordis.patch.yml'), 'utf8'), '[]\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

async function validateWithProfile(t, { runStartup, probeBrowser }) {
  const root = mkdtempSync(join(tmpdir(), 'dshu-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profileDir = join(root, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{}')
  const outcome = await validateCandidate({
    config: { candidateTimeoutMinutes: 1, candidateInstaller: 'pnpm', registryUrl: 'https://registry.example.test/', startupTimeoutSeconds: 5, browserTimeoutSeconds: 5 },
    install: { kind: 'npm-global', candidateIntegrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAA==', candidateTarball: 'https://registry.example.test/dsh-2.0.0.tgz' },
    profile: { name: 'web', dir: profileDir, home: root },
    browserExecutable: '/usr/bin/chromium',
    target: '2.0.0',
    now: () => '2026-01-01T00:00:00.000Z',
    async downloadTarball(_url, _integrity, file) { writeFileSync(file, 'verified archive') },
    async execute(_program, args) {
      const stagedRoot = args[args.indexOf('--dir') + 1]
      const packageRoot = join(stagedRoot, 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(join(packageRoot, 'lib'), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0', bin: { dsh: 'lib/bin.js' } }))
      writeFileSync(join(packageRoot, 'lib', 'bin.js'), '')
      return { code: 0, signal: null, output: '' }
    },
    runStartup,
    probeBrowser,
    requestOk: async () => {},
  })
  outcome.dispose()
  return outcome.result
}

test('validation boots a copy of the active profile and reports skipped plugins as a warning', async (t) => {
  const launches = []
  const result = await validateWithProfile(t, {
    async runStartup(_program, args, options) {
      if (args.includes('tui')) throw new Error('dsh: profile "tui" does not exist')
      launches.push({ args, env: options.env })
      return { code: 0, signal: null, output: args.includes('--profile') ? SKIP_OUTPUT : 'web ready' }
    },
    probeBrowser: async () => ({ status: 'passed', diagnostics: [] }),
  })
  const profileLaunch = launches.find(launch => launch.args.includes('--profile'))
  assert.deepEqual(profileLaunch.args.slice(1), ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'])
  assert.equal(existsSync(join(profileLaunch.env.DSH_HOME)), false, 'candidate root is disposed after validation')
  assert.equal(result.status, 'passed')
  assert.deepEqual(result.checks.map(check => [check.id, check.status]), [
    ['stage', 'passed'], ['tui', 'skipped'], ['web', 'passed'], ['profile', 'passed'], ['profile-plugins', 'warning'],
  ])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0].message, /dsh-codex-connect/)
  assert.match(result.repairPrompt, /allow-version/)
})

test('a profile whose Web UI fails to boot blocks the update', async (t) => {
  const result = await validateWithProfile(t, {
    async runStartup(_program, args, options) {
      if (args.includes('tui')) throw new Error('dsh: profile "tui" does not exist')
      if (args.includes('--profile')) {
        // Simulate the real smoke: readiness is reached, then verify() runs the browser probe.
        await options.verify('http://127.0.0.1:1/').catch(error => {
          throw new Error(`${error.message}\n${SKIP_OUTPUT}`)
        })
      }
      return { code: 0, signal: null, output: 'web ready' }
    },
    probeBrowser: async () => ({ status: 'failed', message: 'Failed to load plugins\nweb boot: 23 entries did not activate', diagnostics: [] }),
  })
  assert.equal(result.status, 'blocked')
  const profileCheck = result.checks.find(check => check.id === 'profile')
  assert.equal(profileCheck.status, 'failed')
  assert.match(profileCheck.error, /23 entries did not activate/)
  assert.equal(result.checks.find(check => check.id === 'profile-plugins').skippedBundles.length, 2)
})
