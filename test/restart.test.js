import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUpdaterController } from '../lib/index.js'
import { isDshEntry, readRestartReport, runRestartJob, scheduleRestart, splitLauncherArgs } from '../lib/restart.js'

test('launcher arguments split into profile, launcher flags, and app arguments', () => {
  assert.deepEqual(splitLauncherArgs(['web']), { profile: 'web', launcherArgs: [], appArgs: [] })
  assert.deepEqual(splitLauncherArgs(['web', '--port', '3080', '--no-open']), { profile: 'web', launcherArgs: [], appArgs: ['--port', '3080', '--no-open'] })
  assert.deepEqual(splitLauncherArgs(['--profile', 'work', '--patch', 'x.yml', '--host', '127.0.0.1']), { profile: 'work', launcherArgs: ['--patch', 'x.yml'], appArgs: ['--host', '127.0.0.1'] })
  assert.deepEqual(splitLauncherArgs(['--profile=web', '--port=1']), { profile: 'web', launcherArgs: [], appArgs: ['--port=1'] })
})

test('restart refuses to relaunch anything that is not the dsh CLI', () => {
  assert.equal(isDshEntry(new URL(import.meta.url).pathname), false)
  assert.equal(isDshEntry('/nonexistent/dsh'), false)
  let spawned = false
  assert.throws(() => scheduleRestart({
    home: mkdtempSync(join(tmpdir(), 'dshu-restart-')),
    entry: new URL(import.meta.url).pathname,
    spawn() { spawned = true },
    exitProcess() { throw new Error('must not exit') },
  }), /not the @deepseek-ai\/dsh CLI/)
  assert.equal(spawned, false)
})

function fakeServerSpawn(calls, logFile) {
  return (program, args, options) => {
    calls.push({ program, args, options })
    const child = new EventEmitter()
    child.pid = undefined
    child.unref = () => {}
    appendFileSync(logFile, `dsh web: http://127.0.0.1:4${calls.length}00/?token=secret${calls.length}\n`)
    return child
  }
}

