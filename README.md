# dsh-updater

An install-aware update plugin for the DeepSeek Harness Web profile. It checks the release source that matches the running DSH installation, tests the exact candidate separately in every supported TUI/Web mode, and enables the update only after that gate passes.

## Features

- Detects the DSH package and version from the running CLI entry instead of the working directory.
- Recognizes `npx`, global and project-local npm/pnpm/Yarn/Bun installs, and Git source checkouts.
- Uses the npm `latest` dist-tag for stable installations and `next` for prerelease installations.
- Uses the source checkout's configured Git upstream for source runs.
- Shows an update banner in `shell.overlay`, a persistent sidebar footer action, and a complete **Settings → DSH Updater** page.
- Stages each candidate outside the active installation and runs blocking startup checks in every TUI/Web mode the release actually provides before enabling the update action.
- Starts Web on loopback port `0`, waits for the settled `dsh web:` URL, verifies its root response, and shuts the candidate process down cleanly.
- Reports a TUI profile omitted by the release as **Not shipped**; a present-but-crashing TUI, failed candidate install/build, or failed Web startup remains blocking and leaves the active installation unchanged.
- Offers a user-controlled repair prompt with the candidate path and bounded diagnostics; it places the prompt in the current conversation composer (or copies it) but never submits a model request automatically.
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

Restart `dsh web`, then refresh the browser. The updater appears above Settings in the sidebar and as **Settings → DSH Updater**. A client hot reload can arrive before the Host routes after upgrading this plugin; in that case the UI asks for a DSH restart and never reports the missing route as a candidate failure.

## Candidate validation gate

An available release is no longer applied immediately. The workflow is:

1. **Test candidate** downloads the registry tarball, verifies its published integrity digest, and installs that local archive in a private temporary prefix. Source candidates clone the checkout without hardlinks, detach at the exact fetched 40-character commit, and run `pnpm install --frozen-lockfile` plus `pnpm run build` only inside that clone. The GUI reports the active stage while package dependency resolution runs, which can take several minutes on a cold npm cache.
2. The candidate runs with fresh `HOME`, `DSH_HOME`, and `DSH_AGENTS_HOME` directories and without inherited API keys, tokens, passwords, or the active session database.
3. When the release provides a TUI profile, the TUI check starts the real candidate with `dsh --profile tui` and requires non-empty terminal output plus a bounded period in which the process remains alive before controlled shutdown. A specifically reported absent profile is shown as **Not shipped**; any other early exit or silent hang blocks the update.
4. The Web check starts the real candidate with `dsh web --host 127.0.0.1 --port 0`, waits for its settled URL, requests that URL, and requires an HTTP success response.
5. Only a passing result for the exact tarball integrity or source commit enables **Apply verified update**. Package-manager promotion consumes the same verified local archive; source promotion fast-forwards only to the validated commit. A changed target or digest invalidates the previous pass.

Current DSH releases ship built-in Web and headless profiles but no built-in TUI profile. The updater records that exact launcher result as **Not shipped** rather than claiming a TUI pass or permanently blocking otherwise valid Web-only releases. If a future candidate supplies a real `tui` profile, that process must pass the startup smoke.

When validation is blocked, the settings page shows the TUI/Web matrix and an optional **Prompt a model to fix** action. The action asks for confirmation through the button gesture, then places a bounded repair prompt in the current conversation composer; if no conversation is available, it copies the prompt when clipboard access is available. The prompt directs the model to leave the active installation untouched. Revalidation always stages the authoritative release again, so local edits to a downloaded package are diagnostic only and cannot silently become the installed version.

## Supported update plans

| Detected installation | Check source | Action after candidate validation |
| --- | --- | --- |
| `npx` / `npm exec` cache | npm `latest` or `next` dist-tag | Prefetch the exact release with `npm exec`; restart with the exact version shown by the plugin |
| npm global | npm registry | `npm install --global @deepseek-ai/dsh@<version>` |
| pnpm global | npm registry | `pnpm add --global @deepseek-ai/dsh@<version>` |
| Yarn Classic global | npm registry | `yarn global add @deepseek-ai/dsh@<version>` |
| Bun global | npm registry | `bun add --global @deepseek-ai/dsh@<version>` |
| npm project | npm registry | `npm install @deepseek-ai/dsh@<version>` in the owning project |
| pnpm project | npm registry | `pnpm update @deepseek-ai/dsh@<version>` in the owning project |
| Yarn project | npm registry | `yarn add @deepseek-ai/dsh@<version>` in the owning project |
| Bun project | npm registry | `bun update @deepseek-ai/dsh@<version>` in the owning project |
| Git source checkout | configured upstream branch | fast-forward pull, `pnpm install --frozen-lockfile`, and `pnpm run build` |

Yarn and Bun work through the published npm package metadata but are not first-class DSH installation methods. An unrecognized package layout remains checkable but the plugin will not guess an update command.

An update changes files on disk; the currently running Node process is not replaced. Restart DSH after a successful update. The `npx` action prepares the release in npm's execution cache because an ephemeral invocation has no durable installation to replace.

## Source checkout safety

A source update runs only when all of the following are true:

- the running package belongs to a repository containing `.git`, `pnpm-workspace.yaml`, and `apps/cli/package.json`;
- the branch is attached and has an upstream remote branch;
- `git status --porcelain` is empty;
- the local branch is not ahead of its upstream.

The check fetches the configured upstream branch and compares `HEAD...FETCH_HEAD`. Diverged, dirty, detached, and upstream-less checkouts show the available update but disable the update button. Before a source update, the plugin records a repair marker inside the checkout's Git metadata, fast-forwards to the exact validated commit, and verifies `HEAD` again before declaring success. If dependency installation or the Web build fails—or the process stops mid-update—the next check restores repair state, but automatic retry remains disabled if any tracked or untracked source change is present.

## Configuration

The bundle works without configuration. Override its row in `~/.dsh/profiles/web/cordis.patch.yml` when needed:

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

The Host exposes four fixed endpoints:

- `GET /dsh-updater/status`
- `POST /dsh-updater/check`
- `POST /dsh-updater/validate`
- `POST /dsh-updater/update`

All endpoints require a loopback client. Mutating endpoints additionally require a same-origin request. The validation and update endpoints accept no command, version, path, package name, prompt, or environment data from the browser. The Host stages the exact discovered version or Git commit, and update refuses unless that exact target has a passing gate. Candidate startup receives a small environment allowlist plus isolated state directories; it does not inherit provider credentials. Update subprocesses use fixed Host-selected argument arrays, run in an owned process group on POSIX, terminate the complete process tree on cancellation, and omit environment keys containing `KEY`, `SECRET`, `TOKEN`, or `PASSWORD`. Windows invokes active package-manager `.cmd` shims through the system command processor, but no browser-controlled command text reaches it.

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
│   └── client.js    # Overlay, sidebar action, settings page, and repair prompt UX
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
