import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  classifyPackageInstall,
  createUpdaterController,
  findSourceRoot,
  resolveDshPackageRoot,
  runCommand,
  scrubEnvironment,
} from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-updater-'))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value)}\n`)
}

test('resolves the DSH manifest relative to the running entry', () => {
  const root = tempDir()
  const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeJson(join(packageRoot, 'package.json'), { name: '@deepseek-ai/dsh', version: '1.2.3' })
  writeFileSync(join(packageRoot, 'lib', 'bin.js'), '')

  assert.deepEqual(resolveDshPackageRoot(join(packageRoot, 'lib', 'bin.js')), {
    packageRoot,
    version: '1.2.3',
    entryPath: join(packageRoot, 'lib', 'bin.js'),
  })
})

test('classifies npx, global, and project-owned package installations', () => {
  const npxRoot = join(tempDir(), '_npx', 'abc', 'node_modules', '@deepseek-ai', 'dsh')
  assert.equal(classifyPackageInstall({
    packageRoot: npxRoot,
    entryPath: join(npxRoot, 'lib', 'bin.js'),
    version: '1.0.0',
    globalRoots: {},
  }).kind, 'npx')

  const globalRoot = join(tempDir(), 'lib', 'node_modules')
  const packageRoot = join(globalRoot, '@deepseek-ai', 'dsh')
  const global = classifyPackageInstall({
    packageRoot,
    entryPath: join(packageRoot, 'lib', 'bin.js'),
    version: '1.0.0',
    globalRoots: { pnpm: globalRoot },
  })
  assert.equal(global.kind, 'pnpm-global')
  assert.equal(global.commandPreview, 'pnpm add --global {target}')

  const linkedGlobalRoot = join(tempDir(), 'node_modules')
  const storeRoot = join(tempDir(), 'store', '@deepseek-ai', 'dsh')
  mkdirSync(join(linkedGlobalRoot, '@deepseek-ai'), { recursive: true })
  mkdirSync(storeRoot, { recursive: true })
  symlinkSync(storeRoot, join(linkedGlobalRoot, '@deepseek-ai', 'dsh'), process.platform === 'win32' ? 'junction' : 'dir')
  const linkedGlobal = classifyPackageInstall({
    packageRoot: storeRoot,
    entryPath: join(storeRoot, 'lib', 'bin.js'),
    version: '1.0.0',
    globalRoots: { pnpm: linkedGlobalRoot },
  })
  assert.equal(linkedGlobal.kind, 'pnpm-global')

  const project = tempDir()
  writeJson(join(project, 'package.json'), { packageManager: 'bun@1.2.0' })
  const localRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh')
  const local = classifyPackageInstall({
    packageRoot: localRoot,
    entryPath: join(localRoot, 'lib', 'bin.js'),
    version: '1.0.0',
    globalRoots: {},
  })
  assert.equal(local.kind, 'bun-local')
  assert.equal(local.projectRoot, project)

  const orphanRoot = join(tempDir(), 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  const unknown = classifyPackageInstall({
    packageRoot: orphanRoot,
    entryPath: join(orphanRoot, 'lib', 'bin.js'),
    version: '1.0.0',
    globalRoots: {},
  })
  assert.equal(unknown.kind, 'unknown-package')
  assert.equal(unknown.canAutoUpdate, false)
})

test('recognizes a source checkout only from repository markers', () => {
  const root = tempDir()
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'apps', 'cli'), { recursive: true })
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@deepseek-ai/dsh' })
  assert.equal(findSourceRoot(join(root, 'apps', 'cli')), root)
  assert.equal(findSourceRoot(tempDir()), undefined)
})

test('package controller chooses the prerelease channel and exact update target', async () => {
  const commands = []
  const controller = createUpdaterController({
    locate: () => ({
      kind: 'npm-global',
      label: 'npm global installation',
      manager: 'npm',
      packageRoot: '/opt/dsh',
      version: '1.0.0-rc.1',
      canAutoUpdate: true,
      actionLabel: 'Update DSH',
      template: { program: 'npm', args: ['install', '--global', '{target}'] },
      commandPreview: 'npm install --global {target}',
      restartHint: 'Restart.',
    }),
    fetchLatest: async (current) => {
      assert.equal(current, '1.0.0-rc.1')
      return { version: '1.0.0-rc.2', tag: 'next' }
    },
    runCommand: async (program, args) => {
      commands.push({ program, args })
      return { code: 0, signal: null, output: 'updated' }
    },
    resolveInstalledVersion: () => '1.0.0-rc.2',
    now: () => '2026-01-01T00:00:00.000Z',
  })
  controller.initialize()
  const checked = await controller.check()
  assert.equal(checked.updateAvailable, true)
  assert.equal(checked.latestTag, 'next')
  assert.equal(checked.install.commandPreview, 'npm install --global @deepseek-ai/dsh@1.0.0-rc.2')
  const updated = await controller.update()
  assert.deepEqual(commands, [{
    program: 'npm',
    args: ['install', '--global', '@deepseek-ai/dsh@1.0.0-rc.2'],
  }])
  assert.equal(updated.update.status, 'succeeded')
  assert.equal(updated.updateAvailable, false)
  assert.equal(updated.currentVersion, '1.0.0-rc.1')
  assert.equal(updated.installedVersion, '1.0.0-rc.2')
})

