import assert from 'node:assert/strict'
import test from 'node:test'
import { inject, registerUpdaterRoutes } from '../lib/index.js'

test('updater waits for the Web server before applying', () => {
  assert.deepEqual(inject, ['timer', 'webServer'])
})

function response() {
  const headers = {}
  let body = ''
  return {
    headers,
    get body() { return body },
    setHeader(name, value) { headers[name] = value },
    end(value) { body = value },
  }
}

async function invoke(route, options = {}) {
  const req = {
    method: options.method,
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  }
  const res = response()
  await route.handler(req, res)
  return { res, value: JSON.parse(res.body) }
}

test('web routes expose status and protect update mutations', async () => {
  const routes = new Map()
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const state = { status: 'ready', updateAvailable: true }
  let checks = 0
  let validations = 0
  let updates = 0
  const eligibilityChanges = []
  const controller = {
    snapshot: () => state,
    async check() { checks += 1; return state },
    async validate() { validations += 1; return state },
    async update() { updates += 1; return state },
    async setReleaseEligibility(value) { eligibilityChanges.push(value); return { ...state, releaseEligibility: value } },
  }
  const dispose = registerUpdaterRoutes(webServer, controller)

  const status = await invoke(routes.get('/dsh-updater/status'), { method: 'GET' })
  assert.equal(status.res.statusCode, 200)
  assert.deepEqual(status.value, state)

  const remote = await invoke(routes.get('/dsh-updater/status'), { method: 'GET', remoteAddress: '192.0.2.1' })
  assert.equal(remote.res.statusCode, 403)

  const denied = await invoke(routes.get('/dsh-updater/update'), {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', origin: 'https://example.com' },
  })
  assert.equal(denied.res.statusCode, 403)
  assert.equal(updates, 0)

  const accepted = await invoke(routes.get('/dsh-updater/check'), {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(accepted.res.statusCode, 200)
  assert.equal(checks, 1)

 const rebound = await invoke(routes.get('/dsh-updater/check'), {
 method: 'POST',
 headers: { host: 'evil.test', origin: 'https://evil.test' },
 })
 assert.equal(rebound.res.statusCode, 403)
 assert.equal(checks, 1)

 const trustedOriginsVariable = 'DSH_UPDATER_TRUSTED_ORIGINS'
 const previousTrustedOrigins = process.env[trustedOriginsVariable]
 process.env[trustedOriginsVariable] = 'https://dsh.example.test'
 try {
 const trusted = await invoke(routes.get('/dsh-updater/check'), {
 method: 'POST',
 headers: { host: 'dsh.example.test', origin: 'https://dsh.example.test' },
 })
 assert.equal(trusted.res.statusCode, 200)
 assert.equal(checks, 2)
 } finally {
 if (previousTrustedOrigins === undefined) delete process.env[trustedOriginsVariable]
 else process.env[trustedOriginsVariable] = previousTrustedOrigins
 }

  const validated = await invoke(routes.get('/dsh-updater/validate'), {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(validated.res.statusCode, 200)
  assert.equal(validations, 1)

  const eligibility = await invoke(routes.get('/dsh-updater/release-eligibility/beta'), {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(eligibility.res.statusCode, 200)
  assert.equal(eligibility.value.releaseEligibility, 'beta')
  assert.deepEqual(eligibilityChanges, ['beta'])

  const wrongMethod = await invoke(routes.get('/dsh-updater/status'), { method: 'POST' })
  assert.equal(wrongMethod.res.statusCode, 405)
  assert.equal(wrongMethod.res.headers.allow, 'GET')

  dispose()
  assert.equal(routes.size, 0)
})
