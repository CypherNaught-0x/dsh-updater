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

let importSequence = 0

async function loadClient() {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) { definition = value },
    },
  }
  try {
    await import(`../lib/client.js?test=${++importSequence}`)
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
  const responses = [{ updaterApiVersion: 3, status: 'ready', updateAvailable: true, validation: { status: 'passed' } }, { status: 'ready', updateAvailable: false, update: { status: 'succeeded' } }]
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

test('available updates show release notes before validation or application', async () => {
  const { plugin } = await loadClient()
  const controller = plugin.createClientController(async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        updaterApiVersion: 3,
        status: 'ready',
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        latestTag: 'latest',
        updateAvailable: true,
        install: { kind: 'npm-global', label: 'npm global installation', canAutoUpdate: true },
        changelog: {
          source: 'github',
          text: '## Bug fixes\n\n- Fixed authenticated Web startup.',
          url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v2.0.0',
        },
        validation: { status: 'idle', checks: [], blockingIssues: [] },
        update: { status: 'idle' },
      })
    },
  }))
  await controller.refresh()
  for (const surface of [plugin.UpdaterOverlay({ controller }), plugin.UpdaterSection({ controller })]) {
    const text = textOf(surface)
    assert.match(text, /Changes in 2\.0\.0 — GitHub Releases/)
    assert.match(text, /Fixed authenticated Web startup/)
    assert.match(text, /View on GitHub Releases/)
  }
})

test('legacy Host API asks for a restart instead of reporting a blocked candidate', async () => {
  const { plugin } = await loadClient()
  const requests = []
  const controller = plugin.createClientController(async (url, options) => {
    requests.push([url, options.method])
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          updaterApiVersion: 2,
          status: 'ready',
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
          updateAvailable: true,
          install: { canAutoUpdate: true },
          validation: { status: 'blocked' },
          update: { status: 'idle' },
        })
      },
    }
  })

  await controller.refresh()
  assert.equal(controller.getSnapshot().validation.status, 'restart-required')
  await controller.validate()
  assert.deepEqual(requests, [['/dsh-updater/status', 'GET']])
  const overlay = textOf(plugin.UpdaterOverlay({ controller }))
  assert.match(overlay, /Restart DSH to enable candidate testing/)
  assert.doesNotMatch(overlay, /candidate is blocked|HTTP 405/i)
  const action = plugin.UpdaterAction({ controller, wide: true })
  assert.equal(action.props.disabled, true)
  assert.match(textOf(action), /Restart DSH to enable candidate testing/)
})

test('missing validation route is treated as a Host restart requirement', async () => {
  const { plugin } = await loadClient()
  let requests = 0
  const controller = plugin.createClientController(async () => {
    requests += 1
    if (requests === 1) return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ updaterApiVersion: 3, status: 'ready', currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true, validation: { status: 'idle' } }) },
    }
    return { ok: false, status: 405, async text() { return '' } }
  })
  await controller.check()
  await controller.validate()
  assert.equal(controller.getSnapshot().validation.status, 'restart-required')
  assert.equal(controller.getSnapshot().error, null)
  assert.match(textOf(plugin.UpdaterOverlay({ controller })), /Restart DSH to enable candidate testing/)
})

test('running validation displays the current staging phase', async () => {
  const { plugin } = await loadClient()
  const controller = plugin.createClientController(async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        updaterApiVersion: 3,
        status: 'ready',
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
        validation: { status: 'running', phase: 'install', message: 'Installing candidate dependencies; npm dependency resolution can take several minutes…', checks: [] },
        update: { status: 'idle' },
      })
    },
  }))
  await controller.refresh()
  assert.match(textOf(plugin.UpdaterOverlay({ controller })), /npm dependency resolution can take several minutes/)
  assert.match(textOf(plugin.UpdaterSection({ controller })), /npm dependency resolution can take several minutes/)
})

