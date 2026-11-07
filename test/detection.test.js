import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  classifyPackageInstall,
  createReleaseEligibilityStore,
  createUpdaterController,
  fetchLatestVersion,
  findSourceRoot,
  isReleaseEligible,
  resolveDshPackageRoot,
  selectLatestEligibleVersion,
  runCommand,
  scrubEnvironment,
} from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-updater-'))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value)}\n`)
}

function releaseInfo(version, tag) {
  return {
    version,
    tag,
    integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAA==',
    tarball: `https://registry.example.test/${version}.tgz`,
    changelog: { source: 'npm', text: `Changes in ${version}`, url: `https://registry.example.test/${version}` },
  }
}

function registryMetadata(version, manifest = {}) {
  return {
    'dist-tags': { latest: version, next: version },
    versions: {
      [version]: {
        ...manifest,
        dist: {
          integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAA==',
          tarball: `https://registry.example.test/${version}.tgz`,
        },
      },
    },
  }
}

async function passingCandidate({ target }) {
  return {
    result: {
      status: 'passed',
      target,
      candidatePath: '/tmp/dsh-candidate',
      checkedAt: '2026-01-01T00:00:00.000Z',
      checks: [
        { id: 'stage', label: 'Candidate install and build', status: 'passed' },
        { id: 'tui', label: 'TUI startup', status: 'passed' },
        { id: 'web', label: 'Web startup and HTTP response', status: 'passed' },
      ],
      blockingIssues: [],
      repairPrompt: null,
    },
    artifactPath: '/tmp/dsh-candidate.tgz',
    dispose() {},
  }
}

test('release discovery prefers changelog text published in npm metadata', async () => {
  let githubRequests = 0
  const release = await fetchLatestVersion('1.0.0', 'https://registry.example.test/', 5000, {
    fetchRegistryMetadata: async () => registryMetadata('2.0.0', { releaseNotes: '## Added\n\n- npm notes' }),
    fetchGithubRelease: async () => { githubRequests += 1; throw new Error('GitHub must not be called') },
  })
  assert.deepEqual(release.changelog, {
    source: 'npm',
    text: '## Added\n\n- npm notes',
    url: 'https://www.npmjs.com/package/@deepseek-ai/dsh/v/2.0.0',
  })
  assert.equal(githubRequests, 0)
})

test('release discovery falls back to the matching GitHub Release', async () => {
  const release = await fetchLatestVersion('1.0.0-rc.1', 'https://registry.example.test/', 5000, {
    fetchRegistryMetadata: async () => registryMetadata('1.0.0-rc.2'),
    releaseEligibility: 'rc',
    fetchGithubRelease: async (version) => ({
      source: 'github',
      text: `Changes for ${version}`,
      url: `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${version}`,
    }),
  })
  assert.deepEqual(release.changelog, {
    source: 'github',
    text: 'Changes for 1.0.0-rc.2',
    url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v1.0.0-rc.2',
  })
})

test('unavailable optional changelog data does not block release discovery', async () => {
  const release = await fetchLatestVersion('1.0.0', 'https://registry.example.test/', 5000, {
    fetchRegistryMetadata: async () => registryMetadata('2.0.0'),
    fetchGithubRelease: async () => { throw new Error('rate limited') },
  })
  assert.deepEqual(release.changelog, {
    source: 'github',
    text: null,
    url: 'https://github.com/deepseek-ai/deepseek-harness/releases',
  })
})

