import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { dirname, join, parse, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import z from '@deepseek-ai/schemastery'
import semver from 'semver'

const name = 'dsh-updater'
const inject = ['timer']
const PACKAGE_NAME = '@deepseek-ai/dsh'
const STATUS_ROUTE = '/dsh-updater/status'
const CHECK_ROUTE = '/dsh-updater/check'
const UPDATE_ROUTE = '/dsh-updater/update'
const MAX_OUTPUT_BYTES = 256 * 1024

const Config = z.object({
  checkIntervalMinutes: z.number().step(1).min(5).max(7 * 24 * 60).default(360),
  registryUrl: z.string().default('https://registry.npmjs.org/'),
  requestTimeoutMs: z.number().step(1).min(1000).max(120000).default(15000),
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
        'user-agent': `${name}/0.1.0`,
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

async function fetchLatestVersion(currentVersion, registryUrl, timeoutMs) {
  const metadata = await fetchRegistryMetadata(registryUrl, timeoutMs)
  const tag = semver.prerelease(currentVersion) === null ? 'latest' : 'next'
  const version = metadata?.['dist-tags']?.[tag]
  if (typeof version !== 'string' || !semver.valid(version)) {
    throw new Error(`dsh-updater: registry has no valid ${tag} dist-tag for ${PACKAGE_NAME}`)
  }
  return { version, tag }
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
  const { template: _template, ...publicFields } = install
  return { ...publicFields }
}

function initialState() {
  return {
    status: 'starting',
    currentVersion: null,
    installedVersion: null,
    latestVersion: null,
    latestTag: null,
    updateAvailable: false,
    checkedAt: null,
    error: null,
    install: null,
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

function sourceUpdatePlan(install) {
  const build = [
    { program: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: install.sourceRoot },
    { program: 'pnpm', args: ['run', 'build'], cwd: install.sourceRoot },
  ]
  return install.repairRequired === true && install.behind === 0
    ? build
    : [{ program: 'git', args: ['pull', '--ff-only', install.remote, install.remoteBranch], cwd: install.sourceRoot }, ...build]
}

function inspectSourceDisk(install) {
  const manifest = readJson(join(install.packageRoot, 'package.json'))
  return {
    version: typeof manifest?.version === 'string' && semver.valid(manifest.version) ? manifest.version : install.version,
    currentRef: syncCommand('git', ['rev-parse', '--short=12', 'HEAD'], install.sourceRoot),
    dirty: (syncCommand('git', ['status', '--porcelain'], install.sourceRoot) ?? '').length > 0,
  }
}

function packageUpdatePlan(install, version) {
  const target = `${PACKAGE_NAME}@${version}`
  return [{
    program: install.template.program,
    args: install.template.args.map(value => value.replace('{target}', target)),
    cwd: install.template.cwd,
  }]
}

function installForRelease(install, version) {
  if (install.template === undefined) return install
  const [step] = packageUpdatePlan(install, version)
  return {
    ...install,
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
    updateTimeoutMinutes: options.config?.updateTimeoutMinutes ?? 20,
  }
  const locate = options.locate ?? (() => detectInstallation())
  const latest = options.fetchLatest ?? fetchLatestVersion
  const execute = options.runCommand ?? runCommand
  const resolveInstalledVersion = options.resolveInstalledVersion ?? (() => resolveDshPackageRoot().version)
  const inspectSource = options.inspectSourceDisk ?? inspectSourceDisk
  const sourceRepairMarker = options.sourceRepairMarker ?? defaultSourceRepairMarker
  const now = options.now ?? (() => new Date().toISOString())
  const logger = options.logger ?? console
  let state = initialState()
  let install
  let checkPromise
  let updatePromise
  let operationAbort
  let disposed = false

  const publish = (patch) => {
    state = { ...state, ...patch }
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
    const currentRef = await execute('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: install.sourceRoot,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })
    const dirty = status.output.length > 0
    const repairRequired = install.repairRequired === true || sourceRepairMarker.exists(install)
    const canAutoUpdate = ahead === 0 && (repairRequired || !dirty)
    install = {
      ...install,
      dirty,
      ahead,
      behind,
      runningRef: install.runningRef ?? currentRef.output,
      currentRef: currentRef.output,
      latestRef: latestRef.output,
      repairRequired,
      canAutoUpdate,
      actionLabel: repairRequired
        ? 'Retry install and build'
        : canAutoUpdate
          ? 'Pull and rebuild'
          : 'Resolve source changes',
    }
    return {
      latestVersion: install.version,
      latestTag: install.upstream,
      updateAvailable: behind > 0 || repairRequired,
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
        : await latest(install.version, config.registryUrl, config.requestTimeoutMs)
          .then(({ version, tag }) => {
            install = installForRelease(install, version)
            return {
              latestVersion: version,
              latestTag: tag,
              updateAvailable: semver.gt(version, install.preparedVersion ?? install.version),
              install: copyInstall(install),
            }
          })
      const staleTerminal = state.update.status === 'failed'
        || (state.update.status === 'succeeded' && result.updateAvailable)
      publish({
        status: 'ready',
        checkedAt: now(),
        error: null,
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

  const check = () => updatePromise ?? ensureCheck()

  const performUpdate = async () => {
    await ensureCheck()
    if (disposed) throw new Error('dsh-updater is disposed')
    if (!state.updateAvailable) return snapshot()
    if (!install.canAutoUpdate) {
      const error = new Error(install.kind === 'source'
        ? 'Source update requires a clean checkout that is not ahead of its upstream.'
        : 'This installation method cannot be updated automatically.')
      error.code = 'NOT_UPDATABLE'
      throw error
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
      ? sourceUpdatePlan(install)
      : packageUpdatePlan(install, state.latestVersion)
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
        const status = await execute('git', ['status', '--porcelain'], {
          cwd: install.sourceRoot,
          timeoutMs: config.requestTimeoutMs,
          signal: operationAbort.signal,
        })
        install = {
          ...install,
          ...(typeof manifest?.version === 'string' && semver.valid(manifest.version) ? { version: manifest.version } : {}),
          currentRef: currentRef.output,
          latestRef: currentRef.output,
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
      publish({
        installedVersion: install.kind === 'npx' ? state.installedVersion : install.version,
        updateAvailable: false,
        install: copyInstall(install),
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
          ...(disk?.dirty !== undefined ? { dirty: disk.dirty } : {}),
          repairRequired: true,
          canAutoUpdate: true,
          actionLabel: 'Retry install and build',
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
    if (updatePromise !== undefined) return updatePromise
    updatePromise = performUpdate().finally(() => { updatePromise = undefined })
    return updatePromise
  }

  const snapshot = () => ({
    ...state,
    install: state.install === null ? null : { ...state.install },
    update: { ...state.update },
  })

  const dispose = async () => {
    disposed = true
    operationAbort?.abort()
    const operations = [checkPromise, updatePromise].filter(Boolean)
    if (operations.length > 0) await Promise.allSettled(operations)
  }

  return { check, config, dispose, initialize, snapshot, update, logger }
}
