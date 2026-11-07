import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestOk } from './candidate.js'
import { findBrowserExecutable, formatBootFailure, probeWebBoot } from './browser.js'

const RESCUE_PROFILE = 'rescue'
const RESCUE_TEMPLATE = 'web'
const REPORT_FILENAME = 'dsh-updater-restart.json'
const WEB_READY = /dsh web: (http:\/\/[^\s]+)/u
const MAX_REPORT_TEXT = 16_000
const HELPER_PATH = fileURLToPath(new URL('./restart-helper.js', import.meta.url))
const UPDATER_ROOT = fileURLToPath(new URL('..', import.meta.url))

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function dshHome(environment = process.env) {
  return environment.DSH_HOME || join(homedir(), '.dsh')
}

function reportPath(home = dshHome()) {
  return join(home, REPORT_FILENAME)
}

function bounded(value) {
  const text = String(value ?? '').replace(/([?&]token=)[^&\s]+/gu, '$1***')
  return text.length <= MAX_REPORT_TEXT ? text : `…${text.slice(-MAX_REPORT_TEXT)}`
}

/**
 * True only when `entry` is the CLI of an `@deepseek-ai/dsh` package, so a
 * restart can never relaunch an arbitrary script (for example a test runner).
 */
function isDshEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0) return false
  let directory
  try {
    directory = dirname(realpathSync(entry))
  } catch {
    return false
  }
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (manifest?.name === '@deepseek-ai/dsh') return true
    } catch {}
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

function readRestartReport(file = reportPath()) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function writeRestartReport(file, report) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
  return report
}

function clearRestartReport(file = reportPath()) {
  try {
    unlinkSync(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * Split a `dsh` invocation into its profile, launcher-only flags, and the
 * booted app's own arguments (`dsh web --port 1` ≡ `dsh --profile web --port 1`).
 */
function splitLauncherArgs(args) {
  let profile
  const launcherArgs = []
  const appArgs = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--profile' && profile === undefined) {
      profile = args[index + 1]
      index += 1
    } else if (value.startsWith('--profile=') && profile === undefined) {
      profile = value.slice('--profile='.length)
    } else if ((value === '--patch' || value === '--from-default-profile') && index + 1 < args.length) {
      launcherArgs.push(value, args[index + 1])
      index += 1
    } else if (value.startsWith('--patch=') || value.startsWith('--from-default-profile=')) {
      launcherArgs.push(value)
    } else if (profile === undefined && appArgs.length === 0 && !value.startsWith('-')) {
      profile = value
    } else {
      appArgs.push(value)
    }
  }
  return { profile, launcherArgs, appArgs }
}

function withNoOpen(appArgs) {
  return appArgs.includes('--no-open') ? [...appArgs] : [...appArgs, '--no-open']
}

function openBrowser(url) {
  const [program, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(program, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The verified server keeps running; its URL is in the restart log.
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function waitForExit(pid, timeoutMs, alive = processAlive) {
  const deadline = Date.now() + timeoutMs
  while (alive(pid)) {
    if (Date.now() >= deadline) return false
    await sleep(200)
  }
  return true
}

function readFrom(file, offset) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = statSync(file).size
    if (size <= offset) return ''
    const buffer = Buffer.alloc(Math.min(size - offset, 1024 * 1024))
    const read = readSync(fd, buffer, 0, buffer.length, offset)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function stopTree(pid, signal) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch {}
  }
}

/**
 * Start one detached `dsh` server whose output goes to `logFile`, wait for its
 * Web URL, then confirm the authenticated root and (when a browser exists) a
 * full plugin boot. A server that fails verification is stopped.
 */
async function launchAndVerify(job, args, logFile, deps) {
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 })
  const offset = existsSync(logFile) ? statSync(logFile).size : 0
  const fd = openSync(logFile, 'a', 0o600)
  const child = deps.spawn(job.execPath, [job.entry, ...args], {
    cwd: job.cwd,
    env: job.env ?? process.env,
    stdio: ['ignore', fd, fd],
    detached: true,
    windowsHide: true,
  })
  closeSync(fd)
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  child.on('error', (error) => { exited = { error } })
  const deadline = Date.now() + job.startupTimeoutMs
  let url
  let output = ''
  while (url === undefined) {
    output = readFrom(logFile, offset)
    url = output.match(WEB_READY)?.[1]
    if (url !== undefined) break
    if (exited !== null) {
      return { ok: false, pid: child.pid, error: `dsh exited before it was ready${exited.error ? `: ${errorMessage(exited.error)}` : ` with code ${String(exited.code)}`}\n${bounded(output)}` }
    }
    if (Date.now() >= deadline) {
      stopTree(child.pid, 'SIGKILL')
      return { ok: false, pid: child.pid, error: `dsh did not print its Web URL within ${job.startupTimeoutMs} ms\n${bounded(output)}` }
    }
    await sleep(250)
  }
  try {
    await deps.requestOk(url, 10_000)
    if (job.browserExecutable) {
      const boot = await deps.probeWebBoot(url, { executable: job.browserExecutable, timeoutMs: job.browserTimeoutMs })
      if (boot.status !== 'passed') throw new Error(formatBootFailure(boot))
    }
  } catch (error) {
    stopTree(child.pid, 'SIGTERM')
    await waitForExit(child.pid, 6000, deps.processAlive)
    if (deps.processAlive(child.pid)) stopTree(child.pid, 'SIGKILL')
    return { ok: false, pid: child.pid, error: bounded(`${errorMessage(error)}\n\nServer output:\n${readFrom(logFile, offset)}`) }
  }
  child.unref()
  return { ok: true, pid: child.pid, url, output: bounded(output) }
}

