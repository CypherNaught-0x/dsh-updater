import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { homedir } from 'node:os'
import { dirname, join, parse, relative, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import z from '@deepseek-ai/schemastery'
import semver from 'semver'
import { candidateTarget, repairPrompt, targetFingerprint, validateCandidate as validateCandidateRelease, verifyFileIntegrity } from './candidate.js'

const name = 'dsh-updater'
const inject = ['timer', 'webServer']
const PACKAGE_NAME = '@deepseek-ai/dsh'
const GITHUB_RELEASES_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases'
const GITHUB_RELEASES_API = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/'
const MAX_CHANGELOG_BYTES = 64 * 1024
const STATUS_ROUTE = '/dsh-updater/status'
const CHECK_ROUTE = '/dsh-updater/check'
const VALIDATE_ROUTE = '/dsh-updater/validate'
const UPDATE_ROUTE = '/dsh-updater/update'
const ELIGIBILITY_ROUTE_PREFIX = '/dsh-updater/release-eligibility/'
const RELEASE_ELIGIBILITY = Object.freeze({
  stable: { label: 'Stable only', classes: [] },
  rc: { label: 'Stable + RC', classes: ['rc'] },
  beta: { label: 'Stable + RC + Beta', classes: ['rc', 'beta'] },
  alpha: { label: 'All including Alpha', classes: ['rc', 'beta', 'alpha'] },
})
const DEFAULT_RELEASE_ELIGIBILITY = 'stable'
const MAX_OUTPUT_BYTES = 256 * 1024

const Config = z.object({
  checkIntervalMinutes: z.number().step(1).min(5).max(7 * 24 * 60).default(360),
  registryUrl: z.string().default('https://registry.npmjs.org/'),
  requestTimeoutMs: z.number().step(1).min(1000).max(120000).default(15000),
  candidateInstaller: z.string().default('auto'),
  candidateTimeoutMinutes: z.number().step(1).min(1).max(120).default(20),
  startupTimeoutSeconds: z.number().step(1).min(5).max(300).default(60),
  updateTimeoutMinutes: z.number().step(1).min(1).max(120).default(20),
})

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function parentDirectories(start) {
  const values = []
  let current = resolve(start)
  for (;;) {
    values.push(current)
    const parent = dirname(current)
    if (parent === current) return values
    current = parent
  }
}

function safeRealpath(file) {
  try {
    return realpathSync(file)
  } catch {
    return resolve(file)
  }
}

function resolveDshPackageRoot(entryPath = process.argv[1]) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    throw new Error('dsh-updater: cannot locate the running DSH entry point')
  }
  const starts = [dirname(resolve(entryPath)), dirname(safeRealpath(entryPath))]
  const seen = new Set()
  for (const start of starts) {
    for (const directory of parentDirectories(start)) {
      if (seen.has(directory)) continue
      seen.add(directory)
      const manifest = readJson(join(directory, 'package.json'))
      if (manifest?.name === PACKAGE_NAME) {
        if (typeof manifest.version !== 'string' || !semver.valid(manifest.version)) {
          throw new Error(`dsh-updater: ${join(directory, 'package.json')} has no valid semantic version`)
        }
        return { packageRoot: directory, version: manifest.version, entryPath: resolve(entryPath) }
      }
    }
  }
  throw new Error(`dsh-updater: cannot find ${PACKAGE_NAME}/package.json above ${entryPath}`)
}

function findSourceRoot(packageRoot) {
  for (const directory of parentDirectories(packageRoot)) {
    const cli = readJson(join(directory, 'apps', 'cli', 'package.json'))
    if (existsSync(join(directory, '.git'))
      && existsSync(join(directory, 'pnpm-workspace.yaml'))
      && cli?.name === PACKAGE_NAME) return directory
  }
  return undefined
}

function syncCommand(program, args, cwd, timeoutMs = 4000) {
  const result = spawnSync(program, args, {
    cwd,
    env: scrubEnvironment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  })
  if (result.error !== undefined || result.status !== 0) return undefined
  return String(result.stdout).trim()
}

function probeGlobalRoots() {
  const roots = {}
  const npm = syncCommand('npm', ['root', '--global'])
  const pnpm = syncCommand('pnpm', ['root', '--global'])
  const yarn = syncCommand('yarn', ['global', 'dir'])
  if (npm) roots.npm = npm
  if (pnpm) roots.pnpm = pnpm
  if (yarn) roots.yarn = join(yarn, 'node_modules')
  if (typeof process.env.HOME === 'string') {
    roots.bun = join(process.env.HOME, '.bun', 'install', 'global', 'node_modules')
  }
  return roots
}

