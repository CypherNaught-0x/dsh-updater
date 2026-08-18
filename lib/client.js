window.__ModuleLoader__.load({
  id: 'dsh-updater',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const STATUS_ROUTE = '/dsh-updater/status'
    const CHECK_ROUTE = '/dsh-updater/check'
    const UPDATE_ROUTE = '/dsh-updater/update'
    const DISMISS_PREFIX = 'dsh-updater:dismissed:'

    const styles = {
      action: { boxSizing: 'border-box', width: '100%', minHeight: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '7px 10px', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', font: 'inherit', fontSize: 13 },
      actionWide: { justifyContent: 'flex-start' },
      actionBadge: { width: 7, height: 7, borderRadius: 999, background: 'var(--dsw-alias-brand-primary)', flex: 'none' },
      icon: { width: 18, height: 18, flex: 'none' },
      overlay: { pointerEvents: 'auto', position: 'fixed', zIndex: 80, top: 16, left: '50%', transform: 'translateX(-50%)', boxSizing: 'border-box', width: 'min(620px, calc(100vw - 32px))', display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-specific-menu)', boxShadow: 'var(--dsw-shadow-lv3)', color: 'var(--dsw-alias-label-primary)' },
      overlayCopy: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
      overlayTitle: { fontSize: 14, fontWeight: 600, lineHeight: '20px' },
      overlayText: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '19px' },
      overlayActions: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
      close: { width: 28, height: 28, border: 0, borderRadius: 14, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', fontSize: 20, lineHeight: '24px' },
      button: { minHeight: 32, padding: '0 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 16, background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', font: 'inherit', fontSize: 13 },
      primaryButton: { minHeight: 32, padding: '0 13px', border: 0, borderRadius: 16, background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)', cursor: 'pointer', font: 'inherit', fontSize: 13 },
      section: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)' },
      heading: { margin: 0, fontSize: 18, lineHeight: '26px' },
      intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
      card: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 },
      fact: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      factLabel: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
      factValue: { overflowWrap: 'anywhere', fontSize: 14, lineHeight: '20px' },
      stateGood: { color: 'var(--dsw-alias-state-success-primary)', margin: 0, fontSize: 13 },
      stateWarn: { color: 'var(--dsw-alias-state-warn-label)', margin: 0, fontSize: 13 },
      stateError: { color: 'var(--dsw-alias-state-error-primary)', margin: 0, fontSize: 13, whiteSpace: 'pre-wrap' },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      pre: { maxHeight: 220, overflow: 'auto', margin: 0, padding: 12, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, lineHeight: '18px' },
      code: { fontFamily: 'monospace', fontSize: 12 },
    }

    function installStyles() {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-updater'
      tag.textContent = `
        .dshu-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
        .dshu-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
        .dshu-button:disabled { cursor: default; opacity: .58; }
      `
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function createClientController(fetchImpl = (...args) => fetch(...args)) {
      let snapshot = {
        status: 'starting',
        currentVersion: null,
        installedVersion: null,
        latestVersion: null,
        latestTag: null,
        updateAvailable: false,
        checkedAt: null,
        error: null,
        install: null,
        check: { status: 'idle', message: null, error: null, requestId: null },
        update: { status: 'idle', message: null, error: null, output: null },
      }
      const listeners = new Set()
      let stopped = false
      let interval
      let requestSequence = 0
      let committedSequence = 0
      const active = new Map()

      const publish = (next) => {
        snapshot = next
        for (const listener of listeners) listener()
      }
      const commit = (next, sequence) => {
        if (sequence < committedSequence) return false
        committedSequence = sequence
        publish(next)
        return true
      }

      const responseJson = async (response) => {
        const text = await response.text()
        if (text.trim().length === 0) {
          throw new Error(response.ok
            ? 'Update request returned an empty response.'
            : `Update request failed with HTTP ${response.status}.`)
        }
        try {
          return JSON.parse(text)
        } catch {
          throw new Error(response.ok
            ? 'Update request returned invalid JSON.'
            : `Update request failed with HTTP ${response.status} and returned invalid JSON.`)
        }
      }

      const requestStatus = async (route, method) => {
        const sequence = ++requestSequence
        if (route === CHECK_ROUTE) {
          commit({
            ...snapshot,
            status: 'checking',
            error: null,
            check: { status: 'running', message: 'Checking for DSH updates…', error: null, requestId: sequence },
          }, sequence)
        } else if (route === UPDATE_ROUTE) {
          commit({
            ...snapshot,
            error: null,
            update: {
              status: 'running',
              message: 'Updating DSH… This can take a few minutes.',
              error: null,
              output: null,
              startedAt: new Date().toISOString(),
            },
          }, sequence)
        }
        let response
        try {
          response = await fetchImpl(route, {
            method,
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
        } catch (error) {
          error.sequence = sequence
          throw error
        }
        let value
        try {
          value = await responseJson(response)
        } catch (error) {
          error.sequence = sequence
          throw error
        }
        if (!response.ok) {
          const error = new Error(value?.error || `Update request failed with HTTP ${response.status}.`)
          if (value?.status) error.statusPublished = commit(value.status, sequence)
          error.sequence = sequence
          throw error
        }
        const next = route === CHECK_ROUTE
          ? {
              ...value,
              check: {
                status: 'succeeded',
                message: value.updateAvailable ? 'The update check completed.' : 'DSH is up to date.',
                error: null,
                requestId: sequence,
              },
            }
          : value
        commit(next, sequence)
        return next
      }

      const run = (route, method) => {
        if (active.has(route)) return active.get(route)
        const operation = requestStatus(route, method)
          .catch((error) => {
            const sequence = error.sequence ?? ++requestSequence
            const errorMessage = messageOf(error)
            if (route === CHECK_ROUTE) {
              commit({
                ...snapshot,
                status: 'error',
                error: errorMessage,
                check: { status: 'failed', message: null, error: errorMessage, requestId: sequence },
              }, sequence)
            } else if (route === UPDATE_ROUTE && error.statusPublished !== true) {
              commit({
                ...snapshot,
                status: 'error',
                error: errorMessage,
                update: {
                  status: 'failed',
                  message: 'The update did not complete.',
                  error: errorMessage,
                  output: null,
                  finishedAt: new Date().toISOString(),
                },
              }, sequence)
            } else if (error.statusPublished !== true) {
              commit({ ...snapshot, status: 'error', error: errorMessage }, sequence)
            }
            return snapshot
          })
          .finally(() => { active.delete(route) })
        active.set(route, operation)
        return operation
      }

      const refresh = () => run(STATUS_ROUTE, 'GET')
      const check = () => run(CHECK_ROUTE, 'POST')
      const update = () => run(UPDATE_ROUTE, 'POST')
      const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
      const start = () => {
        stopped = false
        void refresh()
        interval = setInterval(() => { void refresh() }, 60_000)
        document.addEventListener('visibilitychange', onVisible)
        return stop
      }
      const stop = () => {
        if (stopped) return
        stopped = true
        clearInterval(interval)
        document.removeEventListener('visibilitychange', onVisible)
      }
      return {
        check,
        getSnapshot: () => snapshot,
        refresh,
        start,
        stop,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        update,
      }
    }

    function useUpdater(controller) {
      return React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    }

    const updateIcon = h('svg', { style: styles.icon, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M12 3v12' }),
      h('path', { d: 'm7 10 5 5 5-5' }),
      h('path', { d: 'M5 20h14' }),
    )

    function targetKey(state) {
      if (state.install?.kind === 'source') return state.install.latestRef
      return state.latestVersion
    }

    function dismissed(key) {
      if (key === null || key === undefined || typeof localStorage === 'undefined') return false
      try {
        return localStorage.getItem(DISMISS_PREFIX + key) === '1'
      } catch {
        return false
      }
    }

    function rememberDismissed(key) {
      if (key === null || key === undefined || typeof localStorage === 'undefined') return
      try {
        localStorage.setItem(DISMISS_PREFIX + key, '1')
      } catch {
        // Storage can be blocked without affecting updater operation.
      }
    }

    function updateDescription(state) {
      if (state.install?.kind === 'source') {
        if (state.install.repairRequired) return 'The checkout advanced, but dependency installation or the Web build must be retried.'
        return `${state.install.upstream} is ${state.install.behind} commit${state.install.behind === 1 ? '' : 's'} ahead of this checkout.`
      }
      return `DSH ${state.latestVersion} is available; this process is running ${state.currentVersion}.`
    }

    function UpdaterOverlay({ controller }) {
      const state = useUpdater(controller)
      const updateState = state.update?.status
      const checkState = state.check?.status
      const kind = updateState === 'running'
        ? 'running'
        : updateState === 'succeeded'
          ? 'succeeded'
          : updateState === 'failed'
            ? 'failed'
            : state.updateAvailable
              ? 'available'
              : checkState === 'running'
                ? 'checking'
                : checkState === 'succeeded'
                  ? 'checked'
                  : checkState === 'failed'
                    ? 'check-failed'
                    : null
      const key = kind === 'checking' || kind === 'checked' || kind === 'check-failed'
        ? state.check?.requestId
        : targetKey(state)
      const noticeId = kind === null || key === null || key === undefined ? null : `${kind}:${key}`
      const [hiddenNotice, setHiddenNotice] = React.useState(() => dismissed(noticeId) ? noticeId : null)
      React.useEffect(() => {
        if (noticeId !== hiddenNotice && !dismissed(noticeId)) setHiddenNotice(null)
      }, [noticeId])
      if (kind === null || hiddenNotice === noticeId || dismissed(noticeId)) return null
      const title = {
        running: 'Updating DSH…',
        succeeded: 'DSH update completed',
        failed: 'DSH update failed',
        available: 'DSH update available',
        checking: 'Checking for DSH updates…',
        checked: 'DSH is up to date',
        'check-failed': 'DSH update check failed',
      }[kind]
      const text = kind === 'running' || kind === 'succeeded'
        ? state.update.message
        : kind === 'failed'
          ? state.update.error
          : kind === 'available'
            ? updateDescription(state)
            : kind === 'check-failed'
              ? state.check.error
              : state.check.message
      const canUpdate = state.install?.canAutoUpdate === true
      const close = () => {
        rememberDismissed(noticeId)
        setHiddenNotice(noticeId)
      }
      const announcementRole = kind === 'failed' || kind === 'check-failed' ? 'alert' : 'status'
      const operationRunning = kind === 'running' || kind === 'checking'
      return h('div', { style: styles.overlay, role: 'region', 'aria-label': 'DSH updater notification', 'aria-busy': operationRunning },
        updateIcon,
        h('div', { style: styles.overlayCopy },
          h('div', { role: announcementRole, ...(announcementRole === 'status' ? { 'aria-live': 'polite' } : {}) },
            h('span', { style: styles.overlayTitle }, title),
            h('span', { style: { ...styles.overlayText, display: 'block' } }, text),
          ),
          h('div', { style: styles.overlayActions },
            kind === 'available' && canUpdate ? h('button', { type: 'button', className: 'dshu-button', style: styles.primaryButton, onClick: () => { void controller.update() } }, state.install.actionLabel || 'Update DSH') : null,
            kind === 'available' && !canUpdate ? h('span', { style: styles.overlayText }, state.install?.restartHint) : null,
          ),
        ),
        h('button', { type: 'button', className: 'dshu-button', style: styles.close, 'aria-label': 'Dismiss update notice', onClick: close }, '×'),
      )
    }

    function UpdaterAction({ controller, wide }) {
      const state = useUpdater(controller)
      const busy = state.status === 'checking' || state.check?.status === 'running' || state.update?.status === 'running'
      const available = state.updateAvailable
      const manual = available && state.install?.canAutoUpdate !== true
      const succeeded = state.update?.status === 'succeeded'
      const checkSucceeded = state.check?.status === 'succeeded' && !available
      const label = state.update?.status === 'running'
        ? 'Updating DSH…'
        : succeeded
          ? 'Updated — restart DSH'
          : manual
            ? 'Update available — manual action required'
            : available
              ? state.install?.actionLabel || 'Update DSH'
              : state.status === 'checking' || state.check?.status === 'running'
                ? 'Checking…'
                : checkSucceeded
                  ? 'DSH is up to date'
                  : 'Check for updates'
      const activate = () => {
        if (available) void controller.update()
        else void controller.check()
      }
      return h('button', {
        type: 'button',
        className: 'dshu-button',
        style: { ...styles.action, ...(wide ? styles.actionWide : {}) },
        title: label,
        'aria-label': label,
        disabled: busy || manual || succeeded,
        onClick: activate,
      },
        updateIcon,
        wide ? h('span', null, label) : null,
        available ? h('span', { style: styles.actionBadge, 'aria-label': 'Update available' }) : null,
      )
    }

    function Fact({ label, value, code }) {
      return h('div', { style: styles.fact },
        h('span', { style: styles.factLabel }, label),
        h('span', { style: code ? { ...styles.factValue, ...styles.code } : styles.factValue }, value ?? '—'),
      )
    }

    function UpdaterSection({ controller }) {
      const state = useUpdater(controller)
      const install = state.install
      const busy = state.status === 'checking' || state.check?.status === 'running' || state.update?.status === 'running'
      const latest = install?.kind === 'source' ? install.latestRef : state.latestVersion
      let statusText = 'Update status has not loaded yet.'
      let statusStyle = styles.intro
      if (state.status === 'checking') statusText = 'Checking for updates…'
      else if (state.update?.status === 'running') statusText = state.update.message
      else if (state.error) {
        statusText = state.error
        statusStyle = styles.stateError
      } else if (state.update?.status === 'failed') {
        statusText = state.update.error
        statusStyle = styles.stateError
      } else if (state.update?.status === 'succeeded') {
        statusText = state.update.message
        statusStyle = styles.stateGood
      } else if (state.updateAvailable) {
        statusText = updateDescription(state)
        statusStyle = styles.stateWarn
      } else if (state.status === 'ready') {
        statusText = 'This installation is up to date.'
        statusStyle = styles.stateGood
      }
      return h('section', { style: styles.section },
        h('h2', { style: styles.heading }, 'DSH Updater'),
        h('p', { style: styles.intro }, 'Checks the release source that matches the running installation and updates through the package manager or Git checkout that owns it.'),
        h('div', { style: styles.card },
          h('div', { style: styles.grid },
            h(Fact, { label: 'Installation', value: install?.label }),
            h(Fact, { label: 'Running', value: install?.kind === 'source' ? install.runningRef || state.currentVersion : state.currentVersion, code: true }),
            h(Fact, { label: 'On disk', value: install?.kind === 'source' ? install.currentRef || state.installedVersion : state.installedVersion, code: true }),
            h(Fact, { label: install?.kind === 'source' ? 'Upstream' : `Available (${state.latestTag || 'channel'})`, value: latest, code: true }),
            h(Fact, { label: 'Last checked', value: state.checkedAt ? new Date(state.checkedAt).toLocaleString() : 'Not yet' }),
          ),
          h('p', { style: statusStyle }, statusText),
          install?.commandPreview ? h('p', { style: styles.intro }, 'Update command: ', h('code', { style: styles.code }, install.commandPreview)) : null,
          install?.restartHint ? h('p', { style: styles.intro }, install.restartHint) : null,
          h('div', { style: styles.actions },
            h('button', { type: 'button', className: 'dshu-button', style: styles.button, disabled: busy, onClick: () => { void controller.check() } }, state.status === 'checking' ? 'Checking…' : 'Check now'),
            state.updateAvailable && install?.canAutoUpdate ? h('button', { type: 'button', className: 'dshu-button', style: styles.primaryButton, disabled: busy, onClick: () => { void controller.update() } }, state.update?.status === 'running' ? 'Updating…' : install.actionLabel || 'Update DSH') : null,
          ),
        ),
        state.update?.output ? h('pre', { style: styles.pre }, state.update.output) : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const controller = createClientController()
      ctx.effect(() => installStyles(), 'dsh-updater: styles')
      ctx.effect(() => controller.start(), 'dsh-updater: status controller')
      ctx.on('connection/reset', () => { void controller.refresh() })
      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'dsh-updater',
        order: 40,
      }, () => h(UpdaterOverlay, { controller })))
      slots.inject('sidebar.footer.action', () => slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-updater',
        order: 40,
      }, props => h(UpdaterAction, { controller, wide: props.wide })))
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'dsh-updater',
        order: 40,
        label: 'DSH Updater',
      }, () => h(UpdaterSection, { controller })))
    }

    module.exports.UpdaterAction = UpdaterAction
    module.exports.UpdaterOverlay = UpdaterOverlay
    module.exports.UpdaterSection = UpdaterSection
    module.exports.apply = apply
    module.exports.createClientController = createClientController
    module.exports.inject = inject
    return module.exports
  },
})