function prepareRescueProfile(job, deps) {
  const env = job.env ?? process.env
  const run = (args) => {
    const result = deps.spawnSync(job.execPath, [job.entry, ...args], { cwd: job.cwd, env, encoding: 'utf8', timeout: 180_000, windowsHide: true })
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`dsh ${args.join(' ')} failed: ${errorMessage(result.error ?? result.stderr ?? result.stdout)}`)
    }
  }
  // Recreate the rescue profile from the shipped Web template (base + web app only).
  run(['--profile', RESCUE_PROFILE, '--from-default-profile', RESCUE_TEMPLATE, '--dump-config'])
  // Add only this updater so the rescue session can show the recovery handoff and restart back.
  if (job.updaterRoot && existsSync(join(job.updaterRoot, 'package.json'))) {
    run(['plugin', '--profile', RESCUE_PROFILE, 'add', `link:${job.updaterRoot}`])
  }
}

function recoveryPrompt(report) {
  return [
    `DSH ${report.expectedVersion ?? report.runningVersion ?? ''} is installed, but the "${report.profile}" profile did not boot after the update, so DSH started the minimal "${RESCUE_PROFILE}" profile instead (only the DSH base, the Web app, and dsh-updater).`,
    '',
    'Repair the original profile so it boots cleanly on this DSH version:',
    `1. Reproduce the failure from the diagnostics below and inspect ${report.profileDir ?? `~/.dsh/profiles/${report.profile}`} (package.json bundles, cordis.patch.yml, pnpm patches, compatibility.json) and the plugins it loads.`,
    '2. Prefer the narrowest durable fix: update the failing plugin, widen the declared DSH version range of plugins under local control, regenerate pnpm patches that no longer apply, or approve an exact version with `dsh plugin --profile <name> allow-version <package@version> --dsh-version <version> --accept-risk`. Disable a plugin in cordis.patch.yml only as a last resort and say so.',
    `3. Verify with \`dsh --profile ${report.profile} --port 0 --no-open\` that the Web UI boots without "Failed to load plugins".`,
    `4. Use Settings → DSH Updater → "Restart into ${report.profile}" (or restart \`dsh ${report.profile}\` yourself). The updater verifies the boot again and falls back to ${RESCUE_PROFILE} if it still fails.`,
    '',
    '--- BEGIN UNTRUSTED BOOT DIAGNOSTICS ---',
    String(report.error ?? '').slice(0, 8000),
    '--- END UNTRUSTED BOOT DIAGNOSTICS ---',
  ].join('\n')
}