test('release eligibility is cumulative, semver-ordered, and rejects unknown prerelease classes', () => {
  const metadata = {
    versions: Object.fromEntries([
      '2.0.0',
      '3.0.0-rc.10',
      '3.0.0-rc.2',
      '3.0.0-beta.10',
      '3.0.0-beta.2',
      '3.0.0-alpha.10',
      '3.0.0-alpha.2',
      '4.0.0-next.1',
      '5.0.0-preview.1',
    ].map(version => [version, {}])),
  }
  assert.equal(selectLatestEligibleVersion(metadata, 'stable'), '2.0.0')
  assert.equal(selectLatestEligibleVersion(metadata, 'rc'), '3.0.0-rc.10')
  assert.equal(selectLatestEligibleVersion(metadata, 'beta'), '3.0.0-rc.10')
  assert.equal(selectLatestEligibleVersion(metadata, 'alpha'), '3.0.0-rc.10')
  assert.equal(isReleaseEligible('3.0.0-alpha.10', 'alpha'), true)
  assert.equal(selectLatestEligibleVersion({ versions: { '3.0.0-alpha.2': {}, '3.0.0-alpha.10': {} } }, 'alpha'), '3.0.0-alpha.10')
  assert.equal(isReleaseEligible('4.0.0-next.1', 'alpha'), false)
  assert.equal(isReleaseEligible('5.0.0-preview.1', 'alpha'), false)
})

test('release discovery selects the highest eligible npm version rather than trusting dist-tags', async () => {
  const versions = ['1.5.0', '2.0.0-alpha.2', '2.0.0-alpha.10', '2.0.0-beta.1', '2.0.0-rc.1', '3.0.0-next.1']
  const metadata = {
    'dist-tags': { latest: '1.0.0', next: '3.0.0-next.1' },
    versions: Object.fromEntries(versions.map(version => [version, {
      releaseNotes: `Changes in ${version}`,
      dist: {
        integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAA==',
        tarball: `https://registry.example.test/${version}.tgz`,
      },
    }])),
  }
  for (const [releaseEligibility, expected] of [
    ['stable', '1.5.0'],
    ['rc', '2.0.0-rc.1'],
    ['beta', '2.0.0-rc.1'],
    ['alpha', '2.0.0-rc.1'],
  ]) {
    const release = await fetchLatestVersion('1.0.0', 'https://registry.example.test/', 5000, {
      releaseEligibility,
      fetchRegistryMetadata: async () => metadata,
    })
    assert.equal(release.version, expected)
    assert.equal(release.tag, releaseEligibility)
  }
})

test('release eligibility persists with a conservative fallback for invalid data', () => {
  const root = tempDir()
  const file = join(root, 'settings', 'updater.json')
  try {
    const store = createReleaseEligibilityStore(file)
    assert.equal(store.read(), 'stable')
    assert.equal(store.write('beta'), 'beta')
    assert.equal(createReleaseEligibilityStore(file).read(), 'beta')
    writeFileSync(file, '{"releaseEligibility":"nightly"}\n')
    assert.equal(createReleaseEligibilityStore(file).read(), 'stable')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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
    releaseEligibility: 'rc',
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
      return releaseInfo('1.0.0-rc.2', 'next')
    },
    runCommand: async (program, args) => {
      commands.push({ program, args })
      return { code: 0, signal: null, output: 'updated' }
    },
    resolveInstalledVersion: () => '1.0.0-rc.2',
    validateCandidate: passingCandidate,
    verifyCandidateArtifact() {},
    now: () => '2026-01-01T00:00:00.000Z',
  })
  controller.initialize()
  const checked = await controller.check()
  assert.equal(checked.updateAvailable, true)
  assert.equal(checked.updaterApiVersion, 4)
  assert.equal(checked.latestTag, 'next')
  assert.deepEqual(checked.changelog, { source: 'npm', text: 'Changes in 1.0.0-rc.2', url: 'https://registry.example.test/1.0.0-rc.2' })
  assert.equal(checked.install.commandPreview, 'npm install --global @deepseek-ai/dsh@1.0.0-rc.2')
  assert.equal((await controller.validate()).validation.status, 'passed')
  const updated = await controller.update()
  assert.deepEqual(commands, [{
    program: 'npm',
    args: ['install', '--global', '/tmp/dsh-candidate.tgz'],
  }])
  assert.equal(updated.update.status, 'succeeded')
  assert.equal(updated.updateAvailable, false)
  assert.equal(updated.currentVersion, '1.0.0-rc.1')
  assert.equal(updated.installedVersion, '1.0.0-rc.2')
})

