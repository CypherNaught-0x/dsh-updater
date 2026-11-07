import assert from 'node:assert/strict'
import test from 'node:test'
import { findBrowserExecutable, formatBootFailure, observeWebBoot } from '../lib/browser.js'

function fakeDevTools(states, events = []) {
  const listeners = new Set()
  const sent = []
  let index = 0
  return {
    sent,
    async send(method, params, sessionId) {
      sent.push({ method, params, sessionId })
      if (method === 'Target.createTarget') return { targetId: 't1' }
      if (method === 'Target.attachToTarget') return { sessionId: 's1' }
      if (method === 'Page.navigate') {
        for (const event of events) for (const listener of listeners) listener(event)
        return {}
      }
      if (method === 'Runtime.evaluate') {
        const value = states[Math.min(index, states.length - 1)]
        index += 1
        if (value instanceof Error) throw value
        return { result: { value } }
      }
      return {}
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

test('boot probe passes once DSH mounts its application root', async () => {
  const devtools = fakeDevTools([new Error('context destroyed'), { state: 'loading' }, { state: 'booting', text: 'HARNESS' }, { state: 'ready' }])
  const result = await observeWebBoot(devtools, 'http://127.0.0.1:1/?token=x', { timeoutMs: 5000, pollMs: 1 })
  assert.equal(result.status, 'passed')
  assert.deepEqual(devtools.sent.find(call => call.method === 'Page.navigate').params, { url: 'http://127.0.0.1:1/?token=x' })
  assert.ok(devtools.sent.some(call => call.method === 'Target.closeTarget'))
})

test('boot probe reports the "Failed to load plugins" card with console errors', async () => {
  const devtools = fakeDevTools([
    { state: 'booting', text: 'HARNESS' },
    { state: 'failed', text: 'HARNESS\nFailed to load plugins\nweb boot: 2 entries did not activate\na: pending (waiting for service: uiWorkspace)' },
  ], [
    { sessionId: 's1', method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ value: 'missed the module table' }] } },
    { sessionId: 'other', method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'ignored' } } },
  ])
  const result = await observeWebBoot(devtools, 'http://127.0.0.1:1/', { timeoutMs: 5000, pollMs: 1 })
  assert.equal(result.status, 'failed')
  assert.match(result.message, /2 entries did not activate/)
  assert.deepEqual(result.diagnostics, ['console.error: missed the module table'])
  assert.match(formatBootFailure(result), /Browser console:\n {2}console.error: missed the module table/)
})

test('boot probe times out with the last boot screen text', async () => {
  let clock = 0
  const devtools = fakeDevTools([{ state: 'booting', text: 'still loading' }])
  const result = await observeWebBoot(devtools, 'http://127.0.0.1:1/', { timeoutMs: 100, pollMs: 1, now: () => (clock += 60) })
  assert.equal(result.status, 'failed')
  assert.match(result.message, /did not finish booting within 100 ms[\s\S]*still loading/)
})

test('browser discovery prefers the configured executable, then the environment', () => {
  const present = new Set(['/custom/chrome', '/env/chrome', '/usr/bin/chromium'])
  const exists = path => present.has(path)
  assert.equal(findBrowserExecutable('/custom/chrome', { exists, platform: 'linux', environment: { DSH_UPDATER_BROWSER: '/env/chrome', HOME: '/home/u' } }), '/custom/chrome')
  assert.equal(findBrowserExecutable('', { exists, platform: 'linux', environment: { DSH_UPDATER_BROWSER: '/env/chrome', HOME: '/home/u' } }), '/env/chrome')
  assert.equal(findBrowserExecutable('', { exists, platform: 'linux', environment: { HOME: '/home/u' } }), '/usr/bin/chromium')
  assert.equal(findBrowserExecutable('', { exists: () => false, platform: 'linux', environment: { HOME: '/home/u' } }), undefined)
})