function restartJob(home, overrides = {}) {
  return {
    id: 'job-1',
    reason: 'update',
    parentPid: 424242,
    execPath: process.execPath,
    entry: '/opt/dsh/lib/bin.js',
    args: ['web', '--port', '3080'],
    cwd: home,
    profileDir: join(home, 'profiles', 'web'),
    fromVersion: '1.0.0',
    expectedVersion: '2.0.0',
    updaterRoot: '/opt/dsh-updater',
    reportPath: join(home, 'dsh-updater-restart.json'),
    logFile: join(home, 'logs', 'restart.log'),
    startupTimeoutMs: 5000,
    browserExecutable: '/usr/bin/chromium',
    browserTimeoutMs: 1000,
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('restart relaunches the original profile and records a verified boot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dshu-restart-'))
  try {
    const job = restartJob(home)
    const calls = []
    const opened = []
    const report = await runRestartJob(job, {
      isDshEntry: () => true,
      processAlive: () => false,
      spawn: fakeServerSpawn(calls, job.logFile),
      spawnSync: () => ({ status: 0, stdout: '2.0.0\n' }),
      requestOk: async () => {},
      probeWebBoot: async () => ({ status: 'passed', diagnostics: [] }),
      openBrowser: url => opened.push(url),
    })
    assert.equal(report.status, 'succeeded')
    assert.equal(report.runningVersion, '2.0.0')
    assert.deepEqual(calls[0].args, ['/opt/dsh/lib/bin.js', '--profile', 'web', '--port', '3080', '--no-open'])
    assert.equal(calls[0].options.detached, true)
    assert.deepEqual(opened, ['http://127.0.0.1:4100/?token=secret1'])
    const stored = readRestartReport(job.reportPath)
    assert.equal(stored.status, 'succeeded')
    assert.doesNotMatch(JSON.stringify(stored), /secret1/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('restart falls back to the rescue profile with a recovery prompt when the profile UI fails', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dshu-restart-'))
  try {
    const job = restartJob(home)
    const calls = []
    const syncCalls = []
    const opened = []
    let probes = 0
    const report = await runRestartJob(job, {
      isDshEntry: () => true,
      processAlive: () => false,
      spawn: fakeServerSpawn(calls, job.logFile),
      spawnSync: (program, args) => {
        syncCalls.push(args)
        return { status: 0, stdout: '2.0.0\n' }
      },
      requestOk: async () => {},
      probeWebBoot: async () => {
        probes += 1
        return probes === 1
          ? { status: 'failed', message: 'Failed to load plugins\nweb boot: 23 entries did not activate', diagnostics: [] }
          : { status: 'passed', diagnostics: [] }
      },
      openBrowser: url => opened.push(url),
    })
    assert.equal(report.status, 'rescue')
    assert.equal(report.rescueProfile, 'rescue')
    assert.match(report.error, /23 entries did not activate/)
    assert.match(report.recoveryPrompt, /Restart into web/)
    assert.deepEqual(calls[1].args, ['/opt/dsh/lib/bin.js', '--profile', 'rescue', '--port', '3080', '--no-open'])
    assert.ok(syncCalls.some(args => args.join(' ') === '/opt/dsh/lib/bin.js --profile rescue --from-default-profile web --dump-config'))
    assert.deepEqual(opened, ['http://127.0.0.1:4200/?token=secret2'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('restart respects --no-open and reports failure when the rescue profile also fails', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dshu-restart-'))
  try {
    const job = restartJob(home, { args: ['web', '--no-open'] })
    const opened = []
    const report = await runRestartJob(job, {
      isDshEntry: () => true,
      processAlive: () => false,
      spawn: fakeServerSpawn([], job.logFile),
      spawnSync: () => ({ status: 0, stdout: '2.0.0\n' }),
      requestOk: async () => {},
      probeWebBoot: async () => ({ status: 'failed', message: 'Failed to load plugins', diagnostics: [] }),
      openBrowser: url => opened.push(url),
    })
    assert.equal(report.status, 'failed')
    assert.match(report.rescueError, /Failed to load plugins/)
    assert.deepEqual(opened, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

function packageInstall() {
  return {
    kind: 'npm-global',
    label: 'npm global installation',
    manager: 'npm',
    packageRoot: '/opt/dsh',
    version: '1.0.0',
    canAutoUpdate: true,
    actionLabel: 'Update DSH',
    template: { program: 'npm', args: ['install', '--global', '{target}'] },
  }
}

function controllerOptions(overrides = {}) {
  return {
    releaseEligibilityStore: { read: () => 'stable', write: value => value },
    restartReports: { read: () => null, clear() {} },
    locate: packageInstall,
    fetchLatest: async () => ({ version: '2.0.0', tag: 'stable', integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAA==', tarball: 'https://registry.example.test/2.0.0.tgz', changelog: null }),
    runCommand: async () => ({ code: 0, signal: null, output: 'updated' }),
    resolveInstalledVersion: () => '2.0.0',
    validateCandidate: async ({ target }) => ({
      result: { status: 'passed', target, candidatePath: '/tmp/c', checkedAt: 'now', checks: [], blockingIssues: [], warnings: [] },
      artifactPath: '/tmp/c/dsh-2.0.0.tgz',
      dispose() {},
    }),
    verifyCandidateArtifact() {},
    now: () => '2026-01-01T00:00:00.000Z',
    logger: { warn() {} },
    ...overrides,
  }
}

test('a verified update restarts DSH through the injected scheduler', async () => {
  const scheduled = []
  const controller = createUpdaterController(controllerOptions({
    profile: { name: 'web', dir: '/home/u/.dsh/profiles/web' },
    scheduleRestart: job => scheduled.push(job),
  }))
  await controller.check()
  await controller.validate()
  const result = await controller.update()
  assert.equal(result.update.status, 'succeeded')
  assert.match(result.update.message, /Restarting now/)
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].reason, 'update')
  assert.equal(scheduled[0].expectedVersion, '2.0.0')
  assert.equal(scheduled[0].profileDir, '/home/u/.dsh/profiles/web')
})

test('without a scheduler the controller never restarts and says so', async () => {
  const controller = createUpdaterController(controllerOptions())
  await controller.check()
  await controller.validate()
  const result = await controller.update()
  assert.match(result.update.message, /Restart the running process/)
  await assert.rejects(controller.restart(), /only inside a running DSH process/)
})

test('restart from the rescue profile returns to the original command', async () => {
  const scheduled = []
  const controller = createUpdaterController(controllerOptions({
    profile: { name: 'rescue', dir: '/home/u/.dsh/profiles/rescue' },
    restartReports: {
      read: () => ({ id: 'r1', status: 'rescue', rescueProfile: 'rescue', profile: 'web', profileDir: '/home/u/.dsh/profiles/web', originalArgs: ['web', '--port', '3080'], updatedAt: new Date().toISOString() }),
      clear() {},
    },
    scheduleRestart: job => scheduled.push(job),
  }))
  const snapshot = await controller.restart()
  assert.equal(snapshot.restart.status, 'rescue')
  assert.equal(snapshot.profileName, 'rescue')
  assert.deepEqual(scheduled[0].args, ['web', '--port', '3080'])
  assert.equal(scheduled[0].profileDir, '/home/u/.dsh/profiles/web')
})

test('a restart report that stopped updating is surfaced as failed', () => {
  const controller = createUpdaterController(controllerOptions({
    restartReports: { read: () => ({ id: 'old', status: 'restarting', logPath: '/tmp/x.log', updatedAt: '2020-01-01T00:00:00.000Z' }), clear() {} },
  }))
  const snapshot = controller.snapshot()
  assert.equal(snapshot.restart.status, 'failed')
  assert.match(snapshot.restart.message, /\/tmp\/x\.log/)
})

test('restart report file never contains the job environment', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dshu-restart-'))
  try {
    const job = restartJob(home)
    await runRestartJob(job, {
      isDshEntry: () => true,
      processAlive: () => false,
      spawn: fakeServerSpawn([], job.logFile),
      spawnSync: () => ({ status: 0, stdout: '2.0.0\n' }),
      requestOk: async () => {},
      probeWebBoot: async () => ({ status: 'passed', diagnostics: [] }),
      openBrowser() {},
    })
    assert.doesNotMatch(readFileSync(job.reportPath, 'utf8'), /"env"/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
