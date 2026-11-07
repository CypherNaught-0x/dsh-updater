# dsh-updater

An install-aware update plugin for the DeepSeek Harness Web profile. It checks the release source that matches the running DSH installation, tests the exact candidate separately in every supported TUI/Web mode, and provides an AI recovery handoff whose finish line is the newly available version running locally.

## Features

- Detects the DSH package and version from the running CLI entry instead of the working directory.
- Recognizes `npx`, global and project-local npm/pnpm/Yarn/Bun installs, and Git source checkouts.
- Selects the highest npm version allowed by the persisted cumulative release eligibility: **Stable only** (default), **Stable + RC**, **Stable + RC + Beta**, or **All including Alpha**.
- Uses the source checkout's configured Git upstream for source runs and applies the same release eligibility to the fetched commit's DSH package version.
- Rejects unrecognized prerelease classes such as `next`, `preview`, or `nightly` even in the broadest setting.
- Shows release notes before validation or application, preferring changelog fields in the selected npm version metadata and falling back to the matching [DeepSeek Harness GitHub Release](https://github.com/deepseek-ai/deepseek-harness/releases).
- Shows an update banner in `shell.overlay`, a persistent sidebar footer action, and a complete **Settings → DSH Updater** page.
- Stages each candidate outside the active installation and runs blocking startup checks in every TUI/Web mode the release actually provides before enabling the update action.
- Starts Web on loopback port `0`, waits for the settled `dsh web:` URL, verifies its browser-token exchange and authenticated root response, and shuts the candidate process down cleanly.
- Reports a TUI profile omitted by the release as **Not shipped**; a present-but-crashing TUI, failed candidate install/build, or failed Web startup remains blocking and leaves the active installation unchanged.
- Offers a user-controlled AI recovery prompt with the candidate path, installation context, and bounded diagnostics; the agent is directed to fix local configuration or plugin compatibility first, escalate to a DSH release fix only when necessary, apply the working update, restart DSH, and verify the new version is actually running.
- Reports check, validation, and update progress, successful completion, up-to-date results, and request failures immediately in the GUI.
- Runs only fixed validation and update plans selected by the Host; the browser cannot submit commands or paths.
- Rejects non-loopback transport and cross-origin update actions. Trusted loopback reverse proxies may allow exact browser origins with `DSH_UPDATER_TRUSTED_ORIGINS`; arbitrary rebound hostnames remain denied.
- Refuses to pull a dirty, ahead, detached, or upstream-less source checkout.
- Scrubs secret-bearing environment variables from update subprocesses and bounds retained output.

## Requirements

- DeepSeek Harness with the Web profile
- `pnpm` for plugin installation
- The package manager that owns the current DSH installation
- For source checkouts: Git, pnpm, a configured upstream branch, and a clean checkout

## Installation

From this checkout:

```sh
dsh plugin --profile web add ./dsh-updater
```

After publication:

```sh
dsh plugin --profile web add dsh-updater
```

Restart `dsh web`, then refresh the browser. The updater appears above Settings in the sidebar and as **Settings → DSH Updater**. A client hot reload can arrive before the Host routes after upgrading this plugin; in that case candidate validation and release eligibility controls ask for a DSH restart instead of reporting the missing Host route as an update or settings failure.

## Candidate validation gate

An available release is no longer applied immediately. The workflow is:

1. The update banner and settings page show release notes before validation or application. The Host uses a non-empty `releaseNotes`, `release_notes`, `changelog`, `dsh.releaseNotes`, or `dsh.changelog` field from the selected npm version; when npm has none, it requests the matching `dsh-v<version>` GitHub Release. Missing or temporarily unavailable notes never block the safety gate, and the GitHub Releases link remains available.
2. **Test candidate** downloads the registry tarball, verifies its published integrity digest, and installs that local archive in a private temporary prefix. Source candidates clone the checkout without hardlinks, detach at the exact fetched 40-character commit, and run `pnpm install --frozen-lockfile` plus `pnpm run build` only inside that clone. The GUI reports the active stage while package dependency resolution runs, which can take several minutes on a cold npm cache.
3. The candidate runs with fresh `HOME`, `DSH_HOME`, and `DSH_AGENTS_HOME` directories and without inherited API keys, tokens, passwords, or the active session database.
4. When the release provides a TUI profile, the TUI check starts the real candidate with `dsh --profile tui` and requires non-empty terminal output plus a bounded period in which the process remains alive before controlled shutdown. A specifically reported absent profile is shown as **Not shipped**; any other early exit or silent hang blocks the update.
5. The Web check starts the real candidate with `dsh web --host 127.0.0.1 --port 0`, waits for its complete browser-token URL instead of probing the intentionally unauthorized bare root, exchanges the token for the session cookie, and requires the authenticated root to return non-empty HTTP 200 HTML.
6. Only a passing result for the exact tarball integrity or source commit enables **Apply verified update**. Package-manager promotion consumes the same verified local archive; source promotion fast-forwards only to the validated commit. A changed target or digest invalidates the previous pass.

Current DSH releases ship built-in Web and headless profiles but no built-in TUI profile. The updater records that exact launcher result as **Not shipped** rather than claiming a TUI pass or permanently blocking otherwise valid Web-only releases. If a future candidate supplies a real `tui` profile, that process must pass the startup smoke.

When validation is blocked, the settings page shows the TUI/Web matrix and an optional **Ask AI to finish update** action. The action asks for confirmation through the button gesture, then places a bounded recovery prompt in the current conversation composer; if no conversation is available, it copies the prompt when clipboard access is available. The agent owns the update end to end: diagnose local configuration, profile, updater, and plugin compatibility before blaming the release; publish and rediscover a replacement only when the candidate itself is defective; apply the working target to the installation that owns the running process; restart DSH; and confirm the running version matches the selected package version or validated source commit. Placing the prompt transfers the task but does not mark recovery complete. Revalidation always stages the authoritative release again, so local edits to a downloaded package remain diagnostic only.

## Supported update plans

| Detected installation | Check source | Action after candidate validation |
| --- | --- | --- |
| `npx` / `npm exec` cache | Highest eligible npm version | Prefetch the exact release with `npm exec`; restart with the exact version shown by the plugin |
| npm global | Highest eligible npm version | `npm install --global @deepseek-ai/dsh@<version>` |
| pnpm global | Highest eligible npm version | `pnpm add --global @deepseek-ai/dsh@<version>` |
| Yarn Classic global | Highest eligible npm version | `yarn global add @deepseek-ai/dsh@<version>` |
| Bun global | Highest eligible npm version | `bun add --global @deepseek-ai/dsh@<version>` |
| npm project | Highest eligible npm version | `npm install @deepseek-ai/dsh@<version>` in the owning project |
| pnpm project | Highest eligible npm version | `pnpm update @deepseek-ai/dsh@<version>` in the owning project |
| Yarn project | Highest eligible npm version | `yarn add @deepseek-ai/dsh@<version>` in the owning project |
| Bun project | Highest eligible npm version | `bun update @deepseek-ai/dsh@<version>` in the owning project |
| Git source checkout | Eligible version at configured upstream head | fast-forward pull, `pnpm install --frozen-lockfile`, and `pnpm run build` |

Yarn and Bun work through the published npm package metadata but are not first-class DSH installation methods. An unrecognized package layout remains checkable but the plugin will not guess an update command.

The normal **Apply verified update** action changes files on disk; the currently running Node process is not replaced, so restart DSH afterward. An AI recovery handoff has a stricter finish line: it must carry the operation through that restart and verify the updater's **Running** value and `dsh --version` match the selected target. The `npx` action prepares the release in npm's execution cache because an ephemeral invocation has no durable installation to replace.

## Source checkout safety

A source update runs only when all of the following are true:

- the running package belongs to a repository containing `.git`, `pnpm-workspace.yaml`, and `apps/cli/package.json`;
- the branch is attached and has an upstream remote branch;
- `git status --porcelain` is empty;
- the local branch is not ahead of its upstream.

The check fetches the configured upstream branch and compares `HEAD...FETCH_HEAD`. Diverged, dirty, detached, and upstream-less checkouts show the available update but disable the update button. Before a source update, the plugin records a repair marker inside the checkout's Git metadata, fast-forwards to the exact validated commit, and verifies `HEAD` again before declaring success. If dependency installation or the Web build fails—or the process stops mid-update—the next check restores repair state, but automatic retry remains disabled if any tracked or untracked source change is present.

## Configuration

The **Eligible releases** dropdown in **Settings → DSH Updater** is persisted in `$DSH_HOME/dsh-updater.json` (or `~/.dsh/dsh-updater.json`). **Stable only** is the default. Eligibility is cumulative: RC includes stable, Beta includes RC and stable, and Alpha includes all four recognized classes. Changing it immediately discards any staged candidate validation and performs a fresh discovery; the newly selected exact candidate must pass the full safety gate before application. Invalid stored values and unknown prerelease labels fail closed to stable-only eligibility.

The bundle works without composition configuration. Override its row in `~/.dsh/profiles/web/cordis.patch.yml` when needed:

```yaml
- id: dsh-updater
  config:
    checkIntervalMinutes: 360
    registryUrl: https://registry.npmjs.org/
    requestTimeoutMs: 15000
    candidateInstaller: auto
    candidateTimeoutMinutes: 20
    startupTimeoutSeconds: 60
    updateTimeoutMinutes: 20
```

| Field | Default | Purpose |
| --- | ---: | --- |
| `checkIntervalMinutes` | `360` | Host-side interval between checks; minimum 5 minutes |
| `registryUrl` | npm registry | HTTPS registry used for package installations |
| `requestTimeoutMs` | `15000` | Registry and Git check timeout |
| `candidateInstaller` | `auto` | Prefer pnpm for fast, complete candidate staging and fall back to npm when pnpm is unavailable; accepts `auto`, `pnpm`, or `npm` |
| `candidateTimeoutMinutes` | `20` | Per-command timeout while staging, installing, or building a candidate |
| `startupTimeoutSeconds` | `60` | Maximum wait for each candidate TUI or Web startup check |
| `updateTimeoutMinutes` | `20` | Per-command timeout for the active-installation update plan |

The browser refreshes the Host status every minute, whenever the page becomes visible, and every two seconds while candidate validation is running so the active stage remains visible. Only the Host performs release checks and update commands.

## Security model

The Host exposes fixed endpoints:

- `GET /dsh-updater/status`
- `POST /dsh-updater/check`
- `POST /dsh-updater/validate`
- `POST /dsh-updater/update`
- `POST /dsh-updater/release-eligibility/{stable|rc|beta|alpha}` (four exact registered routes)

All endpoints require a loopback client. Mutating endpoints additionally require a same-origin request. The validation and update endpoints accept no command, version, path, package name, prompt, or environment data from the browser. Release eligibility is selected only through one of four fixed no-body routes. The Host stages the exact eligible discovered version or Git commit, and update refuses unless that exact target has a passing gate. Registry and GitHub changelog text is capped at 64 KiB and rendered as plain text rather than HTML; it never controls an update command. Candidate startup receives a small environment allowlist plus isolated state directories; it does not inherit provider credentials. Update subprocesses use fixed Host-selected argument arrays, run in an owned process group on POSIX, terminate the complete process tree on cancellation, and omit environment keys containing `KEY`, `SECRET`, `TOKEN`, or `PASSWORD`. Windows invokes active package-manager `.cmd` shims through the system command processor, but no browser-controlled command text reaches it.

Candidate execution is isolated from the active installation's state directories, environment credentials, package files, and source working tree; it is not an OS security sandbox. Candidate code still runs as the updater's operating-system user and must come from a trusted DSH registry or Git upstream.

This protection assumes the normal direct loopback DSH Web server. Do not expose the updater through a reverse proxy that makes remote traffic appear to originate from loopback; the plugin does not add user authentication to DSH.

## Disable or uninstall

```sh
dsh plugin --profile web remove dsh-updater
```

Alternatively, override the `dsh-updater` row with `disabled: true` in the Web profile patch.

## Development

The plugin ships plain JavaScript and requires no build step:

```text
dsh-updater/
├── lib/
│   ├── index.js     # Host detection, gate state, update plans, and HTTP endpoints
│   ├── candidate.js # Isolated staging plus TUI/Web startup smoke checks
│   └── client.js    # Overlay, sidebar action, settings page, and AI recovery UX
├── test/
├── cordis.patch.yml
└── package.json
```

Install dependencies and run the checks:

```sh
pnpm install
pnpm test
```

To test the current checkout in DSH:

```sh
dsh plugin --profile web add ./dsh-updater
```

## License

MIT
