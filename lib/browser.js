import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const DEVTOOLS_READY = /DevTools listening on (ws:\/\/\S+)/u
const MAX_DIAGNOSTICS = 20
const MAX_DIAGNOSTIC_CHARS = 2000

// Runs inside the page. DSH renders `[data-dsh-boot]` while plugins load and
// swaps its card for "Failed to load plugins" when any entry does not
// activate; a successful boot mounts the app under `#root` and drops the card.
const BOOT_STATE_EXPRESSION = `(() => {
  const boot = document.querySelector('[data-dsh-boot]')
  const text = boot ? String(boot.innerText || boot.textContent || '') : ''
  if (/Failed to load plugins/.test(text)) return { state: 'failed', text }
  const root = document.getElementById('root')
  if (root && root.querySelector(':scope > [data-slot="root"]')) return { state: 'ready' }
  return { state: boot ? 'booting' : 'loading', text, mounted: !!(root && root.childElementCount > 0) }
})()`

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function newestBrowserBuild(root, prefixes, relativePaths) {
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return undefined
  }
  for (const prefix of prefixes) {
    const builds = entries
      .filter(entry => entry.startsWith(`${prefix}-`))
      .sort((left, right) => Number(right.slice(prefix.length + 1)) - Number(left.slice(prefix.length + 1)))
    for (const build of builds) {
      for (const path of relativePaths) {
        const candidate = join(root, build, ...path)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

function browserCandidates(platform = process.platform, environment = process.env) {
  const home = environment.HOME || homedir()
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      newestBrowserBuild(join(home, 'Library', 'Caches', 'ms-playwright'), ['chromium_headless_shell', 'chromium'], [
        ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
        ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
        ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
        ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
      ]),
    ]
  }
  if (platform === 'win32') {
    const programFiles = [environment.PROGRAMFILES, environment['PROGRAMFILES(X86)'], environment.LOCALAPPDATA].filter(Boolean)
    return [
      ...programFiles.map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...programFiles.map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      environment.LOCALAPPDATA === undefined ? undefined : newestBrowserBuild(join(environment.LOCALAPPDATA, 'ms-playwright'), ['chromium_headless_shell', 'chromium'], [
        ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
        ['chrome-win', 'chrome.exe'],
      ]),
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
    newestBrowserBuild(join(home, '.cache', 'ms-playwright'), ['chromium_headless_shell', 'chromium'], [
      ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
      ['chrome-linux', 'chrome'],
    ]),
  ]
}

/**
 * Locate a Chromium-family browser for the headless boot probe: the configured
 * path, then `DSH_UPDATER_BROWSER`, then well-known installs and Playwright's cache.
 * @returns the executable path, or undefined when none is installed.
 */
function findBrowserExecutable(configured, options = {}) {
  const environment = options.environment ?? process.env
  const exists = options.exists ?? existsSync
  for (const candidate of [configured, environment.DSH_UPDATER_BROWSER, ...browserCandidates(options.platform, environment)]) {
    if (typeof candidate === 'string' && candidate.length > 0 && exists(candidate)) return candidate
  }
  return undefined
}

function stopProcessTree(child, signal) {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch {}
  }
}

function launchBrowser(executable, timeoutMs, signal) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-updater-browser-'))
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32',
  })
  const close = () => {
    stopProcessTree(child, 'SIGTERM')
    const killer = setTimeout(() => stopProcessTree(child, 'SIGKILL'), 2000)
    killer.unref?.()
    child.once('close', () => {
      clearTimeout(killer)
      rmSync(userDataDir, { recursive: true, force: true })
    })
    if (child.exitCode !== null) rmSync(userDataDir, { recursive: true, force: true })
  }
  return new Promise((resolvePromise, reject) => {
    let stderr = ''
    const fail = (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      close()
      reject(error)
    }
    const abort = () => fail(new Error('browser boot probe was cancelled'))
    const timer = setTimeout(() => fail(new Error(`browser did not expose DevTools within ${timeoutMs} ms${stderr.trim() ? `\n${stderr.trim().slice(-MAX_DIAGNOSTIC_CHARS)}` : ''}`)), timeoutMs)
    timer.unref?.()
    child.on('error', error => fail(error))
    child.on('close', (code) => fail(new Error(`browser exited with code ${String(code)} before DevTools was available${stderr.trim() ? `\n${stderr.trim().slice(-MAX_DIAGNOSTIC_CHARS)}` : ''}`)))
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024)
      const match = stderr.match(DEVTOOLS_READY)
      if (match === null) return
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      child.removeAllListeners('close')
      child.stderr.removeAllListeners('data')
      child.stderr.resume()
      resolvePromise({ webSocketUrl: match[1], close })
    })
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