/**
 * Restart DSH after its parent process exits: relaunch the original command,
 * verify it, and fall back to a minimal rescue profile when it does not boot.
 * Progress and the outcome are recorded in `$DSH_HOME/dsh-updater-restart.json`.
 */
async function runRestartJob(job, overrides = {}) {
  if (!(overrides.isDshEntry ?? isDshEntry)(job.entry)) {
    throw new Error(`refusing to restart ${job.entry}: it is not the @deepseek-ai/dsh CLI`)
  }
  const deps = {
    spawn,
    spawnSync,
    requestOk,
    probeWebBoot,
    processAlive,
    openBrowser,
    now: () => new Date().toISOString(),
    ...overrides,
  }
  const file = job.reportPath
  const split = splitLauncherArgs(job.args)
  const profile = split.profile ?? 'web'
  const base = {
    id: job.id,
    reason: job.reason,
    profile,
    profileDir: job.profileDir,
    originalArgs: job.args,
    fromVersion: job.fromVersion ?? null,
    expectedVersion: job.expectedVersion ?? null,
    requestedAt: job.requestedAt,
    logPath: job.logFile,
  }
  const record = patch => writeRestartReport(file, { ...base, ...patch, updatedAt: deps.now() })
  record({ status: 'restarting', message: 'Waiting for the running DSH process to shut down…' })

  if (!await waitForExit(job.parentPid, job.shutdownTimeoutMs ?? 20_000, deps.processAlive)) {
    stopTree(job.parentPid, 'SIGKILL')
    await waitForExit(job.parentPid, 5000, deps.processAlive)
  }

  record({ status: 'restarting', message: `Starting DSH with the "${profile}" profile and checking that it boots…` })
  const primaryArgs = [...(split.profile === undefined ? [] : ['--profile', profile]), ...split.launcherArgs, ...withNoOpen(split.appArgs)]
  const primary = await launchAndVerify(job, primaryArgs, job.logFile, deps)
  const runningVersion = (() => {
    const result = deps.spawnSync(job.execPath, [job.entry, '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, env: job.env ?? process.env })
    return result.status === 0 ? String(result.stdout).trim() : null
  })()
  if (primary.ok) {
    if (!split.appArgs.includes('--no-open')) deps.openBrowser(primary.url)
    return record({
      status: 'succeeded',
      pid: primary.pid,
      runningVersion,
      verifiedBrowser: Boolean(job.browserExecutable),
      message: `DSH${runningVersion ? ` ${runningVersion}` : ''} restarted with the "${profile}" profile and its Web UI booted${job.browserExecutable ? ' in a headless browser check' : ''}.`,
      finishedAt: deps.now(),
    })
  }

  if (job.fallbackToRescue === false || profile === RESCUE_PROFILE) {
    return record({ status: 'failed', runningVersion, error: primary.error, message: `DSH did not boot with the "${profile}" profile.`, finishedAt: deps.now() })
  }

  record({ status: 'restarting', runningVersion, error: primary.error, message: `The "${profile}" profile did not boot; starting the minimal ${RESCUE_PROFILE} profile…` })
  let rescue
  try {
    prepareRescueProfile(job, deps)
    rescue = await launchAndVerify(job, ['--profile', RESCUE_PROFILE, ...withNoOpen(split.appArgs)], job.logFile, deps)
  } catch (error) {
    rescue = { ok: false, error: errorMessage(error) }
  }
  if (!rescue.ok) {
    return record({
      status: 'failed',
      runningVersion,
      error: primary.error,
      rescueError: rescue.error,
      message: `DSH did not boot with the "${profile}" profile or the ${RESCUE_PROFILE} profile. Start it manually with \`dsh ${profile}\` and check ${job.logFile}.`,
      finishedAt: deps.now(),
    })
  }
  if (!split.appArgs.includes('--no-open')) deps.openBrowser(rescue.url)
  const report = {
    status: 'rescue',
    pid: rescue.pid,
    runningVersion,
    rescueProfile: RESCUE_PROFILE,
    error: primary.error,
    message: `The "${profile}" profile did not boot on DSH ${runningVersion ?? 'after the update'}. DSH is running the minimal ${RESCUE_PROFILE} profile so you can repair it from here.`,
    finishedAt: deps.now(),
  }
  return record({ ...report, recoveryPrompt: recoveryPrompt({ ...base, ...report }) })
}

/**
 * Hand the restart to a detached helper, then ask this process to shut down.
 * @returns the job that was written for the helper.
 */
function scheduleRestart(options) {
  const home = options.home ?? dshHome()
  const id = `${Date.now().toString(36)}-${process.pid}`
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const job = {
    id,
    reason: options.reason ?? 'manual',
    parentPid: options.parentPid ?? process.pid,
    execPath: options.execPath ?? process.execPath,
    entry: options.entry ?? process.argv[1],
    args: options.args ?? process.argv.slice(2),
    cwd: options.cwd ?? process.cwd(),
    profileDir: options.profileDir,
    fromVersion: options.fromVersion,
    expectedVersion: options.expectedVersion,
    updaterRoot: options.updaterRoot ?? UPDATER_ROOT,
    reportPath: reportPath(home),
    logFile: join(home, 'logs', `dsh-updater-restart-${stamp}.log`),
    startupTimeoutMs: options.startupTimeoutMs ?? 90_000,
    browserExecutable: options.browserProbe === false ? undefined : options.browserExecutable ?? findBrowserExecutable(),
    browserTimeoutMs: options.browserTimeoutMs ?? 45_000,
    fallbackToRescue: options.fallbackToRescue !== false,
    requestedAt: new Date().toISOString(),
  }
  if (!(options.isDshEntry ?? isDshEntry)(job.entry)) {
    throw new Error(`cannot restart: ${job.entry} is not the @deepseek-ai/dsh CLI`)
  }
  const jobFile = join(home, `dsh-updater-restart-job-${id}.json`)
  mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 })
  writeFileSync(jobFile, JSON.stringify(job), { encoding: 'utf8', mode: 0o600 })
  writeRestartReport(job.reportPath, {
    id,
    reason: job.reason,
    status: 'scheduled',
    profile: splitLauncherArgs(job.args).profile ?? 'web',
    originalArgs: job.args,
    fromVersion: job.fromVersion ?? null,
    expectedVersion: job.expectedVersion ?? null,
    requestedAt: job.requestedAt,
    logPath: job.logFile,
    message: 'DSH is restarting. A browser tab opens when the new server has passed its boot check.',
    updatedAt: job.requestedAt,
  })
  const log = openSync(job.logFile, 'a', 0o600)
  const helper = (options.spawn ?? spawn)(job.execPath, [HELPER_PATH, jobFile], {
    cwd: job.cwd,
    env: process.env,
    stdio: ['ignore', log, log],
    detached: true,
    windowsHide: true,
  })
  closeSync(log)
  helper.unref?.()
  const exit = options.exitProcess ?? (() => process.kill(process.pid, 'SIGTERM'))
  const timer = setTimeout(exit, options.exitDelayMs ?? 750)
  timer.unref?.()
  return job
}

export {
  HELPER_PATH,
  RESCUE_PROFILE,
  clearRestartReport,
  isDshEntry,
  readRestartReport,
  recoveryPrompt,
  reportPath,
  runRestartJob,
  scheduleRestart,
  splitLauncherArgs,
  writeRestartReport,
}
