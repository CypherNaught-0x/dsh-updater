import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolatedEnvironment, runStartupSmoke, targetFingerprint, validateCandidate, verifyFileIntegrity } from '../lib/candidate.js'

test('candidate startup smoke waits for readiness and terminates the isolated process', async () => {
  const script = [
    "console.log('candidate-ready')",
    'setInterval(() => {}, 1000)',
    "process.on('SIGTERM', () => process.exit(0))",
  ].join(';')
  const result = await runStartupSmoke(process.execPath, ['-e', script], {
    readyPattern: /(candidate-ready)/u,
    timeoutMs: 5000,
  })
  assert.equal(result.readyValue, 'candidate-ready')
  assert.match(result.output, /candidate-ready/)
  assert.equal(result.code, 0)
})

test('candidate startup smoke treats an early process exit as blocking', async () => {
  await assert.rejects(runStartupSmoke(process.execPath, ['-e', "console.error('fatal candidate'); process.exit(2)"], {
    readyAfterMs: 1000,
    timeoutMs: 5000,
  }), /exited before startup readiness with code 2[\s\S]*fatal candidate/)
})

test('startup verification failure waits for forced process-tree cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-updater-smoke-test-'))
  const pidFile = join(root, 'pid')
  const script = [
    "const { writeFileSync } = require('node:fs')",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    "console.log('candidate-ready')",
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
  ].join(';')
  try {
    await assert.rejects(runStartupSmoke(process.execPath, ['-e', script], {
      readyPattern: /(candidate-ready)/u,
      shutdownTimeoutMs: 50,
      timeoutMs: 2000,
      async verify() { throw new Error('health verification failed') },
    }), /health verification failed/)
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    assert.throws(() => process.kill(pid, 0), error => error?.code === 'ESRCH')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('candidate environment isolates DSH state and does not inherit credentials', () => {
  const env = isolatedEnvironment('/tmp/candidate-root', {
    PATH: '/bin',
    LANG: 'C',
    DEEPSEEK_API_KEY: 'secret',
    DSH_HOME: '/active/home',
    HOME: '/active/user',
  })
  assert.equal(env.PATH, '/bin')
  assert.equal(env.LANG, 'C')
  assert.equal(env.DSH_HOME, '/tmp/candidate-root/dsh-home')
  assert.equal(env.DSH_AGENTS_HOME, '/tmp/candidate-root/agents-home')
  assert.equal(env.HOME, '/tmp/candidate-root/home')
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
})

test('package validation stages the exact target and runs both candidate modes', async () => {
  const startups = []
  const progress = []
  let stagedRoot
  const outcome = await validateCandidate({
    config: {
      candidateTimeoutMinutes: 1,
      candidateInstaller: 'pnpm',
      registryUrl: 'https://registry.example.test/',
      startupTimeoutSeconds: 5,
    },
    install: {
      kind: 'npm-global',
      candidateIntegrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAA==',
      candidateTarball: 'https://registry.example.test/dsh-2.0.0.tgz',
    },
    target: '2.0.0',
    now: () => '2026-01-01T00:00:00.000Z',
    onProgress(value) { progress.push(value) },
    async downloadTarball(url, integrity, file) {
      assert.equal(url, 'https://registry.example.test/dsh-2.0.0.tgz')
      assert.equal(integrity, 'sha512-AAAAAAAAAAAAAAAAAAAAAA==')
      writeFileSync(file, 'verified archive')
    },
    async execute(program, args, options) {
      assert.equal(program, 'pnpm')
      stagedRoot = args[args.indexOf('--dir') + 1]
      assert.equal(args.includes('--config.dangerously-allow-all-builds=true'), true)
      assert.equal(args[args.indexOf('--registry') + 1], 'https://registry.example.test/')
      assert.equal(args.at(-1), join(stagedRoot, 'dsh-2.0.0.tgz'))
      assert.equal(options.env.DSH_HOME.startsWith(stagedRoot), true)
      const packageRoot = join(stagedRoot, 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(join(packageRoot, 'lib'), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        version: '2.0.0',
        bin: { dsh: 'lib/bin.js' },
      }))
      writeFileSync(join(packageRoot, 'lib', 'bin.js'), '')
      return { code: 0, signal: null, output: 'staged exact package' }
    },
    async runStartup(_program, args, options) {
      startups.push({ args, options })
      return { code: 0, signal: null, output: args.includes('web') ? 'web ready' : 'tui ready' }
    },
  })

  assert.equal(outcome.result.status, 'passed')
  assert.deepEqual(progress.map(value => value.phase), ['download', 'install', 'tui', 'web'])
  assert.equal(progress.every(value => value.candidatePath === stagedRoot), true)
  assert.deepEqual(outcome.result.checks.map(check => check.id), ['stage', 'tui', 'web'])
  assert.equal(startups.length, 2)
  assert.deepEqual(startups[0].args.slice(-2), ['--profile', 'tui'])
  assert.ok(startups[0].options.readyAfterMs >= 1000)
  assert.equal(startups[0].options.readyPattern.test('rendered tui frame'), true)
  assert.equal(startups[0].options.readyPattern.test('   '), false)
  assert.deepEqual(startups[1].args.slice(-6), ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'])
  assert.equal(startups.every(entry => entry.options.env.DSH_HOME.startsWith(stagedRoot)), true)
  assert.equal(existsSync(stagedRoot), true)
  outcome.dispose()
  assert.equal(existsSync(stagedRoot), false)
})

test('a release without a shipped TUI profile reports the check as skipped', async () => {
  const outcome = await validateCandidate({
    config: { candidateTimeoutMinutes: 1, candidateInstaller: 'auto', registryUrl: 'https://registry.example.test/', startupTimeoutSeconds: 5 },
    install: {
      kind: 'npm-global',
      candidateIntegrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAA==',
      candidateTarball: 'https://registry.example.test/dsh-2.0.0.tgz',
    },
    target: '2.0.0',
    now: () => '2026-01-01T00:00:00.000Z',
    async downloadTarball(_url, _integrity, file) { writeFileSync(file, 'verified archive') },
    async execute(program, args) {
      if (program === 'pnpm') {
        const error = new Error('spawn pnpm ENOENT')
        error.code = 'ENOENT'
        throw error
      }
      const root = args[args.indexOf('--prefix') + 1]
      const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(join(packageRoot, 'lib'), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0', bin: { dsh: 'lib/bin.js' } }))
      writeFileSync(join(packageRoot, 'lib', 'bin.js'), '')
      return { code: 0, signal: null, output: '' }
    },
    async runStartup(_program, args) {
      if (args.includes('tui')) throw new Error('dsh: profile "tui" does not exist; create it first')
      return { code: 0, signal: null, output: 'web ready' }
    },
  })
  try {
    assert.equal(outcome.result.status, 'passed')
    assert.equal(outcome.result.checks.find(check => check.id === 'tui').status, 'skipped')
    assert.deepEqual(outcome.result.blockingIssues, [])
  } finally {
    outcome.dispose()
  }
})

test('promotion integrity check rejects a candidate archive changed after validation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-updater-integrity-test-'))
  const archive = join(root, 'candidate.tgz')
  try {
    writeFileSync(archive, 'validated bytes')
    const integrity = `sha512-${createHash('sha512').update('validated bytes').digest('base64')}`
    assert.doesNotThrow(() => verifyFileIntegrity(archive, integrity))
    writeFileSync(archive, 'mutated bytes')
    assert.throws(() => verifyFileIntegrity(archive, integrity), /no longer matches/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validation fingerprint binds a pass to installation kind and exact target', () => {
  const npm = targetFingerprint({ kind: 'npm-global', candidateIntegrity: 'sha512-first' }, '2.0.0')
  assert.equal(npm, targetFingerprint({ kind: 'npm-global', candidateIntegrity: 'sha512-first' }, '2.0.0'))
  assert.notEqual(npm, targetFingerprint({ kind: 'pnpm-global', candidateIntegrity: 'sha512-first' }, '2.0.0'))
  assert.notEqual(npm, targetFingerprint({ kind: 'npm-global', candidateIntegrity: 'sha512-first' }, '2.0.1'))
  assert.notEqual(npm, targetFingerprint({ kind: 'npm-global', candidateIntegrity: 'sha512-second' }, '2.0.0'))
})