test('blocked validation asks before placing a repair prompt in the model composer', async () => {
  const { plugin } = await loadClient()
  const prompts = []
  const blocked = {
    status: 'ready',
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    updateAvailable: true,
    install: { canAutoUpdate: true },
    validation: {
      status: 'blocked',
      target: '2.0.0',
      candidatePath: '/tmp/candidate',
      checks: [
        { id: 'tui', label: 'TUI startup', status: 'failed', error: 'TUI exited early' },
        { id: 'web', label: 'Web startup and HTTP response', status: 'passed' },
      ],
      blockingIssues: [{ check: 'tui', message: 'TUI exited early' }],
      repairPrompt: 'Fix only the isolated candidate.',
    },
    update: { status: 'idle' },
  }
  const controller = plugin.createClientController(async (url) => {
    assert.equal(url, '/dsh-updater/validate')
    return { ok: true, status: 200, async text() { return JSON.stringify(blocked) } }
  }, {
    async promptModel(prompt) { prompts.push(prompt); return true },
  })

  const validating = controller.validate()
  assert.equal(controller.getSnapshot().validation.status, 'running')
  await validating
  assert.equal(controller.getSnapshot().validation.status, 'blocked')
  const section = textOf(plugin.UpdaterSection({ controller }))
  assert.match(section, /TUI startup/)
  assert.match(section, /Ask AI to finish update/)
  assert.equal(prompts.length, 0)
  assert.equal(await controller.promptModel(), true)
  assert.deepEqual(prompts, ['Fix only the isolated candidate.'])
})

test('updates publish immediate progress before the Host operation completes', async () => {
  const { plugin } = await loadClient()
  let releaseUpdate
  const updateReady = new Promise(resolve => { releaseUpdate = resolve })
  const controller = plugin.createClientController(async (url) => {
    if (url === '/dsh-updater/check') {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            updaterApiVersion: 3,
            status: 'ready',
            currentVersion: '1.0.0',
            latestVersion: '1.0.1',
            updateAvailable: true,
            install: { canAutoUpdate: true, actionLabel: 'Update DSH' },
            validation: { status: 'passed' },
            update: { status: 'idle' },
          })
        },
      }
    }
    await updateReady
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          status: 'ready',
          currentVersion: '1.0.0',
          latestVersion: '1.0.1',
          updateAvailable: false,
          install: { canAutoUpdate: true, actionLabel: 'Update DSH' },
          update: { status: 'succeeded', message: 'Updated on disk.' },
        })
      },
    }
  })

  await controller.check()
  const updating = controller.update()
  assert.equal(controller.getSnapshot().update.status, 'running')
  assert.match(textOf(plugin.UpdaterOverlay({ controller })), /This can take a few minutes/)
  assert.match(textOf(plugin.UpdaterAction({ controller, wide: true })), /Applying verified update/)
  assert.match(textOf(plugin.UpdaterSection({ controller })), /This can take a few minutes/)

  releaseUpdate()
  await updating
  assert.equal(controller.getSnapshot().update.status, 'succeeded')
})

test('update request failures replace progress with failure feedback', async () => {
  const { plugin } = await loadClient()
  const controller = plugin.createClientController(async (url) => url === '/dsh-updater/check'
    ? {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            updaterApiVersion: 3,
            status: 'ready',
            currentVersion: '1.0.0',
            latestVersion: '1.0.1',
            updateAvailable: true,
            install: { canAutoUpdate: true },
            validation: { status: 'passed' },
            update: { status: 'idle' },
          })
        },
      }
    : {
        ok: false,
        status: 502,
        async text() { return '' },
      })

  await controller.check()
  await controller.update()
  assert.equal(controller.getSnapshot().update.status, 'failed')
  assert.equal(controller.getSnapshot().update.error, 'Update request failed with HTTP 502.')
  assert.match(textOf(plugin.UpdaterOverlay({ controller })), /DSH update failed/)
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
      return { ok: true, status: 200, async text() { return JSON.stringify({ updaterApiVersion: 3, status: 'ready', updateAvailable: true, validation: { status: 'passed' } }) } }
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