function normalizedPath(value) {
  const normalized = resolve(value).replaceAll('\\', '/').replace(/\/$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function samePackageAtRoot(packageRoot, modulesRoot) {
  const candidate = join(modulesRoot, ...PACKAGE_NAME.split('/'))
  return normalizedPath(safeRealpath(packageRoot)) === normalizedPath(safeRealpath(candidate))
}

function projectRootFromPackage(packageRoot) {
  const normalized = resolve(packageRoot).replaceAll('\\', '/')
  const marker = '/node_modules/'
  const index = normalized.indexOf(marker)
  return index < 0 ? undefined : normalized.slice(0, index)
}

function managerForProject(projectRoot, packageRoot) {
  const manifest = readJson(join(projectRoot, 'package.json'))
  const declared = typeof manifest?.packageManager === 'string'
    ? manifest.packageManager.split('@')[0]
    : undefined
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared
  const packagePath = normalizedPath(packageRoot)
  if (packagePath.includes('/.pnpm/')) return 'pnpm'
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(projectRoot, 'bun.lock')) || existsSync(join(projectRoot, 'bun.lockb'))) return 'bun'
  if (existsSync(join(projectRoot, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(projectRoot, 'package-lock.json')) || existsSync(join(projectRoot, 'npm-shrinkwrap.json'))) return 'npm'
  return manifest === undefined ? undefined : 'npm'
}

function updateTemplate(manager, global) {
  if (global) {
    if (manager === 'pnpm') return { program: 'pnpm', args: ['add', '--global', '{target}'] }
    if (manager === 'yarn') return { program: 'yarn', args: ['global', 'add', '{target}'] }
    if (manager === 'bun') return { program: 'bun', args: ['add', '--global', '{target}'] }
    return { program: 'npm', args: ['install', '--global', '{target}'] }
  }
  if (manager === 'pnpm') return { program: 'pnpm', args: ['update', '{target}'] }
  if (manager === 'yarn') return { program: 'yarn', args: ['add', '{target}'] }
  if (manager === 'bun') return { program: 'bun', args: ['update', '{target}'] }
  return { program: 'npm', args: ['install', '{target}'] }
}

function commandPreview(template) {
  if (template === undefined) return undefined
  return [template.program, ...template.args].join(' ')
}

function classifyPackageInstall({ packageRoot, entryPath, version, globalRoots = probeGlobalRoots() }) {
  const path = normalizedPath(packageRoot)
  const entry = normalizedPath(entryPath)
  if (path.includes('/_npx/') || entry.includes('/_npx/')) {
    const template = {
      program: 'npm',
      args: ['exec', '--yes', '--package={target}', '--', 'dsh', '--version'],
    }
    return {
      kind: 'npx',
      label: 'npm exec / npx cache',
      manager: 'npm',
      packageRoot,
      version,
      canAutoUpdate: true,
      actionLabel: 'Prepare update',
      template,
      commandPreview: commandPreview(template),
      restartHint: `Stop this process, then run npx ${PACKAGE_NAME}@latest web.`,
    }
  }

  for (const manager of ['pnpm', 'npm', 'yarn', 'bun']) {
    const root = globalRoots[manager]
    if (typeof root !== 'string' || !samePackageAtRoot(packageRoot, root)) continue
    const template = updateTemplate(manager, true)
    return {
      kind: `${manager}-global`,
      label: `${manager} global installation`,
      manager,
      packageRoot,
      version,
      canAutoUpdate: true,
      actionLabel: 'Update DSH',
      template,
      commandPreview: commandPreview(template),
      restartHint: 'Restart the DSH process after the update completes.',
    }
  }

  const projectRoot = projectRootFromPackage(packageRoot)
  if (projectRoot !== undefined) {
    const manager = managerForProject(projectRoot, packageRoot)
    if (manager !== undefined) {
      const template = { ...updateTemplate(manager, false), cwd: projectRoot }
      return {
        kind: `${manager}-local`,
        label: `${manager} project installation`,
        manager,
        packageRoot,
        projectRoot,
        version,
        canAutoUpdate: true,
        actionLabel: 'Update DSH',
        template,
        commandPreview: commandPreview(template),
        restartHint: 'Restart the project-owned DSH process after the update completes.',
      }
    }
  }

  return {
    kind: 'unknown-package',
    label: 'unrecognized package installation',
    packageRoot,
    version,
    canAutoUpdate: false,
    actionLabel: 'Update unavailable',
    restartHint: `Update ${PACKAGE_NAME} with the package manager that owns ${packageRoot}.`,
  }
}

function safeGitRemote(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
}

function safeGitBranch(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    && !value.includes('..')
    && !value.endsWith('.')
    && !value.endsWith('/')
}

function detectInstallation(options = {}) {
  const resolved = resolveDshPackageRoot(options.entryPath)
  const sourceRoot = findSourceRoot(resolved.packageRoot)
  if (sourceRoot !== undefined) {
    const branch = syncCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], sourceRoot)
    const upstream = syncCommand('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], sourceRoot)
    const remote = upstream?.includes('/') ? upstream.slice(0, upstream.indexOf('/')) : undefined
    const remoteBranch = upstream?.includes('/') ? upstream.slice(upstream.indexOf('/') + 1) : undefined
    const canAutoUpdate = branch !== undefined && branch !== 'HEAD' && safeGitRemote(remote) && safeGitBranch(remoteBranch)
    return {
      kind: 'source',
      label: 'Git source checkout',
      manager: 'git+pnpm',
      packageRoot: resolved.packageRoot,
      sourceRoot,
      version: resolved.version,
      branch,
      upstream,
      remote,
      remoteBranch,
      canAutoUpdate,
      actionLabel: canAutoUpdate ? 'Pull and rebuild' : 'Update unavailable',
      commandPreview: canAutoUpdate ? `git pull --ff-only ${remote} ${remoteBranch} && pnpm install --frozen-lockfile && pnpm run build` : undefined,
      restartHint: 'Restart pnpm dsh web after the rebuild completes.',
    }
  }
  return classifyPackageInstall({
    ...resolved,
    globalRoots: options.globalRoots,
  })
}

function fetchRegistryMetadata(registryUrl, timeoutMs) {
  const base = registryUrl.endsWith('/') ? registryUrl : `${registryUrl}/`
  const url = new URL(encodeURIComponent(PACKAGE_NAME), base)
  if (url.protocol !== 'https:') throw new Error('dsh-updater: registryUrl must use HTTPS')
  return new Promise((resolvePromise, reject) => {
    const req = request(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': name,
      },
    }, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) {
          req.destroy(new Error('dsh-updater: registry response exceeds 2 MiB'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`dsh-updater: registry returned HTTP ${String(res.statusCode)}`))
          return
        }
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new Error(`dsh-updater: invalid registry response: ${errorMessage(error)}`))
        }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`dsh-updater: registry request timed out after ${timeoutMs} ms`)))
    req.on('error', reject)
    req.end()
  })
}

function boundedChangelog(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const normalized = value.replaceAll('\r\n', '\n').trim()
  if (Buffer.byteLength(normalized) <= MAX_CHANGELOG_BYTES) return normalized
  const bytes = Buffer.from(normalized)
  let end = MAX_CHANGELOG_BYTES - Buffer.byteLength('\n\n…')
  while (end > 0 && (bytes[end] & 0xC0) === 0x80) end -= 1
  return `${bytes.subarray(0, end).toString('utf8').trimEnd()}\n\n…`
}

function npmChangelog(metadata, version) {
  const manifest = metadata?.versions?.[version]
  const text = [
    manifest?.releaseNotes,
    manifest?.release_notes,
    manifest?.changelog,
    manifest?.dsh?.releaseNotes,
    manifest?.dsh?.changelog,
  ].map(boundedChangelog).find(value => value !== undefined)
  if (text === undefined) return undefined
  return {
    source: 'npm',
    text,
    url: `https://www.npmjs.com/package/${PACKAGE_NAME}/v/${encodeURIComponent(version)}`,
  }
}