test('package verification reports the version actually left on disk after failure', async () => {
  const controller = createUpdaterController({
    locate: () => ({
      kind: 'npm-global',
      label: 'npm global installation',
      packageRoot: '/opt/dsh',
      version: '1.0.0',
      canAutoUpdate: true,
      actionLabel: 'Update DSH',
      template: { program: 'npm', args: ['install', '--global', '{target}'] },
    }),
    fetchLatest: async () => ({ version: '2.0.0', tag: 'latest' }),
    runCommand: async () => ({ code: 0, signal: null, output: '' }),
    resolveInstalledVersion: () => '1.5.0',
  })
  controller.initialize()
  await assert.rejects(controller.update(), /1\.5\.0 is installed instead of 2\.0\.0/)
  const failed = controller.snapshot()
  assert.equal(failed.currentVersion, '1.0.0')
  assert.equal(failed.installedVersion, '1.5.0')
  assert.equal(failed.install.version, '1.5.0')
  assert.equal(failed.updateAvailable, true)
})

test('npx updates prepare an exact release without pretending the running process changed', async () => {
  let executions = 0
  const controller = createUpdaterController({
    locate: () => ({
      kind: 'npx',
      label: 'npm exec / npx cache',
      manager: 'npm',
      packageRoot: '/cache/dsh',
      version: '1.0.0-rc.1',
      canAutoUpdate: true,
      actionLabel: 'Prepare update',
      template: { program: 'npm', args: ['exec', '--yes', '--package={target}', '--', 'dsh', '--version'] },
      commandPreview: 'npm exec --yes --package={target} -- dsh --version',
      restartHint: 'Restart.',
    }),
    fetchLatest: async () => ({ version: '1.0.0-rc.2', tag: 'next' }),
    runCommand: async () => {
      executions += 1
      return { code: 0, signal: null, output: '1.0.0-rc.2' }
    },
  })
  controller.initialize()
  await controller.check()
  const updated = await controller.update()
  assert.equal(updated.currentVersion, '1.0.0-rc.1')
  assert.equal(updated.install.preparedVersion, '1.0.0-rc.2')
  assert.match(updated.install.restartHint, /@deepseek-ai\/dsh@1\.0\.0-rc\.2/)
  const rechecked = await controller.check()
  assert.equal(rechecked.updateAvailable, false)
  assert.equal(executions, 1)
})

test('source controller refuses automatic updates for dirty or ahead checkouts', async () => {
  const outputs = new Map([
    ['git status --porcelain', ' M package.json'],
    ['git fetch --quiet --no-tags origin main', ''],
    ['git rev-list --left-right --count HEAD...FETCH_HEAD', '1\t2'],
    ['git rev-parse --short=12 FETCH_HEAD', 'bbbbbbbbbbbb'],
    ['git rev-parse --short=12 HEAD', 'aaaaaaaaaaaa'],
  ])
  const controller = createUpdaterController({
    locate: () => ({
      kind: 'source',
      label: 'Git source checkout',
      manager: 'git+pnpm',
      packageRoot: '/repo/apps/cli',
      sourceRoot: '/repo',
      version: '1.0.0',
      branch: 'main',
      upstream: 'origin/main',
      remote: 'origin',
      remoteBranch: 'main',
      canAutoUpdate: true,
      actionLabel: 'Pull and rebuild',
      restartHint: 'Restart.',
    }),
    runCommand: async (program, args) => ({ code: 0, signal: null, output: outputs.get(`${program} ${args.join(' ')}`) ?? '' }),
  })
  controller.initialize()
  const checked = await controller.check()
  assert.equal(checked.updateAvailable, true)
  assert.equal(checked.install.dirty, true)
  assert.equal(checked.install.ahead, 1)
  assert.equal(checked.install.canAutoUpdate, false)
  await assert.rejects(controller.update(), /clean checkout/)
})

