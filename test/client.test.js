import assert from 'node:assert/strict'
import test from 'node:test'

function reactStub() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useEffect() {},
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node.children ?? []).map(textOf).join(' ')
}

async function loadClient() {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) { definition = value },
    },
  }
  try {
    await import(`../lib/client.js?test=${Date.now()}`)
  } finally {
    delete globalThis.window
  }
  return {
    definition,
    plugin: definition.factory((name) => {
      assert.equal(name, 'react')
      return reactStub()
    }),
  }
}

test('client registers additive overlay, sidebar, and settings surfaces', async () => {
  const { definition, plugin } = await loadClient()
  assert.equal(definition.id, 'dsh-updater')
  assert.deepEqual(plugin.inject, ['slots'])

  const registrations = []
  const injectionDisposers = []
  const effectDisposers = []
  const slots = {
    inject(_name, callback) {
      injectionDisposers.push(callback())
      return () => {}
    },
    register(options, component) {
      const entry = { options, component }
      registrations.push(entry)
      return () => registrations.splice(registrations.indexOf(entry), 1)
    },
  }
  const previousDocument = globalThis.document
  globalThis.document = {
    visibilityState: 'visible',
    head: { appendChild() {} },
    createElement() {
      return { dataset: {}, textContent: '', remove() {} }
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: 'ready',
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        updateAvailable: true,
        install: { label: 'npm global installation', canAutoUpdate: true, actionLabel: 'Update DSH' },
        update: { status: 'idle' },
      })
    },
  })
  try {
    plugin.apply({
      get(name) { return name === 'slots' ? slots : undefined },
      effect(setup) { const dispose = setup(); effectDisposers.push(dispose); return dispose },
      on() { return () => {} },
    })
    assert.deepEqual(registrations.map(entry => entry.options), [{
      name: 'shell.overlay', id: 'dsh-updater', order: 40,
    }, {
      name: 'sidebar.footer.action', id: 'dsh-updater', order: 40,
    }, {
      name: 'settings.section', id: 'dsh-updater', order: 40, label: 'DSH Updater',
    }])
    const actionElement = registrations[1].component({ wide: true })
    assert.equal(typeof actionElement.type, 'function')
    assert.equal(actionElement.props.wide, true)
    const sectionElement = registrations[2].component({ close() {} })
    assert.equal(typeof sectionElement.type, 'function')
  } finally {
    for (const dispose of effectDisposers.reverse()) dispose?.()
    for (const dispose of injectionDisposers.reverse()) dispose?.()
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
  }
  assert.equal(registrations.length, 0)
})

test('client controller checks and updates through fixed same-origin routes', async () => {
  const { plugin } = await loadClient()
  const requests = []
  const responses = [{ status: 'ready', updateAvailable: true }, { status: 'ready', updateAvailable: false, update: { status: 'succeeded' } }]
  const controller = plugin.createClientController(async (url, options) => {
    requests.push({ url, options })
    const value = responses.shift()
    return { ok: true, status: 200, async text() { return JSON.stringify(value) } }
  })
  await controller.check()
  await controller.update()
  assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
    ['/dsh-updater/check', 'POST'],
    ['/dsh-updater/update', 'POST'],
  ])
  assert.equal(controller.getSnapshot().update.status, 'succeeded')
})

test('manual checks publish immediate progress and an up-to-date result', async () => {
  const { plugin } = await loadClient()
  let release
  const responseReady = new Promise(resolve => { release = resolve })
  const controller = plugin.createClientController(async () => {
    await responseReady
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          status: 'ready',
          currentVersion: '1.0.0',
          latestVersion: '1.0.0',
          updateAvailable: false,
          update: { status: 'idle' },
        })
      },
    }
  })

  const checking = controller.check()
  assert.equal(controller.getSnapshot().status, 'checking')
  assert.equal(controller.getSnapshot().check.status, 'running')
  assert.match(textOf(plugin.UpdaterOverlay({ controller })), /Checking for DSH updates/)

  release()
  await checking
  assert.equal(controller.getSnapshot().check.status, 'succeeded')
  assert.match(textOf(plugin.UpdaterOverlay({ controller })), /DSH is up to date/)
  assert.match(textOf(plugin.UpdaterAction({ controller, wide: true })), /DSH is up to date/)
})

