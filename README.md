# dsh-updater

An install-aware update plugin for the DeepSeek Harness Web profile. It checks the release source that matches the running DSH installation, notifies the user in the GUI, and offers a safe one-click update when that installation can be updated in place.

## Features

- Detects the DSH package and version from the running CLI entry instead of the working directory.
- Recognizes `npx`, global and project-local npm/pnpm/Yarn/Bun installs, and Git source checkouts.
- Uses the npm `latest` dist-tag for stable installations and `next` for prerelease installations.
- Uses the source checkout's configured Git upstream for source runs.
- Shows an update banner in `shell.overlay`, a persistent sidebar footer action, and a complete **Settings → DSH Updater** page.
- Reports manual-check progress, successful up-to-date results, and request failures immediately in the GUI.
- Runs only a fixed update plan selected by the Host; the browser cannot submit commands or paths.
- Rejects non-loopback requests and cross-origin update actions.
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

Restart `dsh web`, then refresh the browser. The updater appears above Settings in the sidebar and as **Settings → DSH Updater**.

## Supported update plans

| Detected installation | Check source | One-click action |
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

The check fetches the configured upstream branch and compares `HEAD...FETCH_HEAD`. Diverged, dirty, detached, and upstream-less checkouts show the available update but disable the update button. Before a source update, the plugin records a repair marker inside the checkout's Git metadata. If the pull succeeds but dependency installation or the Web build fails—or the process stops mid-update—the next check restores repair state and retries the needed pull/install/build steps safely.

## Configuration

The bundle works without configuration. Override its row in `~/.dsh/profiles/web/cordis.patch.yml` when needed:

```yaml
- id: dsh-updater
  config:
    checkIntervalMinutes: 360
    registryUrl: https://registry.npmjs.org/
    requestTimeoutMs: 15000
    updateTimeoutMinutes: 20
```

| Field | Default | Purpose |
| --- | ---: | --- |
| `checkIntervalMinutes` | `360` | Host-side interval between checks; minimum 5 minutes |
| `registryUrl` | npm registry | HTTPS registry used for package installations |
| `requestTimeoutMs` | `15000` | Registry and Git check timeout |
| `updateTimeoutMinutes` | `20` | Per-command timeout for an update plan |

The browser also refreshes the Host status every minute and whenever the page becomes visible. Only the Host performs release checks and update commands.

## Security model

The Host exposes three fixed endpoints:

- `GET /dsh-updater/status`
- `POST /dsh-updater/check`
- `POST /dsh-updater/update`

All endpoints require a loopback client. Mutating endpoints additionally require a same-origin request. The update endpoint accepts no command, version, path, package name, or environment data from the browser; it rechecks the authoritative source and substitutes the exact discovered version into a Host-selected argument array. Update subprocesses use fixed Host-selected argument arrays, run in an owned process group on POSIX, terminate the complete process tree on cancellation, and omit environment keys containing `KEY`, `SECRET`, `TOKEN`, or `PASSWORD`. Windows invokes package-manager `.cmd` shims through the system command processor, but no browser-controlled command text reaches it.

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
│   ├── index.js   # Host detection, checks, update plans, and HTTP endpoints
│   └── client.js  # Overlay, sidebar action, and settings page
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