async function connectDevTools(webSocketUrl, WebSocketImpl = globalThis.WebSocket) {
  if (typeof WebSocketImpl !== 'function') throw new Error('this Node.js runtime has no WebSocket client; Node.js 22 or newer is required for the browser boot probe')
  const socket = new WebSocketImpl(webSocketUrl)
  let sequence = 0
  const pending = new Map()
  const listeners = new Set()
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', () => resolvePromise(), { once: true })
    socket.addEventListener('error', () => reject(new Error('cannot connect to the browser DevTools endpoint')), { once: true })
  })
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolvePromise, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(`${message.error.message ?? 'DevTools error'}${message.error.data ? `: ${message.error.data}` : ''}`))
      else resolvePromise(message.result ?? {})
      return
    }
    for (const listener of listeners) listener(message)
  })
  socket.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('browser DevTools connection closed'))
    pending.clear()
  })
  return {
    send(method, params = {}, sessionId) {
      const id = ++sequence
      return new Promise((resolvePromise, reject) => {
        pending.set(id, { resolvePromise, reject })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
      })
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      try { socket.close() } catch {}
    },
  }
}

function describeConsoleEvent(message) {
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params?.exceptionDetails
    return `uncaught: ${details?.exception?.description ?? details?.text ?? 'exception'}`
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    const text = (message.params.args ?? [])
      .map(arg => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
      .filter(value => value !== '')
      .join(' ')
    return `console.error: ${text}`
  }
  return undefined
}

function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolvePromise()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('browser boot probe was cancelled'))
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Drive a DevTools session through the Web token URL and wait until DSH either
 * mounts its application or renders the "Failed to load plugins" boot card.
 * @param devtools - connected DevTools client (see connectDevTools).
 * @returns `{ status: 'passed' }` or `{ status: 'failed', message, diagnostics }`.
 */
async function observeWebBoot(devtools, url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45_000
  const pollMs = options.pollMs ?? 250
  const now = options.now ?? Date.now
  const diagnostics = []
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true })
  const stopListening = devtools.onEvent((message) => {
    if (message.sessionId !== sessionId || diagnostics.length >= MAX_DIAGNOSTICS) return
    const text = describeConsoleEvent(message)
    if (text !== undefined) diagnostics.push(text.slice(0, MAX_DIAGNOSTIC_CHARS))
  })
  try {
    await devtools.send('Runtime.enable', {}, sessionId)
    await devtools.send('Page.navigate', { url }, sessionId)
    const deadline = now() + timeoutMs
    let seenBoot = false
    let last
    for (;;) {
      try {
        const evaluated = await devtools.send('Runtime.evaluate', { expression: BOOT_STATE_EXPRESSION, returnByValue: true }, sessionId)
        last = evaluated.result?.value
      } catch {
        // Navigation replaces the execution context; the next poll reads the new document.
        last = undefined
      }
      if (last?.state === 'booting') seenBoot = true
      if (last?.state === 'ready' || (seenBoot && last?.state === 'loading' && last.mounted)) {
        return { status: 'passed', diagnostics }
      }
      if (last?.state === 'failed') {
        return { status: 'failed', message: String(last.text).trim().slice(0, 8000), diagnostics }
      }
      if (now() >= deadline) {
        return {
          status: 'failed',
          message: `the Web UI did not finish booting within ${timeoutMs} ms${last?.text ? `; boot screen showed:\n${String(last.text).trim().slice(0, 4000)}` : ''}`,
          diagnostics,
        }
      }
      await sleep(pollMs, options.signal)
    }
  } finally {
    stopListening()
    await devtools.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

/**
 * Launch a throwaway headless browser profile, load the DSH Web token URL and
 * report whether every plugin activated in the browser.
 */
async function probeWebBoot(url, options = {}) {
  const executable = options.executable
  if (typeof executable !== 'string') throw new Error('no browser executable is available for the Web boot probe')
  const timeoutMs = options.timeoutMs ?? 45_000
  const browser = await launchBrowser(executable, Math.min(timeoutMs, 30_000), options.signal)
  let devtools
  try {
    devtools = await connectDevTools(browser.webSocketUrl, options.WebSocket)
    return await observeWebBoot(devtools, url, { timeoutMs, signal: options.signal })
  } finally {
    devtools?.close()
    browser.close()
  }
}

function formatBootFailure(result) {
  const diagnostics = result.diagnostics?.length > 0 ? `\nBrowser console:\n${result.diagnostics.map(line => `  ${line}`).join('\n')}` : ''
  return `Web UI boot failed in a headless browser:\n${result.message}${diagnostics}`
}

export {
  BOOT_STATE_EXPRESSION,
  connectDevTools,
  findBrowserExecutable,
  formatBootFailure,
  observeWebBoot,
  probeWebBoot,
}