function fetchGithubRelease(version, timeoutMs) {
  const tag = `dsh-v${version}`
  const apiUrl = new URL(encodeURIComponent(tag), GITHUB_RELEASES_API)
  const releaseUrl = `${GITHUB_RELEASES_URL}/tag/${encodeURIComponent(tag)}`
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error === undefined) resolvePromise(value)
      else reject(error)
    }
    const req = request(apiUrl, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': name,
        'x-github-api-version': '2022-11-28',
      },
    }, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 512 * 1024) req.destroy(new Error('dsh-updater: GitHub release response exceeds 512 KiB'))
        else chunks.push(chunk)
      })
      res.on('end', () => {
        if (!res.complete) {
          finish(new Error('dsh-updater: GitHub release response ended prematurely'))
          return
        }
        if (res.statusCode === 404) {
          finish(undefined, { source: 'github', text: null, url: GITHUB_RELEASES_URL })
          return
        }
        if (res.statusCode !== 200) {
          finish(new Error(`dsh-updater: GitHub releases returned HTTP ${String(res.statusCode)}`))
          return
        }
        try {
          const release = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          finish(undefined, { source: 'github', text: boundedChangelog(release?.body) ?? null, url: releaseUrl })
        } catch (error) {
          finish(new Error(`dsh-updater: invalid GitHub release response: ${errorMessage(error)}`))
        }
      })
      res.on('aborted', () => finish(new Error('dsh-updater: GitHub release response was aborted')))
      res.on('error', error => finish(error))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`dsh-updater: GitHub release request timed out after ${timeoutMs} ms`)))
    req.on('error', error => finish(error))
    req.end()
  })
}

function normalizeReleaseEligibility(value) {
  return Object.hasOwn(RELEASE_ELIGIBILITY, value) ? value : DEFAULT_RELEASE_ELIGIBILITY
}

function prereleaseClass(version) {
  const prerelease = semver.prerelease(version)
  if (prerelease === null) return 'stable'
  const value = prerelease[0]
  return typeof value === 'string' && ['rc', 'beta', 'alpha'].includes(value.toLowerCase())
    ? value.toLowerCase()
    : 'unknown'
}

function isReleaseEligible(version, eligibility = DEFAULT_RELEASE_ELIGIBILITY) {
  if (typeof version !== 'string' || !semver.valid(version)) return false
  const releaseClass = prereleaseClass(version)
  if (releaseClass === 'stable') return true
  if (releaseClass === 'unknown') return false
  return RELEASE_ELIGIBILITY[normalizeReleaseEligibility(eligibility)].classes.includes(releaseClass)
}

function selectLatestEligibleVersion(metadata, eligibility = DEFAULT_RELEASE_ELIGIBILITY) {
  const versions = metadata?.versions
  if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) {
    throw new Error(`dsh-updater: registry has no version metadata for ${PACKAGE_NAME}`)
  }
  const eligible = Object.keys(versions).filter(version => isReleaseEligible(version, eligibility))
  if (eligible.length === 0) {
    throw new Error(`dsh-updater: registry has no valid ${normalizeReleaseEligibility(eligibility)}-eligible release for ${PACKAGE_NAME}`)
  }
  return semver.rsort(eligible)[0]
}

async function fetchLatestVersion(currentVersion, registryUrl, timeoutMs, options = {}) {
  const metadata = await (options.fetchRegistryMetadata ?? fetchRegistryMetadata)(registryUrl, timeoutMs)
  const eligibility = normalizeReleaseEligibility(options.releaseEligibility)
  const version = selectLatestEligibleVersion(metadata, eligibility)
  const tag = eligibility
  const dist = metadata?.versions?.[version]?.dist
  if (typeof dist?.integrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u.test(dist.integrity)) {
    throw new Error(`dsh-updater: registry metadata for ${PACKAGE_NAME}@${version} has no supported integrity digest`)
  }
  let tarball
  try {
    tarball = new URL(dist.tarball)
  } catch {
    throw new Error(`dsh-updater: registry metadata for ${PACKAGE_NAME}@${version} has no valid tarball URL`)
  }
  if (tarball.protocol !== 'https:') {
    throw new Error(`dsh-updater: registry tarball for ${PACKAGE_NAME}@${version} must use HTTPS`)
  }
  let changelog = npmChangelog(metadata, version)
  if (changelog === undefined) {
    try {
      changelog = await (options.fetchGithubRelease ?? fetchGithubRelease)(version, timeoutMs)
    } catch {
      // Release notes are optional; registry discovery and candidate validation still own update safety.
      changelog = { source: 'github', text: null, url: GITHUB_RELEASES_URL }
    }
  }
  return { version, tag, integrity: dist.integrity, tarball: tarball.href, changelog }
}

function scrubEnvironment(environment = process.env) {
  const clean = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || /(KEY|SECRET|TOKEN|PASSWORD)/i.test(key)) continue
    clean[key] = value
  }
  return clean
}

function redactOutput(value) {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1***:***@')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, '$1***@')
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString('utf8')
  if (Buffer.byteLength(next) <= MAX_OUTPUT_BYTES) return next
  return Buffer.from(next).subarray(-MAX_OUTPUT_BYTES).toString('utf8')
}

function runCommand(program, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const commandTimeoutMs = options.timeoutMs ?? 60_000
    let settled = false
    let output = ''
    let timedOut = false
    let stopping = false
    let killTimer
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: scrubEnvironment(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    })
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      if (error !== undefined) reject(error)
      else resolvePromise(value)
    }
    const terminate = (signal) => {
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        spawnSync('taskkill', [
          '/pid', String(child.pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : []),
        ], {
          env: scrubEnvironment(),
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000,
        })
        return
      }
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    const stop = () => {
      if (settled) return
      stopping = true
      terminate('SIGTERM')
      child.stdout.destroy()
      child.stderr.destroy()
      killTimer = setTimeout(() => terminate('SIGKILL'), 2000)
      killTimer.unref?.()
    }
    const abort = () => stop()
    child.stdout.on('data', chunk => { output = appendBounded(output, chunk) })
    child.stderr.on('data', chunk => { output = appendBounded(output, chunk) })
    child.on('error', error => finish(error))
    child.on('close', (code, signal) => {
      if (stopping) terminate('SIGKILL')
      const visibleOutput = redactOutput(output.trim())
      if (options.signal?.aborted) {
        finish(new Error(`${program} was cancelled`))
        return
      }
      if (timedOut) {
        finish(new Error(`${program} timed out after ${commandTimeoutMs} ms${visibleOutput ? `\n${visibleOutput}` : ''}`))
        return
      }
      if (code !== 0) {
        finish(new Error(`${program} exited with code ${String(code)}${signal ? ` (${signal})` : ''}${visibleOutput ? `\n${visibleOutput}` : ''}`))
        return
      }
      finish(undefined, { code, signal, output: visibleOutput })
    })
    const timeout = setTimeout(() => {
      timedOut = true
      stop()
    }, commandTimeoutMs)
    timeout.unref?.()
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
  })
}