test('changing release eligibility discards stale validation and rediscovers before promotion', async () => {
  const writes = []
  let disposals = 0
  const controller = createUpdaterController({
    releaseEligibility: 'alpha',
    releaseEligibilityStore: { read: () => 'alpha', write(value) { writes.push(value); return value } },
    locate: () => ({
      kind: 'npm-global',
      label: 'npm global installation',
      packageRoot: '/opt/dsh',
      version: '1.0.0',
      canAutoUpdate: true,
      template: { program: 'npm', args: ['install', '--global', '{target}'] },
    }),
    fetchLatest: async (_current, _registry, _timeout, { releaseEligibility }) => releaseEligibility === 'stable'
      ? releaseInfo('1.5.0', 'stable')
      : releaseInfo('2.0.0-alpha.10', 'alpha'),
    validateCandidate: async options => {
      const outcome = await passingCandidate(options)
      outcome.dispose = () => { disposals += 1 }
      return outcome
    },
    verifyCandidateArtifact() {},
  })
  controller.initialize()
  const validated = await controller.validate()
  assert.equal(validated.latestVersion, '2.0.0-alpha.10')
  assert.equal(validated.validation.status, 'passed')

  const narrowed = await controller.setReleaseEligibility('stable')
  assert.deepEqual(writes, ['stable'])
  assert.equal(disposals, 1)
  assert.equal(narrowed.releaseEligibility, 'stable')
  assert.equal(narrowed.latestVersion, '1.5.0')
  assert.equal(narrowed.validation.status, 'idle')
  await assert.rejects(controller.update(), error => error?.code === 'NOT_VALIDATED')

  const broadened = await controller.setReleaseEligibility('alpha')
  assert.deepEqual(writes, ['stable', 'alpha'])
  assert.equal(broadened.latestVersion, '2.0.0-alpha.10')
  assert.equal(broadened.validation.status, 'idle')
})

test('controller rejects an ineligible package candidate even from a faulty discovery adapter', async () => {
  const controller = createUpdaterController({
    releaseEligibility: 'stable',
    locate: () => ({
      kind: 'npm-global',
      packageRoot: '/opt/dsh',
      version: '1.0.0',
      canAutoUpdate: true,
      template: { program: 'npm', args: ['install', '--global', '{target}'] },
    }),
    fetchLatest: async () => releaseInfo('2.0.0-preview.1', 'preview'),
  })
  controller.initialize()
  await assert.rejects(controller.check(), /not eligible for Stable only/)
})

test('package promotion rechecks the verified archive and blocks a mutated artifact', async () => {
  let updateCommands = 0
  const controller = createUpdaterController({
    locate: () => ({
      kind: 'npm-global',
      label: 'npm global installation',
      packageRoot: '/opt/dsh',
      version: '1.0.0',
      canAutoUpdate: true,
      template: { program: 'npm', args: ['install', '--global', '{target}'] },
    }),
    fetchLatest: async () => releaseInfo('2.0.0', 'latest'),
    validateCandidate: passingCandidate,
    verifyCandidateArtifact() { throw new Error('integrity mismatch') },
    runCommand: async () => {
      updateCommands += 1
      return { code: 0, signal: null, output: '' }
    },
  })
  controller.initialize()
  await controller.validate()
  await assert.rejects(controller.update(), error => error?.code === 'NOT_VALIDATED' && /changed before update/.test(error.message))
  assert.equal(controller.snapshot().validation.status, 'idle')
  assert.equal(updateCommands, 0)
})