test('empty error responses become actionable check feedback', async () => {
  const { plugin } = await loadClient()
  const controller = plugin.createClientController(async () => ({
    ok: false,
    status: 405,
    async text() { return '' },
  }))

  await controller.check()
  assert.equal(controller.getSnapshot().check.status, 'failed')
  assert.equal(controller.getSnapshot().error, 'Update request failed with HTTP 405.')
  const overlayText = textOf(plugin.UpdaterOverlay({ controller }))
  assert.match(overlayText, /DSH update check failed/)
  assert.match(overlayText, /HTTP 405/)
})

test('client controller does not swallow an update behind a status refresh', async () => {
  const { plugin } = await loadClient()
  const requests = []
  let releaseRefresh
  const refreshResponse = new Promise(resolve => { releaseRefresh = resolve })
  const controller = plugin.createClientController(async (url, options) => {
    requests.push([url, options.method])
    if (url === '/dsh-updater/status') {
      await refreshResponse
      return { ok: true, status: 200, async text() { return JSON.stringify({ status: 'ready', updateAvailable: true }) } }
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ status: 'ready', updateAvailable: false, update: { status: 'succeeded' } }) } }
  })
  const refreshing = controller.refresh()
  await Promise.resolve()
  const updating = controller.update()
  await Promise.resolve()
  assert.deepEqual(requests, [
    ['/dsh-updater/status', 'GET'],
    ['/dsh-updater/update', 'POST'],
  ])
  releaseRefresh()
  await Promise.all([refreshing, updating])
  assert.equal(controller.getSnapshot().update.status, 'succeeded')
})

test('terminal overlays honor persisted dismissal keys', async () => {
  const { plugin } = await loadClient()
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem(key) {
      return key === 'dsh-updater:dismissed:succeeded:1.0.1' ? '1' : null
    },
    setItem() {},
  }
  try {
    const controller = {
      subscribe() { return () => {} },
      getSnapshot() {
        return {
          status: 'ready',
          currentVersion: '1.0.1',
          latestVersion: '1.0.1',
          updateAvailable: false,
          install: { kind: 'npm-global' },
          update: { status: 'succeeded', message: 'Updated.' },
        }
      },
    }
    assert.equal(plugin.UpdaterOverlay({ controller }), null)
  } finally {
    globalThis.localStorage = previousStorage
  }
})

test('sidebar action is informational when automatic update is unsafe', async () => {
  const { plugin } = await loadClient()
  const controller = {
    subscribe() { return () => {} },
    getSnapshot() {
      return {
        status: 'ready',
        updateAvailable: true,
        install: { canAutoUpdate: false },
        update: { status: 'idle' },
      }
    },
    check() { throw new Error('disabled action must not check') },
    update() { throw new Error('disabled action must not update') },
  }
  const button = plugin.UpdaterAction({ controller, wide: true })
  assert.equal(button.type, 'button')
  assert.equal(button.props.disabled, true)
  assert.equal(button.props['aria-label'], 'Update available — manual action required')
})

test('server-provided failed update state is not overwritten by a generic client error', async () => {
  const { plugin } = await loadClient()
  const failed = {
    status: 'ready',
    error: null,
    updateAvailable: true,
    install: { canAutoUpdate: true },
    update: { status: 'failed', error: 'package manager failed' },
  }
  const controller = plugin.createClientController(async () => ({
    ok: false,
    status: 500,
    async text() { return JSON.stringify({ error: 'Update failed.', status: failed }) },
  }))
  await controller.update()
  assert.deepEqual(controller.getSnapshot(), failed)
})
