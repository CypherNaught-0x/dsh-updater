window.__ModuleLoader__.load({
  id: 'dsh-updater',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const STATUS_ROUTE = '/dsh-updater/status'
    const CHECK_ROUTE = '/dsh-updater/check'
    const VALIDATE_ROUTE = '/dsh-updater/validate'
    const UPDATE_ROUTE = '/dsh-updater/update'
    const RESTART_ROUTE = '/dsh-updater/restart'
    const RESTART_DISMISS_ROUTE = '/dsh-updater/restart/dismiss'
    const ELIGIBILITY_ROUTE_PREFIX = '/dsh-updater/release-eligibility/'
    const RELEASE_ELIGIBILITY_OPTIONS = [
      ['stable', 'Stable only'],
      ['rc', 'Stable + RC'],
      ['beta', 'Stable + RC + Beta'],
      ['alpha', 'All including Alpha'],
    ]
    const DISMISS_PREFIX = 'dsh-updater:dismissed:'
    const RESTART_REQUIRED_MESSAGE = 'Restart DSH to activate the updater Host validation gate, then test the candidate again.'
    const SETTINGS_RESTART_REQUIRED_MESSAGE = 'Restart DSH to activate release eligibility settings, then choose this option again.'

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
      matrix: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' },
      matrixRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, fontSize: 13 },
      changelog: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 },
      changelogSummary: { cursor: 'pointer', fontSize: 13, fontWeight: 600 },
      changelogText: { maxHeight: 220, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-secondary)', fontFamily: 'inherit', fontSize: 12, lineHeight: '18px' },
      changelogLink: { color: 'var(--dsw-alias-brand-primary)', fontSize: 12 },
      settingRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
      settingLabel: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 220, flex: 1, fontSize: 14 },
      settingHint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' },
      select: { minWidth: 210, minHeight: 34, padding: '0 30px 0 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-specific-menu)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13 },
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

    function createClientController(fetchImpl = (...args) => fetch(...args), options = {}) {
      let snapshot = {
        updaterApiVersion: null,
        releaseEligibility: 'stable',
        releaseEligibilityStatus: { status: 'idle', error: null },
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
        check: { status: 'idle', message: null, error: null, requestId: null },
        validation: { status: 'idle', target: null, phase: null, message: null, candidatePath: null, checks: [], blockingIssues: [], warnings: [], repairPrompt: null },
        update: { status: 'idle', message: null, error: null, output: null },
        profileName: null,
        restart: null,
      }
      const listeners = new Set()
      let stopped = false
      let interval
      let progressInterval
      let requestSequence = 0
      let committedSequence = 0
      const active = new Map()

      const publish = (next) => {
        snapshot = {
          ...next,
          releaseEligibility: next?.releaseEligibility ?? snapshot.releaseEligibility,
          releaseEligibilityStatus: next?.releaseEligibilityStatus ?? snapshot.releaseEligibilityStatus,
        }
        for (const listener of listeners) listener()
      }
      const commit = (next, sequence) => {
        if (sequence < committedSequence) return false
        committedSequence = sequence
        publish(next)
        return true
      }
      const normalizeStatus = (value, route) => {
        if (route !== STATUS_ROUTE && route !== CHECK_ROUTE) return value
        if (value?.updaterApiVersion >= 3) return value
        return {
          ...value,
          updaterApiVersion: value?.updaterApiVersion ?? 1,
          validation: {
            status: 'restart-required',
            target: value?.latestVersion ?? null,
            candidatePath: null,
            checkedAt: null,
            checks: [],
            blockingIssues: [],
            repairPrompt: null,
          },
        }
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
        } else if (route === VALIDATE_ROUTE) {
          commit({
            ...snapshot,
            error: null,
            validation: {
              ...snapshot.validation,
              status: 'running',
              phase: 'initializing',
              message: 'Preparing an isolated directory for the candidate…',
              checks: [],
              blockingIssues: [],
              repairPrompt: null,
            },
          }, sequence)
        } else if (route === UPDATE_ROUTE) {
          commit({
            ...snapshot,
            error: null,
            update: {
              status: 'running',
              message: 'Applying the verified DSH update… This can take a few minutes.',
              error: null,
              output: null,
              startedAt: new Date().toISOString(),
            },
          }, sequence)
        } else if (route.startsWith(ELIGIBILITY_ROUTE_PREFIX)) {
          commit({ ...snapshot, releaseEligibilityStatus: { status: 'saving', error: null } }, sequence)
        } else if (route === RESTART_ROUTE) {
          commit({ ...snapshot, error: null, restart: { ...(snapshot.restart ?? {}), status: 'scheduled', error: null, message: 'Asking DSH to restart…' } }, sequence)
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
          if (value?.status) error.statusPublished = commit(normalizeStatus(value.status, route), sequence)
          error.sequence = sequence
          throw error
        }
        const normalized = normalizeStatus(value, route)
        const next = route === CHECK_ROUTE
          ? {
              ...normalized,
              check: {
                status: 'succeeded',
                message: normalized.updateAvailable ? 'The update check completed.' : 'DSH is up to date.',
                error: null,
                requestId: sequence,
              },
            }
          : route.startsWith(ELIGIBILITY_ROUTE_PREFIX)
            ? { ...normalized, releaseEligibilityStatus: { status: 'saved', error: null } }
            : normalized
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
            } else if (route === VALIDATE_ROUTE && error.statusPublished !== true && /HTTP (?:404|405)\b/u.test(errorMessage)) {
              commit({
                ...snapshot,
                error: null,
                updaterApiVersion: 1,
                validation: {
                  ...snapshot.validation,
                  status: 'restart-required',
                  checks: [],
                  blockingIssues: [],
                  repairPrompt: null,
                },
              }, sequence)
            } else if (route === VALIDATE_ROUTE && error.statusPublished !== true) {
              commit({
                ...snapshot,
                error: errorMessage,
                validation: {
                  ...snapshot.validation,
                  status: 'blocked',
                  checks: [],
                  blockingIssues: [{ check: 'stage', message: errorMessage }],
                  repairPrompt: null,
                },
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
            } else if (route.startsWith(ELIGIBILITY_ROUTE_PREFIX) && /HTTP (?:404|405)\b/u.test(errorMessage)) {
              commit({
                ...snapshot,
                error: null,
                releaseEligibilityStatus: { status: 'restart-required', error: SETTINGS_RESTART_REQUIRED_MESSAGE },
              }, sequence)
            } else if (route.startsWith(ELIGIBILITY_ROUTE_PREFIX)) {
              commit({ ...snapshot, releaseEligibilityStatus: { status: 'failed', error: errorMessage } }, sequence)
            } else if (restarting(snapshot) && error.statusPublished !== true) {
              // The server is expected to be gone while it restarts; the new server opens a fresh tab.
              commit({
                ...snapshot,
                error: null,
                restart: {
                  ...snapshot.restart,
                  status: 'restarting',
                  message: 'DSH is restarting and checking that it boots. A new browser tab opens when it is ready; this tab can be closed.',
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
      const restart = () => run(RESTART_ROUTE, 'POST')
      const dismissRestart = () => run(RESTART_DISMISS_ROUTE, 'POST')
      const check = () => run(CHECK_ROUTE, 'POST')
      const validationUnavailable = () => snapshot.validation?.status === 'restart-required'
      const validate = () => validationUnavailable() ? Promise.resolve(snapshot) : run(VALIDATE_ROUTE, 'POST')
      const update = () => validationUnavailable() ? Promise.resolve(snapshot) : run(UPDATE_ROUTE, 'POST')
      const setReleaseEligibility = (value) => RELEASE_ELIGIBILITY_OPTIONS.some(([candidate]) => candidate === value)
        ? run(`${ELIGIBILITY_ROUTE_PREFIX}${value}`, 'POST')
        : Promise.resolve(snapshot)
      const promptModel = async (prompt = snapshot.validation?.repairPrompt) => {
        if (typeof prompt !== 'string' || prompt.length === 0) return false
        try {
          if (typeof options.promptModel === 'function' && await options.promptModel(prompt)) return true
          if (globalThis.navigator?.clipboard?.writeText !== undefined) {
            await globalThis.navigator.clipboard.writeText(prompt)
            return true
          }
        } catch {
          return false
        }
        return false
      }
      const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
      const start = () => {
        stopped = false
        void refresh()
        interval = setInterval(() => { void refresh() }, 60_000)
        progressInterval = setInterval(() => {
          if (snapshot.validation?.status === 'running' || restarting(snapshot)) void refresh()
        }, 2000)
        document.addEventListener('visibilitychange', onVisible)
        return stop
      }
      const stop = () => {
        if (stopped) return
        stopped = true
        clearInterval(interval)
        clearInterval(progressInterval)
        document.removeEventListener('visibilitychange', onVisible)
      }
      return {
        check,
        dismissRestart,
        getSnapshot: () => snapshot,
        promptModel,
        refresh,
        restart,
        setReleaseEligibility,
        start,
        stop,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        update,
        validate,
      }
    }

    function restarting(state) {
      return state.restart?.status === 'scheduled' || state.restart?.status === 'restarting'
    }

    function inRescue(state) {
      return state.restart?.status === 'rescue' && state.profileName !== null && state.profileName === state.restart.rescueProfile
    }

    function restartFinished(state) {
      return ['succeeded', 'failed'].includes(state.restart?.status) || (state.restart?.status === 'rescue' && !inRescue(state))
    }

    function checkStatusLabel(check) {
      if (check.status === 'passed') return ['Passed', styles.stateGood]
      if (check.status === 'warning') return ['Warning', styles.stateWarn]
      if (check.status === 'skipped') return [check.id === 'tui' ? 'Not shipped' : 'Skipped', styles.stateWarn]
      return ['Blocked', styles.stateError]
    }

    function warningSummary(state) {
      const warnings = state.validation?.warnings ?? []
      return warnings.length === 0 ? '' : ` Warning: ${warnings.map(warning => warning.message).join('\n')}`
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

    function changelogView(state) {
      if (!state.updateAvailable || state.changelog === null || state.changelog === undefined) return null
      const target = state.install?.kind === 'source' ? state.install.latestRef : state.latestVersion
      const source = state.changelog.source === 'npm' ? 'npm' : 'GitHub Releases'
      const text = typeof state.changelog.text === 'string' && state.changelog.text.length > 0
        ? state.changelog.text
        : state.install?.kind === 'source'
          ? 'Release notes are not tied to this unreleased source commit. Review the published releases before updating.'
          : 'No release notes were published with this version. Open GitHub Releases for available details.'
      return h('details', { open: true, style: styles.changelog },
        h('summary', { style: styles.changelogSummary }, `Changes in ${target} — ${source}`),
        h('pre', { style: styles.changelogText }, text),
        h('a', { href: state.changelog.url, target: '_blank', rel: 'noopener noreferrer', style: styles.changelogLink }, state.changelog.source === 'npm' ? 'View package on npm' : 'View on GitHub Releases'),
      )
    }

    function UpdaterOverlay({ controller }) {
      const state = useUpdater(controller)
      const updateState = state.update?.status
      const validationState = state.validation?.status
      const checkState = state.check?.status
      const restartState = inRescue(state)
        ? 'rescue'
        : restarting(state)
          ? 'restarting'
          : restartFinished(state)
            ? (state.restart.status === 'succeeded' ? 'restart-succeeded' : 'restart-failed')
            : null
      const kind = restartState !== null
        ? restartState
        : updateState === 'running'
        ? 'running'
        : updateState === 'succeeded'
          ? 'succeeded'
          : updateState === 'failed'
            ? 'failed'
            : validationState === 'restart-required' && state.updateAvailable
              ? 'restart-required'
              : validationState === 'running'
              ? 'validating'
              : validationState === 'blocked'
                ? 'blocked'
                : validationState === 'passed' && state.updateAvailable
                  ? 'verified'
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
        : restartState !== null
          ? state.restart.id ?? state.restart.requestedAt ?? 'restart'
          : targetKey(state)
      const noticeId = kind === null || key === null || key === undefined ? null : `${kind}:${key}`
      const [hiddenNotice, setHiddenNotice] = React.useState(() => dismissed(noticeId) ? noticeId : null)
      React.useEffect(() => {
        if (noticeId !== hiddenNotice && !dismissed(noticeId)) setHiddenNotice(null)
      }, [noticeId])
      if (kind === null || hiddenNotice === noticeId || dismissed(noticeId)) return null
      const originalProfile = state.restart?.profile ?? 'web'
      const title = {
        rescue: 'DSH is running in rescue mode',
        restarting: 'Restarting DSH…',
        'restart-succeeded': 'DSH restarted',
        'restart-failed': 'DSH restart needs attention',
        running: 'Updating DSH…',
        succeeded: 'DSH update completed',
        failed: 'DSH update failed',
        'restart-required': 'Restart DSH to enable candidate testing',
        validating: 'Testing DSH candidate…',
        blocked: 'DSH candidate is blocked',
        verified: 'DSH candidate passed',
        available: 'DSH update available',
        checking: 'Checking for DSH updates…',
        checked: 'DSH is up to date',
        'check-failed': 'DSH update check failed',
      }[kind]
      const text = restartState !== null
        ? state.restart.message
        : kind === 'running' || kind === 'succeeded'
        ? state.update.message
        : kind === 'failed'
          ? state.update.error
          : kind === 'restart-required'
            ? RESTART_REQUIRED_MESSAGE
            : kind === 'validating'
            ? state.validation.message || 'Installing and starting the candidate separately in supported TUI and Web modes.'
            : kind === 'blocked'
              ? state.validation.blockingIssues?.map(issue => issue.message).join('\n') || 'One or more candidate startup checks failed.'
              : kind === 'verified'
                ? `The exact candidate passed every blocking startup check and is ready to apply.${warningSummary(state)}`
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
      const announcementRole = kind === 'failed' || kind === 'blocked' || kind === 'check-failed' || kind === 'rescue' || kind === 'restart-failed' ? 'alert' : 'status'
      const operationRunning = kind === 'running' || kind === 'validating' || kind === 'checking' || kind === 'restarting'
      const dismissible = kind !== 'rescue' && kind !== 'restarting'
      return h('div', { style: styles.overlay, role: 'region', 'aria-label': 'DSH updater notification', 'aria-busy': operationRunning },
        updateIcon,
        h('div', { style: styles.overlayCopy },
          h('div', { role: announcementRole, ...(announcementRole === 'status' ? { 'aria-live': 'polite' } : {}) },
            h('span', { style: styles.overlayTitle }, title),
            h('span', { style: { ...styles.overlayText, display: 'block' } }, text),
          ),
          changelogView(state),
          h('div', { style: styles.overlayActions },
            kind === 'rescue' && state.restart.recoveryPrompt ? h('button', { type: 'button', className: 'dshu-button', style: styles.primaryButton, onClick: () => { void controller.promptModel(state.restart.recoveryPrompt) } }, `Ask AI to repair "${originalProfile}"`) : null,
            kind === 'rescue' ? h('button', { type: 'button', className: 'dshu-button', style: styles.button, onClick: () => { void controller.restart() } }, `Restart into "${originalProfile}"`) : null,
            kind === 'restart-failed' && state.install?.kind !== 'npx' ? h('button', { type: 'button', className: 'dshu-button', style: styles.button, onClick: () => { void controller.restart() } }, 'Restart DSH again') : null,
            kind === 'verified' && state.validation?.warnings?.length > 0 && state.validation?.repairPrompt ? h('button', { type: 'button', className: 'dshu-button', style: styles.button, onClick: () => { void controller.promptModel() } }, 'Ask AI to fix plugins') : null,
            kind === 'available' && canUpdate ? h('button', { type: 'button', className: 'dshu-button', style: styles.primaryButton, onClick: () => { void controller.validate() } }, 'Test candidate') : null,
            kind === 'verified' && canUpdate ? h('button', { type: 'button', className: 'dshu-button', style: styles.primaryButton, onClick: () => { void controller.update() } }, 'Apply verified update') : null,
            kind === 'blocked' && state.validation?.repairPrompt ? h('button', { type: 'button', className: 'dshu-button', style: styles.primaryButton, onClick: () => { void controller.promptModel() } }, 'Ask AI to finish update') : null,
            kind === 'blocked' ? h('button', { type: 'button', className: 'dshu-button', style: styles.button, onClick: () => { void controller.validate() } }, 'Test again') : null,
            kind === 'available' && !canUpdate ? h('span', { style: styles.overlayText }, state.install?.restartHint) : null,
          ),
        ),
        dismissible ? h('button', { type: 'button', className: 'dshu-button', style: styles.close, 'aria-label': 'Dismiss update notice', onClick: close }, '×') : null,
      )
    }

    function UpdaterAction({ controller, wide }) {
      const state = useUpdater(controller)
      const busy = state.status === 'checking' || state.check?.status === 'running' || state.validation?.status === 'running' || state.update?.status === 'running'
      const available = state.updateAvailable
      const manual = available && state.install?.canAutoUpdate !== true
      const succeeded = state.update?.status === 'succeeded'
      const checkSucceeded = state.check?.status === 'succeeded' && !available
      const rescue = inRescue(state)
      const canRestart = state.install !== null && state.install?.kind !== 'npx'
      const label = rescue
        ? `Rescue mode — restart into "${state.restart.profile ?? 'web'}"`
        : restarting(state)
          ? 'Restarting DSH…'
          : state.update?.status === 'running'
        ? 'Applying verified update…'
        : state.validation?.status === 'running'
          ? 'Testing DSH candidate…'
          : succeeded
            ? 'Updated — restart DSH'
            : available && state.validation?.status === 'restart-required'
              ? 'Restart DSH to enable candidate testing'
              : manual
              ? 'Update available — manual action required'
              : available && state.validation?.status === 'blocked'
                ? 'Candidate blocked — review issues'
                : available && state.validation?.status === 'passed'
                  ? 'Apply verified update'
                  : available
                    ? 'Test DSH candidate'
                    : state.status === 'checking' || state.check?.status === 'running'
                      ? 'Checking…'
                      : checkSucceeded
                        ? 'DSH is up to date'
                        : 'Check for updates'
      const activate = () => {
        if (rescue || (succeeded && canRestart)) void controller.restart()
        else if (available && state.validation?.status === 'passed') void controller.update()
        else if (available) void controller.validate()
        else void controller.check()
      }
      return h('button', {
        type: 'button',
        className: 'dshu-button',
        style: { ...styles.action, ...(wide ? styles.actionWide : {}) },
        title: label,
        'aria-label': label,
        disabled: !rescue && (busy || restarting(state) || manual || (succeeded && !canRestart) || state.validation?.status === 'restart-required'),
        onClick: activate,
      },
        updateIcon,
        wide ? h('span', null, label) : null,
        available || rescue ? h('span', { style: styles.actionBadge, 'aria-label': rescue ? 'Rescue mode' : 'Update available' }) : null,
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
      const [promptNotice, setPromptNotice] = React.useState(null)
      const install = state.install
      const busy = state.status === 'checking' || state.check?.status === 'running' || state.validation?.status === 'running' || state.update?.status === 'running'
      const latest = install?.kind === 'source' ? install.latestRef : state.latestVersion
      const rescue = inRescue(state)
      const canRestart = install !== null && install?.kind !== 'npx'
      const restartReport = state.restart
      const originalProfile = restartReport?.profile ?? 'web'
      let statusText = 'Update status has not loaded yet.'
      let statusStyle = styles.intro
      if (state.status === 'checking') statusText = 'Checking for updates…'
      else if (state.validation?.status === 'restart-required' && state.updateAvailable) {
        statusText = RESTART_REQUIRED_MESSAGE
        statusStyle = styles.stateWarn
      } else if (state.validation?.status === 'running') statusText = state.validation.message || 'Installing and starting the candidate separately in supported TUI and Web modes…'
      else if (state.update?.status === 'running') statusText = state.update.message
      else if (state.validation?.status === 'blocked') {
        statusText = 'The candidate has blocking issues. The active DSH installation was not changed.'
        statusStyle = styles.stateError
      } else if (state.validation?.status === 'passed' && state.updateAvailable) {
        statusText = state.validation.warnings?.length > 0
          ? 'The exact candidate passed every blocking check and is ready to apply, but some of your plugins will stay disabled until they are made compatible.'
          : 'The exact candidate passed every isolated startup check, including your profile, and is ready to apply.'
        statusStyle = state.validation.warnings?.length > 0 ? styles.stateWarn : styles.stateGood
      } else if (state.error) {
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
      const restartCard = restartReport === null || restartReport === undefined
        ? null
        : h('div', { style: styles.card, role: rescue || restartReport.status === 'failed' ? 'alert' : 'status' },
            h('p', { style: rescue || restartReport.status === 'failed' ? styles.stateError : restartReport.status === 'succeeded' ? styles.stateGood : styles.intro }, restartReport.message),
            restartReport.error ? h('details', null,
              h('summary', { style: styles.changelogSummary }, `Why "${originalProfile}" did not boot`),
              h('pre', { style: styles.pre }, restartReport.error),
            ) : null,
            restartReport.rescueError ? h('pre', { style: styles.pre }, restartReport.rescueError) : null,
            restartReport.logPath ? h('p', { style: styles.intro }, 'Restart log: ', h('code', { style: styles.code }, restartReport.logPath)) : null,
            h('div', { style: styles.actions },
              rescue && restartReport.recoveryPrompt ? h('button', { type: 'button', className: 'dshu-button', style: styles.primaryButton, onClick: () => {
                void controller.promptModel(restartReport.recoveryPrompt).then(ok => setPromptNotice(ok ? 'Repair prompt placed in the current conversation composer or copied to the clipboard.' : 'Open a conversation before prompting a model.'))
              } }, `Ask AI to repair "${originalProfile}"`) : null,
              rescue ? h('button', { type: 'button', className: 'dshu-button', style: styles.button, disabled: restarting(state), onClick: () => { void controller.restart() } }, `Restart into "${originalProfile}"`) : null,
              !rescue && !restarting(state) ? h('button', { type: 'button', className: 'dshu-button', style: styles.button, onClick: () => { void controller.dismissRestart() } }, 'Dismiss') : null,
            ),
          )
      return h('section', { style: styles.section },
        h('h2', { style: styles.heading }, 'DSH Updater'),
        h('p', { style: styles.intro }, 'Checks the release source that matches the running installation, tests the candidate against a copy of your profile in a headless browser, and restarts DSH after updating — falling back to a minimal rescue profile when your profile does not boot.'),
        restartCard,
        h('div', { style: styles.card },
          h('div', { style: styles.settingRow },
            h('label', { style: styles.settingLabel, htmlFor: 'dsh-updater-release-eligibility' },
              h('span', null, 'Eligible releases'),
              h('span', { style: styles.settingHint }, 'Choose the least stable release class you want. Each option also includes all more stable releases; unknown prerelease labels are never selected.'),
            ),
            h('select', {
              id: 'dsh-updater-release-eligibility',
              style: styles.select,
              value: state.releaseEligibility || 'stable',
              disabled: busy || state.releaseEligibilityStatus?.status === 'saving' || state.releaseEligibilityStatus?.status === 'restart-required',
              onChange: event => { void controller.setReleaseEligibility(event.target.value) },
            }, ...RELEASE_ELIGIBILITY_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label))),
          ),
          state.releaseEligibilityStatus?.status === 'saving' ? h('p', { style: styles.intro, role: 'status' }, 'Saving release eligibility and checking again…') : null,
          state.releaseEligibilityStatus?.status === 'saved' ? h('p', { style: styles.stateGood, role: 'status', 'aria-live': 'polite' }, 'Release eligibility saved. Displayed and installable candidates now use this selection.') : null,
          state.releaseEligibilityStatus?.status === 'restart-required' ? h('p', { style: styles.stateWarn, role: 'status' }, state.releaseEligibilityStatus.error) : null,
          state.releaseEligibilityStatus?.status === 'failed' ? h('p', { style: styles.stateError, role: 'alert' }, state.releaseEligibilityStatus.error) : null,
        ),
        h('div', { style: styles.card },
          h('div', { style: styles.grid },
            h(Fact, { label: 'Installation', value: install?.label }),
            h(Fact, { label: 'Running', value: install?.kind === 'source' ? install.runningRef || state.currentVersion : state.currentVersion, code: true }),
            h(Fact, { label: 'On disk', value: install?.kind === 'source' ? install.currentRef || state.installedVersion : state.installedVersion, code: true }),
            h(Fact, { label: install?.kind === 'source' ? 'Upstream' : `Available (${state.latestTag || 'channel'})`, value: latest, code: true }),
            h(Fact, { label: 'Last checked', value: state.checkedAt ? new Date(state.checkedAt).toLocaleString() : 'Not yet' }),
          ),
          h('p', { style: statusStyle }, statusText),
          changelogView(state),
          state.validation?.checks?.length > 0 ? h('ul', { style: styles.matrix, 'aria-label': 'Candidate validation results' },
            ...state.validation.checks.map(check => h('li', { key: check.id, style: styles.matrixRow },
              h('span', null, check.label),
              h('span', { style: checkStatusLabel(check)[1] }, checkStatusLabel(check)[0]),
            )),
          ) : null,
          state.validation?.blockingIssues?.map(issue => h('pre', { key: issue.check, style: { ...styles.pre, color: 'var(--dsw-alias-state-error-primary)' } }, issue.message)),
          state.validation?.warnings?.map(warning => h('pre', { key: `warning-${warning.check}`, style: styles.pre }, warning.message)),
          state.validation?.candidatePath ? h('p', { style: styles.intro }, 'Isolated candidate: ', h('code', { style: styles.code }, state.validation.candidatePath)) : null,
          promptNotice ? h('p', { style: styles.stateGood }, promptNotice) : null,
          install?.commandPreview ? h('p', { style: styles.intro }, 'Update command after validation: ', h('code', { style: styles.code }, install.commandPreview)) : null,
          install?.restartHint ? h('p', { style: styles.intro }, install.restartHint) : null,
          h('div', { style: styles.actions },
            h('button', { type: 'button', className: 'dshu-button', style: styles.button, disabled: busy, onClick: () => { void controller.check() } }, state.status === 'checking' ? 'Checking…' : 'Check now'),
            canRestart && !rescue ? h('button', { type: 'button', className: 'dshu-button', style: styles.button, disabled: busy || restarting(state), onClick: () => { void controller.restart() } }, restarting(state) ? 'Restarting…' : 'Restart DSH') : null,
            state.updateAvailable && install?.canAutoUpdate && state.validation?.status !== 'passed' && state.validation?.status !== 'restart-required' ? h('button', { type: 'button', className: 'dshu-button', style: styles.primaryButton, disabled: busy, onClick: () => { void controller.validate() } }, state.validation?.status === 'blocked' ? 'Test candidate again' : 'Test candidate') : null,
            state.updateAvailable && install?.canAutoUpdate && state.validation?.status === 'passed' ? h('button', { type: 'button', className: 'dshu-button', style: styles.primaryButton, disabled: busy, onClick: () => { void controller.update() } }, state.update?.status === 'running' ? 'Applying…' : 'Apply verified update') : null,
            (state.validation?.status === 'blocked' || state.validation?.warnings?.length > 0) && state.validation?.repairPrompt ? h('button', { type: 'button', className: 'dshu-button', style: styles.button, disabled: busy, onClick: () => {
              void controller.promptModel().then(ok => setPromptNotice(ok ? 'Update recovery prompt placed in the current conversation composer or copied to the clipboard.' : 'Open a conversation before prompting a model.'))
            } }, 'Ask AI to finish update') : null,
          ),
        ),
        state.update?.output ? h('pre', { style: styles.pre }, state.update.output) : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const controller = createClientController(undefined, {
        promptModel(prompt) {
          const sessions = ctx.get('sessions')
          const conversation = ctx.get('conversation')
          const current = sessions?.list?.getSnapshot?.().current
          if (current === undefined || conversation?.input === undefined) return false
          const actx = sessions.scope(current)
          if (actx === undefined) return false
          conversation.input.for(actx).setDraft(prompt)
          return true
        },
      })
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