test('blocking candidate results withhold the active update and provide a repair prompt', async () => {
  let updateCommands = 0
  const controller = createUpdaterController({
    locate: () => ({
      kind: 'npm-global',
      label: 'npm global installation',
      manager: 'npm',
      packageRoot: '/opt/dsh',
      version: '1.0.0',
      canAutoUpdate: true,
      actionLabel: 'Update DSH',
      template: { program: 'npm', args: ['install', '--global', '{target}'] },
    }),
    fetchLatest: async () => releaseInfo('2.0.0', 'latest'),
    runCommand: async () => {
      updateCommands += 1
      return { code: 0, signal: null, output: '' }
    },
    validateCandidate: async ({ target }) => ({
      result: {
        status: 'blocked',
        target,
        candidatePath: '/tmp/blocked-candidate',
        checkedAt: '2026-01-01T00:00:00.000Z',
        checks: [
          { id: 'stage', label: 'Candidate install and build', status: 'passed' },
          { id: 'tui', label: 'TUI startup', status: 'failed', error: 'profile tui does not exist' },
          { id: 'web', label: 'Web startup and HTTP response', status: 'passed' },
        ],
        blockingIssues: [{ check: 'tui', message: 'profile tui does not exist' }],
        repairPrompt: 'Fix the candidate TUI profile without changing the active installation.',
      },
      dispose() {},
    }),
  })
  controller.initialize()
  const blocked = await controller.validate()
  assert.equal(blocked.validation.status, 'blocked')
  assert.match(blocked.validation.repairPrompt, /Finish this DSH update end to end/)
  assert.match(blocked.validation.repairPrompt, /Currently running DSH version: 1\.0\.0/)
  assert.match(blocked.validation.repairPrompt, /Available update version: 2\.0\.0/)
  assert.match(blocked.validation.repairPrompt, /configuration[\s\S]*installed or linked plugin/)
  assert.match(blocked.validation.repairPrompt, /working update is applied to the active installation and DSH is restarted/)
  assert.doesNotMatch(blocked.validation.repairPrompt, /without changing the active installation/)
  await assert.rejects(controller.update(), error => error?.code === 'NOT_VALIDATED')
  assert.equal(updateCommands, 0)
})

test('update rejects a concurrent validation instead of returning the wrong operation result', async () => {
  let releaseValidation
  let markProgress
  const ready = new Promise(resolve => { releaseValidation = resolve })
  const progressed = new Promise(resolve => { markProgress = resolve })
  const controller = createUpdaterController({
    locate: () => ({
      kind: 'npm-global',
      label: 'npm global installation',
      packageRoot: '/opt/dsh',
      version: '1.0.0',
      canAutoUpdate: true,
      template: { program: 'npm', args: ['install', '--global', '{target}'] },
    }),
    fetchLatest: async () => releaseInfo('2.0.0', 'latest'),
    validateCandidate: async (options) => {
      options.onProgress({
        phase: 'install',
        message: 'Installing candidate dependencies…',
        candidatePath: '/tmp/running-candidate',
        checks: [],
      })
      markProgress()
      await ready
      return passingCandidate(options)
    },
  })
  controller.initialize()
  const validating = controller.validate()
  await progressed
  assert.equal(controller.snapshot().validation.phase, 'install')
  assert.equal(controller.snapshot().validation.message, 'Installing candidate dependencies…')
  assert.equal(controller.snapshot().validation.candidatePath, '/tmp/running-candidate')
  await assert.rejects(controller.update(), error => error?.code === 'BUSY')
  await assert.rejects(controller.check(), error => error?.code === 'BUSY')
  releaseValidation()
  await validating
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
    fetchLatest: async () => releaseInfo('2.0.0', 'latest'),
    runCommand: async () => ({ code: 0, signal: null, output: '' }),
    resolveInstalledVersion: () => '1.5.0',
    validateCandidate: passingCandidate,
    verifyCandidateArtifact() {},
  })
  controller.initialize()
  await controller.validate()
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
    releaseEligibility: 'rc',
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
    fetchLatest: async () => releaseInfo('1.0.0-rc.2', 'next'),
    runCommand: async () => {
      executions += 1
      return { code: 0, signal: null, output: '1.0.0-rc.2' }
    },
    validateCandidate: passingCandidate,
    verifyCandidateArtifact() {},
  })
  controller.initialize()
  await controller.validate()
  const updated = await controller.update()
  assert.equal(updated.currentVersion, '1.0.0-rc.1')
  assert.equal(updated.install.preparedVersion, '1.0.0-rc.2')
  assert.match(updated.install.restartHint, /@deepseek-ai\/dsh@1\.0\.0-rc\.2/)
  const rechecked = await controller.check()
  assert.equal(rechecked.updateAvailable, false)
  assert.equal(executions, 1)
})