function copyInstall(install) {
  const {
    template: _template,
    candidateIntegrity: _candidateIntegrity,
    candidateTarball: _candidateTarball,
    ...publicFields
  } = install
  return { ...publicFields }
}

function initialValidation() {
  return {
    status: 'idle',
    target: null,
    fingerprint: null,
    phase: null,
    message: null,
    candidatePath: null,
    checkedAt: null,
    checks: [],
    blockingIssues: [],
    repairPrompt: null,
  }
}

function defaultSettingsFile() {
  const root = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(root, 'dsh-updater.json')
}

function createReleaseEligibilityStore(file = defaultSettingsFile()) {
  return {
    read() {
      const value = readJson(file)?.releaseEligibility
      return normalizeReleaseEligibility(value)
    },
    write(releaseEligibility) {
      const normalized = normalizeReleaseEligibility(releaseEligibility)
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
      try {
        writeFileSync(temporary, `${JSON.stringify({ releaseEligibility: normalized })}\n`, { encoding: 'utf8', mode: 0o600 })
        renameSync(temporary, file)
      } catch (error) {
        try { unlinkSync(temporary) } catch {}
        throw error
      }
      return normalized
    },
  }
}

function initialState(releaseEligibility = DEFAULT_RELEASE_ELIGIBILITY) {
  return {
    updaterApiVersion: 4,
    releaseEligibility: normalizeReleaseEligibility(releaseEligibility),
    status: 'starting',
    currentVersion: null,
    installedVersion: null,
    latestVersion: null,
    latestTag: null,
    changelog: null,
    updateAvailable: false,
    checkedAt: null,
    error: null,
    install: null,
    validation: initialValidation(),
    update: { status: 'idle', message: null, error: null, output: null },
  }
}

function sourceRepairMarkerPath(install) {
  const gitDirectory = syncCommand('git', ['rev-parse', '--git-dir'], install.sourceRoot)
  return gitDirectory === undefined ? undefined : join(resolve(install.sourceRoot, gitDirectory), 'dsh-updater-repair.json')
}