test('source update retries install and build without pulling twice after a partial failure', async () => {
  let pulls = 0
  let installs = 0
  let builds = 0
  let repairMarker = false
  const controller = createUpdaterController({
    locate: () => ({
      kind: 'source',
      label: 'Git source checkout',
      manager: 'git+pnpm',
      packageRoot: '/repo/apps/cli',
      sourceRoot: '/repo',
      version: '1.0.0',
      branch: 'main',
      upstream: 'origin/main',
      remote: 'origin',
      remoteBranch: 'main',
      canAutoUpdate: true,
      actionLabel: 'Pull and rebuild',
      restartHint: 'Restart.',
    }),
    inspectSourceDisk: () => ({ version: '1.0.0', currentRef: 'bbbbbbbbbbbb', dirty: false }),
    sourceRepairMarker: {
      exists: () => repairMarker,
      create: () => { repairMarker = true },
      clear: () => { repairMarker = false },
    },
    runCommand: async (program, args) => {
      const command = `${program} ${args.join(' ')}`
      if (command === 'git status --porcelain') return { code: 0, signal: null, output: '' }
      if (command === 'git fetch --quiet --no-tags origin main') return { code: 0, signal: null, output: '' }
      if (command === 'git rev-list --left-right --count HEAD...FETCH_HEAD') {
        return { code: 0, signal: null, output: pulls === 0 ? '0\t1' : '0\t0' }
      }
      if (command === 'git rev-parse --short=12 FETCH_HEAD') return { code: 0, signal: null, output: 'bbbbbbbbbbbb' }
      if (command === 'git rev-parse --short=12 HEAD') return { code: 0, signal: null, output: pulls === 0 ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb' }
      if (command === 'git pull --ff-only origin main') {
        pulls += 1
        return { code: 0, signal: null, output: 'updated' }
      }
      if (command === 'pnpm install --frozen-lockfile') {
        installs += 1
        if (installs === 1) throw new Error('install failed')
        return { code: 0, signal: null, output: 'installed' }
      }
      if (command === 'pnpm run build') {
        builds += 1
        return { code: 0, signal: null, output: 'built' }
      }
      throw new Error(`unexpected command: ${command}`)
    },
  })
  controller.initialize()
  await assert.rejects(controller.update(), /install failed/)
  const failed = controller.snapshot()
  assert.equal(failed.updateAvailable, true)
  assert.equal(failed.install.repairRequired, true)
  assert.equal(failed.install.currentRef, 'bbbbbbbbbbbb')
  assert.equal(failed.installedVersion, '1.0.0')
  assert.equal(failed.install.actionLabel, 'Retry install and build')
  assert.equal(repairMarker, true)

  const repaired = await controller.update()
  assert.equal(repaired.update.status, 'succeeded')
  assert.equal(repaired.install.repairRequired, false)
  assert.equal(repaired.currentVersion, '1.0.0')
  assert.equal(pulls, 1)
  assert.equal(installs, 2)
  assert.equal(builds, 1)
  assert.equal(repairMarker, false)
})

test('durable source marker restores repair state after controller restart', async () => {
  const outputs = new Map([
    ['git status --porcelain', ''],
    ['git fetch --quiet --no-tags origin main', ''],
    ['git rev-list --left-right --count HEAD...FETCH_HEAD', '0\t0'],
    ['git rev-parse --short=12 FETCH_HEAD', 'bbbbbbbbbbbb'],
    ['git rev-parse --short=12 HEAD', 'bbbbbbbbbbbb'],
  ])
  const controller = createUpdaterController({
    locate: () => ({
      kind: 'source',
      label: 'Git source checkout',
      packageRoot: '/repo/apps/cli',
      sourceRoot: '/repo',
      version: '1.0.0',
      branch: 'main',
      upstream: 'origin/main',
      remote: 'origin',
      remoteBranch: 'main',
      canAutoUpdate: true,
    }),
    sourceRepairMarker: { exists: () => true, create() {}, clear() {} },
    runCommand: async (program, args) => ({ code: 0, signal: null, output: outputs.get(`${program} ${args.join(' ')}`) ?? '' }),
  })
  controller.initialize()
  const checked = await controller.check()
  assert.equal(checked.updateAvailable, true)
  assert.equal(checked.install.repairRequired, true)
  assert.equal(checked.install.actionLabel, 'Retry install and build')
})

test('source checks reject Git option-like upstream names before spawning', async () => {
  const controller = createUpdaterController({
    locate: () => ({
      kind: 'source',
      label: 'Git source checkout',
      packageRoot: '/repo/apps/cli',
      sourceRoot: '/repo',
      version: '1.0.0',
      branch: 'main',
      upstream: '--upload-pack=evil/main',
      remote: '--upload-pack=evil',
      remoteBranch: 'main',
      canAutoUpdate: false,
    }),
    runCommand: async () => { throw new Error('must not spawn') },
  })
  controller.initialize()
  await assert.rejects(controller.check(), /safe configured upstream/)
})

test('subprocess timeout closes a descendant that inherited the output pipes', { skip: process.platform === 'win32' }, async () => {
  const script = [
    'const { spawn } = require("node:child_process")',
    'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" })',
    'setTimeout(() => process.exit(0), 10)',
  ].join(';')
  const started = Date.now()
  await assert.rejects(runCommand(process.execPath, ['-e', script], { timeoutMs: 200 }), /timed out after 200 ms/)
  assert.ok(Date.now() - started < 5000, 'the inherited pipe must not keep the updater operation alive')
})

test('spawned updater commands omit secret-bearing environment keys', () => {
  assert.deepEqual(scrubEnvironment({
    PATH: '/bin',
    HOME: '/home/user',
    API_TOKEN: 'secret',
    npm_password: 'secret',
    VALUE: undefined,
  }), {
    PATH: '/bin',
    HOME: '/home/user',
  })
})
