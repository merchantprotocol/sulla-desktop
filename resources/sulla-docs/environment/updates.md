# In-App Updates

Sulla Desktop self-updates via an **electron-updater-based pipeline** with a custom "Longhorn" provider that talks to the Sulla upgrade-responder. Users get a notification when a new version is available and can install with one click — no DMG re-download.

## Pieces

| File | Role |
|------|------|
| [`pkg/sulla-desktop/main/update/UpdateManager.ts`](../../../pkg/sulla-desktop/main/update/UpdateManager.ts) | Coordinates the update lifecycle — schedules checks, wires `autoUpdater` events, shows the tray badge + UI notification |
| [`pkg/sulla-desktop/main/update/LonghornProvider.ts`](../../../pkg/sulla-desktop/main/update/LonghornProvider.ts) | Custom `electron-updater` provider that polls Sulla's upgrade-responder backend (different from the GitHub-releases default provider) |
| [`pkg/sulla-desktop/main/update/lightweightCheck.ts`](../../../pkg/sulla-desktop/main/update/lightweightCheck.ts) | Fast "is there an update?" check without running the full `autoUpdater` download pipeline — used in dev builds and for the tray badge |
| [`pkg/sulla-desktop/main/update/MSIUpdater.ts`](../../../pkg/sulla-desktop/main/update/MSIUpdater.ts) | Windows-specific wrapper around `NsisUpdater` for MSI installers |
| [`dev-app-update.yml`](../../../dev-app-update.yml) | Dev-mode config — points the updater at the dev upgrade-responder so engineers can test the flow without a signed build |
| [`scripts/populate-update-server.ts`](../../../scripts/populate-update-server.ts) | CI step that publishes new release metadata to the upgrade-responder |
| Upgrade responder | External backend configured by `upgradeServer`; not a directory under Desktop |

## How the user experiences it

1. **Background check.** `UpdateManager` polls on an interval (and at launch). Hits the Longhorn provider → upgrade-responder JSON.
2. **New version found.** A notification and/or tray badge surfaces. The user clicks → the update window (`dist/app/updates.html`) opens.
3. **Download + install.** `autoUpdater.downloadUpdate()` pulls the signed artifact. Install is requested through `UpdateManager.installUpdate()` after the download completes. `autoInstallOnAppQuit` is false; ordinary quit does not install automatically.

## Responder configuration

`LonghornProviderOptions` contains `upgradeServer`, GitHub `owner`/`repo`, and
optional `vPrefixedTagName`. The provider selects versions from responder tags;
there is no stable/beta/canary channel-selection setting wired in this provider.

## Dev mode

Every check first uses `lightweightCheck.ts`, in both development and packaged builds. Unpacked builds stop after this version comparison; packaged builds continue into electron-updater when an update is available. This lets engineers verify "the check sees the new version" without producing a signed installer.

To point a dev build at a local upgrade-responder, edit [`dev-app-update.yml`](../../../dev-app-update.yml) — the file is ignored in prod builds.

## What the agent can do today

There's no agent-facing `update/*` tool category yet — updates happen automatically in the background, and the user controls installation via the UI. The agent CAN:

- Explain the update flow. A version or tray-state claim needs actual runtime evidence; this source document cannot establish either.
- Direct them to the Updates window.
- Direct the user to a manual check in the Updates UI. A tray badge is not a substitute for checking the current update state.

A future `update/check` or `update/install` agent tool would wrap `UpdateManager.checkForUpdates()` and `autoUpdater.quitAndInstall()` — **not built yet.**

## What the agent should NOT do

- Force-quit or trigger `quitAndInstall` from code paths the user hasn't consented to. Updates require user approval before install.
- Rename or edit release channel configuration without explicit user ask.
- Touch `dev-app-update.yml` unless the user is actively troubleshooting.

## Reference

- UpdateManager entry: `pkg/sulla-desktop/main/update/UpdateManager.ts`
- electron-updater docs: https://www.electron.build/auto-update
- Longhorn / upgrade-responder: `sulla-upgrade-responder` repo
- Release publishing script: `scripts/populate-update-server.ts`