const defaultSourceRepairMarker = {
  exists(install) {
    const file = sourceRepairMarkerPath(install)
    return file !== undefined && existsSync(file)
  },
  create(install) {
    const file = sourceRepairMarkerPath(install)
    if (file === undefined) throw new Error('dsh-updater: cannot resolve the source checkout Git directory')
    if (!existsSync(file)) {
      writeFileSync(file, `${JSON.stringify({ startedAt: new Date().toISOString(), from: install.currentRef ?? null })}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    }
  },
  clear(install) {
    const file = sourceRepairMarkerPath(install)
    if (file === undefined) return
    try {
      unlinkSync(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  },
}

function sourceUpdatePlan(install, validatedCommit) {
  const build = [
    { program: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: install.sourceRoot },
    { program: 'pnpm', args: ['run', 'build'], cwd: install.sourceRoot },
  ]
  return install.repairRequired === true && install.behind === 0 && install.currentCommit === validatedCommit
    ? build
    : [{ program: 'git', args: ['merge', '--ff-only', validatedCommit], cwd: install.sourceRoot }, ...build]
}

function inspectSourceDisk(install) {
  const manifest = readJson(join(install.packageRoot, 'package.json'))
  return {
    version: typeof manifest?.version === 'string' && semver.valid(manifest.version) ? manifest.version : install.version,
    currentRef: syncCommand('git', ['rev-parse', '--short=12', 'HEAD'], install.sourceRoot),
    currentCommit: syncCommand('git', ['rev-parse', 'HEAD'], install.sourceRoot),
    dirty: (syncCommand('git', ['status', '--porcelain'], install.sourceRoot) ?? '').length > 0,
  }
}

function packageUpdatePlan(install, version, artifactPath) {
  const target = artifactPath ?? `${PACKAGE_NAME}@${version}`
  return [{
    program: install.template.program,
    args: install.template.args.map(value => value.replace('{target}', target)),
    cwd: install.template.cwd,
  }]
}

function installForRelease(install, version, artifact) {
  if (install.template === undefined) return install
  const [step] = packageUpdatePlan(install, version)
  return {
    ...install,
    candidateIntegrity: artifact.integrity,
    candidateTarball: artifact.tarball,
    commandPreview: [step.program, ...step.args].join(' '),
    ...(install.kind === 'npx'
      ? { restartHint: `Stop this process, then run npx ${PACKAGE_NAME}@${version} web.` }
      : {}),
  }
}

function createUpdaterController(options = {}) {
  const config = {
    checkIntervalMinutes: options.config?.checkIntervalMinutes ?? 360,
    registryUrl: options.config?.registryUrl ?? 'https://registry.npmjs.org/',
    requestTimeoutMs: options.config?.requestTimeoutMs ?? 15000,
    candidateInstaller: options.config?.candidateInstaller ?? 'auto',
    candidateTimeoutMinutes: options.config?.candidateTimeoutMinutes ?? 20,
    startupTimeoutSeconds: options.config?.startupTimeoutSeconds ?? 60,
    updateTimeoutMinutes: options.config?.updateTimeoutMinutes ?? 20,
  }
  if (!['auto', 'npm', 'pnpm'].includes(config.candidateInstaller)) {
    throw new Error('dsh-updater: candidateInstaller must be auto, npm, or pnpm')
  }
  const locate = options.locate ?? (() => detectInstallation())
  const latest = options.fetchLatest ?? fetchLatestVersion
  const execute = options.runCommand ?? runCommand
  const resolveInstalledVersion = options.resolveInstalledVersion ?? (() => resolveDshPackageRoot().version)
  const inspectSource = options.inspectSourceDisk ?? inspectSourceDisk
  const sourceRepairMarker = options.sourceRepairMarker ?? defaultSourceRepairMarker
  const candidateValidator = options.validateCandidate ?? validateCandidateRelease
  const verifyCandidateArtifact = options.verifyCandidateArtifact ?? verifyFileIntegrity
  const runStartup = options.runStartup
  const now = options.now ?? (() => new Date().toISOString())
  const logger = options.logger ?? console
  const eligibilityStore = options.releaseEligibilityStore ?? createReleaseEligibilityStore()
  let releaseEligibility = normalizeReleaseEligibility(options.releaseEligibility ?? eligibilityStore.read())
  let state = initialState(releaseEligibility)
  let install
  let checkPromise
  let validationPromise
  let updatePromise
  let candidateArtifact
  let candidateDispose
  let operationAbort
  let disposed = false

  const publish = (patch) => {
    state = { ...state, ...patch }
  }

  const discardCandidate = () => {
    const disposeCandidate = candidateDispose
    candidateArtifact = undefined
    candidateDispose = undefined
    if (disposeCandidate === undefined) return
    try {
      disposeCandidate()
    } catch (error) {
      logger.warn(`candidate cleanup failed: ${errorMessage(error)}`)
    }
  }

  const initialize = () => {
    if (install !== undefined) return
    install = locate()
    publish({
      status: 'idle',
      currentVersion: install.version,
      installedVersion: install.version,
      install: copyInstall(install),
    })
  }

  const executeStep = async (step, signal) => execute(step.program, step.args, {
    cwd: step.cwd,
    timeoutMs: config.updateTimeoutMinutes * 60_000,
    signal,
  })

  const checkSource = async (signal) => {
    if (install.branch === undefined || install.branch === 'HEAD' || !safeGitRemote(install.remote) || !safeGitBranch(install.remoteBranch)) {
      throw new Error('dsh-updater: source checkout must be on a branch with a safe configured upstream')
    }
    const status = await execute('git', ['status', '--porcelain'], {
      cwd: install.sourceRoot,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })
    await execute('git', ['fetch', '--quiet', '--no-tags', install.remote, install.remoteBranch], {
      cwd: install.sourceRoot,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })
    const counts = await execute('git', ['rev-list', '--left-right', '--count', 'HEAD...FETCH_HEAD'], {
      cwd: install.sourceRoot,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })
    const [aheadText, behindText] = counts.output.trim().split(/\s+/)
    const ahead = Number.parseInt(aheadText, 10)
    const behind = Number.parseInt(behindText, 10)
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
      throw new Error(`dsh-updater: cannot parse git divergence: ${counts.output}`)
    }
    const latestRef = await execute('git', ['rev-parse', '--short=12', 'FETCH_HEAD'], {
      cwd: install.sourceRoot,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })
    const latestCommit = await execute('git', ['rev-parse', 'FETCH_HEAD'], {
      cwd: install.sourceRoot,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })
    if (!/^[0-9a-f]{40}$/u.test(latestCommit.output)) {
      throw new Error(`dsh-updater: cannot resolve immutable source candidate: ${latestCommit.output}`)
    }
    const packageRelative = relative(install.sourceRoot, join(install.packageRoot, 'package.json')).replaceAll('\\', '/')
    if (packageRelative.startsWith('../') || packageRelative === '..') {
      throw new Error('dsh-updater: source package manifest is outside the source checkout')
    }
    const candidateManifestResult = await execute('git', ['show', `FETCH_HEAD:${packageRelative}`], {
      cwd: install.sourceRoot,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })
    let candidateVersion
    try {
      const manifest = JSON.parse(candidateManifestResult.output)
      candidateVersion = manifest?.version
    } catch {
      throw new Error('dsh-updater: source candidate package manifest is invalid JSON')
    }
    if (typeof candidateVersion !== 'string' || !semver.valid(candidateVersion)) {
      throw new Error('dsh-updater: source candidate package manifest has no valid semantic version')
    }
    const candidateEligible = isReleaseEligible(candidateVersion, releaseEligibility)
    const currentRef = await execute('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: install.sourceRoot,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })
    const currentCommit = await execute('git', ['rev-parse', 'HEAD'], {
      cwd: install.sourceRoot,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })
    if (!/^[0-9a-f]{40}$/u.test(currentCommit.output)) {
      throw new Error(`dsh-updater: cannot resolve current source commit: ${currentCommit.output}`)
    }
    const dirty = status.output.length > 0
    const repairRequired = install.repairRequired === true || sourceRepairMarker.exists(install)
    const selectedBehind = candidateEligible ? behind : 0
    const selectedRef = candidateEligible ? latestRef.output : currentRef.output
    const selectedCommit = candidateEligible ? latestCommit.output : currentCommit.output
    const selectedVersion = candidateEligible ? candidateVersion : install.version
    const canAutoUpdate = ahead === 0 && !dirty && (candidateEligible || repairRequired)
    install = {
      ...install,
      releaseEligibility,
      dirty,
      ahead,
      behind: selectedBehind,
      runningRef: install.runningRef ?? currentRef.output,
      currentRef: currentRef.output,
      currentCommit: currentCommit.output,
      latestRef: selectedRef,
      latestCommit: selectedCommit,
      latestSourceVersion: selectedVersion,
      repairRequired,
      canAutoUpdate,
      actionLabel: !canAutoUpdate
        ? 'Resolve source changes'
        : repairRequired
          ? 'Retry install and build'
          : 'Apply verified commit and rebuild',
      commandPreview: !canAutoUpdate
        ? undefined
        : repairRequired
          ? 'pnpm install --frozen-lockfile && pnpm run build'
          : `git merge --ff-only ${latestCommit.output} && pnpm install --frozen-lockfile && pnpm run build`,
    }
    return {
      latestVersion: selectedVersion,
      latestTag: install.upstream,
      changelog: { source: 'github', text: null, url: GITHUB_RELEASES_URL },
      updateAvailable: (candidateEligible && behind > 0) || repairRequired,
      install: copyInstall(install),
    }
  }

  const performCheck = async () => {
    initialize()
    if (disposed) throw new Error('dsh-updater is disposed')
    operationAbort = new AbortController()
    publish({ status: 'checking', error: null })
    try {
      const result = install.kind === 'source'
        ? await checkSource(operationAbort.signal)
        : await latest(install.version, config.registryUrl, config.requestTimeoutMs, { releaseEligibility })
          .then(({ version, tag, integrity, tarball, changelog }) => {
            if (!isReleaseEligible(version, releaseEligibility)) {
              throw new Error(`dsh-updater: discovered ${version} is not eligible for ${RELEASE_ELIGIBILITY[releaseEligibility].label}`)
            }
            if (typeof integrity !== 'string' || typeof tarball !== 'string') {
              throw new Error('dsh-updater: release discovery did not return an immutable package artifact')
            }
            install = installForRelease({ ...install, releaseEligibility }, version, { integrity, tarball })
            return {
              latestVersion: version,
              latestTag: tag,
              changelog: changelog ?? null,
              updateAvailable: semver.gt(version, install.preparedVersion ?? install.version),
              install: copyInstall(install),
            }
          })
      const target = candidateTarget(install, result.latestVersion)
      const fingerprint = target === undefined ? null : targetFingerprint(install, target)
      const validationChanged = state.validation.fingerprint !== null && state.validation.fingerprint !== fingerprint
      if (validationChanged) discardCandidate()
      const staleTerminal = state.update.status === 'failed'
        || (state.update.status === 'succeeded' && result.updateAvailable)
      publish({
        status: 'ready',
        checkedAt: now(),
        error: null,
        ...(validationChanged ? { validation: initialValidation() } : {}),
        ...(staleTerminal ? { update: { status: 'idle', message: null, error: null, output: null } } : {}),
        ...result,
      })
      return snapshot()
    } catch (error) {
      if (!disposed) publish({ status: 'error', checkedAt: now(), error: errorMessage(error) })
      throw error
    } finally {
      operationAbort = undefined
    }
  }

  const ensureCheck = () => {
    if (checkPromise !== undefined) return checkPromise
    checkPromise = performCheck().finally(() => { checkPromise = undefined })
    return checkPromise
  }

  const check = () => {
    if (updatePromise !== undefined || validationPromise !== undefined) {
      const error = new Error('A DSH validation or update operation is already running.')
      error.code = 'BUSY'
      return Promise.reject(error)
    }
    return ensureCheck()
  }

  const performValidation = async () => {
    await ensureCheck()
    if (disposed) throw new Error('dsh-updater is disposed')
    if (!state.updateAvailable) return snapshot()
    if (install.kind !== 'source' && !isReleaseEligible(state.latestVersion, releaseEligibility)) {
      throw new Error(`dsh-updater: ${state.latestVersion} is no longer eligible for ${RELEASE_ELIGIBILITY[releaseEligibility].label}`)
    }
    if (install.kind === 'source' && install.repairRequired !== true && !isReleaseEligible(install.latestSourceVersion, releaseEligibility)) {
      throw new Error(`dsh-updater: source candidate ${install.latestSourceVersion ?? 'unknown'} is no longer eligible for ${RELEASE_ELIGIBILITY[releaseEligibility].label}`)
    }
    if (!install.canAutoUpdate) {
      const error = new Error(install.kind === 'source'
        ? 'Source update requires a clean checkout that is not ahead of its upstream.'
        : 'This installation method cannot be updated automatically.')
      error.code = 'NOT_UPDATABLE'
      throw error
    }
    const target = candidateTarget(install, state.latestVersion)
    if (typeof target !== 'string' || target.length === 0) throw new Error('dsh-updater: update candidate has no immutable target')
    const fingerprint = targetFingerprint(install, target)
    discardCandidate()
    operationAbort = new AbortController()
    publish({
      validation: {
        ...initialValidation(),
        status: 'running',
        target,
        fingerprint,
      },
      update: { status: 'idle', message: null, error: null, output: null },
    })
    try {
      const outcome = await candidateValidator({
        config,
        execute,
        install: { ...install },
        now,
        onProgress(progress) {
          if (disposed || operationAbort?.signal.aborted) return
          publish({
            validation: {
              ...state.validation,
              status: 'running',
              phase: progress.phase ?? state.validation.phase,
              message: progress.message ?? state.validation.message,
              candidatePath: progress.candidatePath ?? state.validation.candidatePath,
              checks: Array.isArray(progress.checks) ? progress.checks.map(check => ({ ...check })) : state.validation.checks,
            },
          })
        },
        runStartup,
        signal: operationAbort.signal,
        target,
      })
      candidateArtifact = typeof outcome?.artifactPath === 'string' ? outcome.artifactPath : undefined
      candidateDispose = typeof outcome?.dispose === 'function' ? outcome.dispose : undefined
      if (disposed) throw new Error('dsh-updater is disposed')
      const result = outcome?.result ?? outcome
      if (result?.status !== 'passed' && result?.status !== 'blocked') {
        throw new Error('dsh-updater: candidate validator returned an invalid status')
      }
      if (result.status === 'passed' && install.kind !== 'source' && candidateArtifact !== undefined) {
        const [step] = packageUpdatePlan(install, state.latestVersion, candidateArtifact)
        install = { ...install, commandPreview: [step.program, ...step.args].join(' ') }
      }
      const validation = {
        ...initialValidation(),
        ...result,
        target,
        fingerprint,
      }
      if (result.status === 'blocked') validation.repairPrompt = repairPrompt(validation, install)
      publish({
        ...(result.status === 'passed' ? { install: copyInstall(install) } : {}),
        validation,
      })
      return snapshot()
    } catch (error) {
      discardCandidate()
      const validation = {
        ...initialValidation(),
        status: 'blocked',
        target,
        fingerprint,
        checkedAt: now(),
        checks: [{ id: 'stage', label: 'Candidate install and build', status: 'failed', error: errorMessage(error) }],
        blockingIssues: [{ check: 'stage', message: errorMessage(error) }],
      }
      validation.repairPrompt = repairPrompt(validation, install)
      if (!disposed) publish({ validation })
      throw error
    } finally {
      operationAbort = undefined
    }
  }

  const validate = () => {
    if (updatePromise !== undefined) {
      const error = new Error('A DSH update is already running.')
      error.code = 'BUSY'
      return Promise.reject(error)
    }
    if (validationPromise !== undefined) return validationPromise
    validationPromise = performValidation().finally(() => { validationPromise = undefined })
    return validationPromise
  }

  const performUpdate = async () => {
    await ensureCheck()
    if (disposed) throw new Error('dsh-updater is disposed')
    if (!state.updateAvailable) return snapshot()
    if (install.kind !== 'source' && !isReleaseEligible(state.latestVersion, releaseEligibility)) {
      throw new Error(`dsh-updater: ${state.latestVersion} is no longer eligible for ${RELEASE_ELIGIBILITY[releaseEligibility].label}`)
    }
    if (install.kind === 'source' && install.repairRequired !== true && !isReleaseEligible(install.latestSourceVersion, releaseEligibility)) {
      throw new Error(`dsh-updater: source candidate ${install.latestSourceVersion ?? 'unknown'} is no longer eligible for ${RELEASE_ELIGIBILITY[releaseEligibility].label}`)
    }
    if (!install.canAutoUpdate) {
      const error = new Error(install.kind === 'source'
        ? 'Source update requires a clean checkout that is not ahead of its upstream.'
        : 'This installation method cannot be updated automatically.')
      error.code = 'NOT_UPDATABLE'
      throw error
    }
    const target = candidateTarget(install, state.latestVersion)
    const fingerprint = typeof target === 'string' ? targetFingerprint(install, target) : null
    if (state.validation.status !== 'passed' || state.validation.fingerprint !== fingerprint) {
      const error = new Error('Test this exact DSH candidate in TUI and Web modes before applying it.')
      error.code = 'NOT_VALIDATED'
      throw error
    }
    if (install.kind !== 'source' && candidateArtifact === undefined) {
      const error = new Error('The validated package artifact is no longer available; test the candidate again.')
      error.code = 'NOT_VALIDATED'
      throw error
    }
    if (install.kind !== 'source') {
      try {
        verifyCandidateArtifact(candidateArtifact, install.candidateIntegrity)
      } catch (cause) {
        discardCandidate()
        publish({ validation: initialValidation() })
        const error = new Error(`The validated package artifact changed before update: ${errorMessage(cause)}. Test the candidate again.`)
        error.code = 'NOT_VALIDATED'
        throw error
      }
    }
    if (install.kind === 'source') sourceRepairMarker.create(install)
    operationAbort = new AbortController()
    publish({
      update: {
        status: 'running',
        message: install.kind === 'npx' ? 'Preparing the latest npx package…' : 'Updating DSH…',
        error: null,
        output: null,
        startedAt: now(),
      },
    })
    const repairingSource = install.kind === 'source' && install.repairRequired === true
    const plan = install.kind === 'source'
      ? sourceUpdatePlan(install, target)
      : packageUpdatePlan(install, state.latestVersion, candidateArtifact)
    const outputs = []
    let completedSteps = 0
    let observedInstalledVersion
    try {
      for (const step of plan) {
        const result = await executeStep(step, operationAbort.signal)
        completedSteps += 1
        if (result.output) outputs.push(`$ ${step.program} ${step.args.join(' ')}\n${result.output}`)
      }
      if (install.kind === 'source') {
        const manifest = readJson(join(install.packageRoot, 'package.json'))
        const currentRef = await execute('git', ['rev-parse', '--short=12', 'HEAD'], {
          cwd: install.sourceRoot,
          timeoutMs: config.requestTimeoutMs,
          signal: operationAbort.signal,
        })
        const currentCommit = await execute('git', ['rev-parse', 'HEAD'], {
          cwd: install.sourceRoot,
          timeoutMs: config.requestTimeoutMs,
          signal: operationAbort.signal,
        })
        if (currentCommit.output !== target) {
          throw new Error(`dsh-updater: source update ended at ${currentCommit.output} instead of validated commit ${target}`)
        }
        const status = await execute('git', ['status', '--porcelain'], {
          cwd: install.sourceRoot,
          timeoutMs: config.requestTimeoutMs,
          signal: operationAbort.signal,
        })
        install = {
          ...install,
          ...(typeof manifest?.version === 'string' && semver.valid(manifest.version) ? { version: manifest.version } : {}),
          currentRef: currentRef.output,
          currentCommit: currentCommit.output,
          latestRef: currentRef.output,
          latestCommit: currentCommit.output,
          ahead: 0,
          behind: 0,
          dirty: status.output.length > 0,
          repairRequired: false,
          canAutoUpdate: status.output.length === 0,
          actionLabel: status.output.length === 0 ? 'Pull and rebuild' : 'Resolve source changes',
        }
        sourceRepairMarker.clear(install)
      } else if (install.kind === 'npx') {
        install = { ...install, preparedVersion: state.latestVersion }
      } else {
        observedInstalledVersion = resolveInstalledVersion()
        if (observedInstalledVersion !== state.latestVersion) {
          throw new Error(`dsh-updater: package manager completed, but ${observedInstalledVersion} is installed instead of ${state.latestVersion}`)
        }
        install = { ...install, version: observedInstalledVersion }
      }
      discardCandidate()
      publish({
        installedVersion: install.kind === 'npx' ? state.installedVersion : install.version,
        updateAvailable: false,
        install: copyInstall(install),
        validation: { ...state.validation, candidatePath: null },
        update: {
          status: 'succeeded',
          message: install.kind === 'npx'
            ? 'The latest release is prepared. Restart DSH with the exact npx command shown below.'
            : repairingSource
              ? 'The source checkout install and build completed. Restart DSH to use it.'
              : 'DSH was updated on disk successfully. Restart the running process to use the new version.',
          error: null,
          output: outputs.join('\n\n').slice(-32_000) || null,
          finishedAt: now(),
        },
      })
      return snapshot()
    } catch (error) {
      const repairRequired = install.kind === 'source'
        && (install.repairRequired === true || completedSteps > 0 || sourceRepairMarker.exists(install))
      let diskPatch = {}
      let diskObserved = false
      if (repairRequired) {
        let disk
        try {
          disk = inspectSource(install)
        } catch {
          // The original update error remains authoritative when post-failure inspection also fails.
        }
        install = {
          ...install,
          ...(disk?.version !== undefined ? { version: disk.version } : {}),
          ...(disk?.currentRef !== undefined ? { currentRef: disk.currentRef } : {}),
          ...(disk?.currentCommit !== undefined ? { currentCommit: disk.currentCommit } : {}),
          ...(disk?.dirty !== undefined ? { dirty: disk.dirty } : {}),
          repairRequired: true,
          canAutoUpdate: disk?.dirty === false,
          actionLabel: disk?.dirty === false ? 'Retry install and build' : 'Resolve source changes',
        }
        diskObserved = true
        diskPatch = { installedVersion: install.version, updateAvailable: true }
      } else if (install.kind !== 'npx' && install.kind !== 'source') {
        try {
          observedInstalledVersion ??= resolveInstalledVersion()
          if (semver.valid(observedInstalledVersion)) {
            install = { ...install, version: observedInstalledVersion }
            diskObserved = true
            diskPatch = {
              installedVersion: observedInstalledVersion,
              updateAvailable: semver.lt(observedInstalledVersion, state.latestVersion),
            }
          }
        } catch {
          // Preserve the operation failure when the follow-up manifest read also fails.
        }
      }
      if (!disposed) publish({
        ...diskPatch,
        ...(diskObserved ? { install: copyInstall(install) } : {}),
        update: {
          status: 'failed',
          message: repairRequired
            ? 'The checkout advanced, but install or build did not complete. Retry to repair it.'
            : 'The update did not complete.',
          error: errorMessage(error),
          output: outputs.join('\n\n').slice(-32_000) || null,
          finishedAt: now(),
        },
      })
      throw error
    } finally {
      operationAbort = undefined
    }
  }

  const update = () => {
    if (validationPromise !== undefined) {
      const error = new Error('Candidate validation is already running.')
      error.code = 'BUSY'
      return Promise.reject(error)
    }
    if (updatePromise !== undefined) return updatePromise
    updatePromise = performUpdate().finally(() => { updatePromise = undefined })
    return updatePromise
  }

  const setReleaseEligibility = async (value) => {
    if (checkPromise !== undefined || validationPromise !== undefined || updatePromise !== undefined) {
      const error = new Error('Wait for the current DSH updater operation to finish before changing release eligibility.')
      error.code = 'BUSY'
      throw error
    }
    const normalized = normalizeReleaseEligibility(value)
    if (normalized !== value) {
      const error = new Error('Unknown DSH release eligibility setting.')
      error.code = 'INVALID_ELIGIBILITY'
      throw error
    }
    if (normalized === releaseEligibility) return snapshot()
    eligibilityStore.write(normalized)
    releaseEligibility = normalized
    discardCandidate()
    publish({
      releaseEligibility,
      validation: initialValidation(),
      update: { status: 'idle', message: null, error: null, output: null },
    })
    return check()
  }

  const snapshot = () => ({
    ...state,
    install: state.install === null ? null : { ...state.install },
    validation: {
      ...state.validation,
      checks: state.validation.checks.map(check => ({ ...check })),
      blockingIssues: state.validation.blockingIssues.map(issue => ({ ...issue })),
    },
    update: { ...state.update },
  })

  const dispose = async () => {
    disposed = true
    operationAbort?.abort()
    const operations = [checkPromise, validationPromise, updatePromise].filter(Boolean)
    if (operations.length > 0) await Promise.allSettled(operations)
    discardCandidate()
  }

  return { check, config, dispose, initialize, setReleaseEligibility, snapshot, update, validate, logger }
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isTrustedUpdaterOrigin(origin) {
  const configured = process.env.DSH_UPDATER_TRUSTED_ORIGINS ?? ''
  return configured.split(',').some((value) => {
    const candidate = value.trim()
    if (candidate.length === 0) return false
    try {
      const parsed = new URL(candidate)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin
    } catch {
      return false
    }
  })
}

function isSameOriginMutation(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  const loopbackHost = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin)
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host !== host) return false
      return loopbackHost || isTrustedUpdaterOrigin(parsed.origin)
    } catch {
      return false
    }
  }
  return loopbackHost && req.headers['sec-fetch-site'] === 'same-origin'
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

function registerUpdaterRoutes(webServer, controller) {
  const route = (path, method, handler) => webServer.register({
    kind: 'exact',
    path,
    async handler(req, res) {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'DSH updates are available only over a loopback connection.' })
        return
      }
      if (req.method !== method) {
        res.setHeader('allow', method)
        sendJson(res, 405, { error: 'Method not allowed.' })
        return
      }
      if (method !== 'GET' && !isSameOriginMutation(req)) {
        sendJson(res, 403, { error: 'DSH update actions require a same-origin browser request.' })
        return
      }
      try {
        sendJson(res, 200, await handler())
      } catch (error) {
        const statusCode = ['BUSY', 'NOT_UPDATABLE', 'NOT_VALIDATED'].includes(error?.code)
          ? 409
          : error?.code === 'INVALID_ELIGIBILITY'
            ? 400
            : 500
        sendJson(res, statusCode, { error: errorMessage(error), status: controller.snapshot() })
      }
    },
  })
  const disposers = [
    route(STATUS_ROUTE, 'GET', () => controller.snapshot()),
    route(CHECK_ROUTE, 'POST', () => controller.check()),
    route(VALIDATE_ROUTE, 'POST', () => controller.validate()),
    route(UPDATE_ROUTE, 'POST', () => controller.update()),
    ...Object.keys(RELEASE_ELIGIBILITY).map(value => route(`${ELIGIBILITY_ROUTE_PREFIX}${value}`, 'POST', () => controller.setReleaseEligibility(value))),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function apply(ctx, config = {}) {
  const controller = createUpdaterController({ config, logger: ctx.logger })
  controller.initialize()
  ctx.effect(() => () => controller.dispose(), 'dsh-updater: controller')
  ctx.effect(() => registerUpdaterRoutes(ctx.webServer, controller), 'dsh-updater: web routes')
  void controller.check().catch(error => ctx.logger.warn(`update check failed: ${errorMessage(error)}`))
  ctx.interval(() => {
    void controller.check().catch(error => ctx.logger.warn(`periodic update check failed: ${errorMessage(error)}`))
  }, controller.config.checkIntervalMinutes * 60_000)
}

export {
  CHECK_ROUTE,
  Config,
  DEFAULT_RELEASE_ELIGIBILITY,
  ELIGIBILITY_ROUTE_PREFIX,
  PACKAGE_NAME,
  RELEASE_ELIGIBILITY,
  STATUS_ROUTE,
  UPDATE_ROUTE,
  VALIDATE_ROUTE,
  apply,
  classifyPackageInstall,
  createUpdaterController,
  createReleaseEligibilityStore,
  detectInstallation,
  fetchLatestVersion,
  findSourceRoot,
  inject,
  isReleaseEligible,
  isSameOriginMutation,
  name,
  registerUpdaterRoutes,
  resolveDshPackageRoot,
  selectLatestEligibleVersion,
  runCommand,
  scrubEnvironment,
}