test('source discovery hides upstream commits with an ineligible or unknown prerelease class', async () => {
  const outputs = new Map([
    ['git status --porcelain', ''],
    ['git fetch --quiet --no-tags origin main', ''],
    ['git rev-list --left-right --count HEAD...FETCH_HEAD', '0\t1'],
    ['git rev-parse --short=12 FETCH_HEAD', 'bbbbbbbbbbbb'],
    ['git rev-parse FETCH_HEAD', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    ['git show FETCH_HEAD:apps/cli/package.json', '{"version":"2.0.0-nightly.1"}'],
    ['git rev-parse --short=12 HEAD', 'aaaaaaaaaaaa'],
    ['git rev-parse HEAD', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ])
  const controller = createUpdaterController({
    releaseEligibility: 'alpha',
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
    sourceRepairMarker: { exists: () => false, create() {}, clear() {} },
    runCommand: async (program, args) => ({ code: 0, signal: null, output: outputs.get(`${program} ${args.join(' ')}`) ?? '' }),
  })
  controller.initialize()
  const checked = await controller.check()
  assert.equal(checked.updateAvailable, false)
  assert.equal(checked.latestVersion, '1.0.0')
  assert.equal(checked.install.latestRef, 'aaaaaaaaaaaa')
  assert.equal(checked.install.latestCommit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(checked.install.canAutoUpdate, false)
})

test('source controller refuses automatic updates for dirty or ahead checkouts', async () => {
  const outputs = new Map([
    ['git status --porcelain', ' M package.json'],
    ['git fetch --quiet --no-tags origin main', ''],
    ['git rev-list --left-right --count HEAD...FETCH_HEAD', '1\t2'],
    ['git rev-parse --short=12 FETCH_HEAD', 'bbbbbbbbbbbb'],
    ['git rev-parse FETCH_HEAD', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    ['git show FETCH_HEAD:apps/cli/package.json', '{"version":"2.0.0"}'],
    ['git rev-parse --short=12 HEAD', 'aaaaaaaaaaaa'],
    ['git rev-parse HEAD', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
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
    validateCandidate: passingCandidate,
    verifyCandidateArtifact() {},
    runCommand: async (program, args) => {
      const command = `${program} ${args.join(' ')}`
      if (command === 'git status --porcelain') return { code: 0, signal: null, output: '' }
      if (command === 'git fetch --quiet --no-tags origin main') return { code: 0, signal: null, output: '' }
      if (command === 'git rev-list --left-right --count HEAD...FETCH_HEAD') {
        return { code: 0, signal: null, output: pulls === 0 ? '0\t1' : '0\t0' }
      }
      if (command === 'git rev-parse --short=12 FETCH_HEAD') return { code: 0, signal: null, output: 'bbbbbbbbbbbb' }
      if (command === 'git rev-parse FETCH_HEAD') return { code: 0, signal: null, output: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
      if (command === 'git show FETCH_HEAD:apps/cli/package.json') return { code: 0, signal: null, output: '{"version":"2.0.0"}' }
      if (command === 'git rev-parse --short=12 HEAD') return { code: 0, signal: null, output: pulls === 0 ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb' }
      if (command === 'git rev-parse HEAD') return { code: 0, signal: null, output: pulls === 0 ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
      if (command === 'git merge --ff-only bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') {
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
  await controller.validate()
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
    ['git rev-parse FETCH_HEAD', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    ['git show FETCH_HEAD:apps/cli/package.json', '{"version":"2.0.0"}'],
    ['git rev-parse --short=12 HEAD', 'bbbbbbbbbbbb'],
    ['git rev-parse HEAD', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
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
