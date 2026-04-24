# In-App Updates

Sulla Desktop self-updates via an **electron-updater-based pipeline** with a custom "Longhorn" provider that talks to the Sulla upgrade-responder. Users get a notification when a new version is available and can install with one click — no DMG re-download.

## Pieces

| File | Role |
|------|------|
| [`pkg/rancher-desktop/main/update/UpdateManager.ts`](../../pkg/rancher-desktop/main/update/UpdateManager.ts) | Coordinates the update lifecycle — schedules checks, wires `autoUpdater` events, shows the tray badge + UI notification |
| [`pkg/rancher-desktop/main/update/LonghornProvider.ts`](../../pkg/rancher-desktop/main/update/LonghornProvider.ts) | Custom `electron-updater` provider that polls Sulla's upgrade-responder backend (different from the GitHub-releases default provider) |
| [`pkg/rancher-desktop/main/update/lightweightCheck.ts`](../../pkg/rancher-desktop/main/update/lightweightCheck.ts) | Fast "is there an update?" check without running the full `autoUpdater` download pipeline — used in dev builds and for the tray badge |
| [`pkg/rancher-desktop/main/update/MSIUpdater.ts`](../../pkg/rancher-desktop/main/update/MSIUpdater.ts) | Windows-specific wrapper around `NsisUpdater` for MSI installers |
| [`dev-app-update.yml`](../../dev-app-update.yml) | Dev-mode config — points the updater at the dev upgrade-responder so engineers can test the flow without a signed build |
| [`scripts/populate-update-server.ts`](../../scripts/populate-update-server.ts) | CI step that publishes new release metadata to the upgrade-responder |
| [`pkg/rancher-desktop/sulla-upgrade-responder`](../../../sulla-upgrade-responder) | (Separate repo) The backend that serves the "what's the latest version?" JSON |

## How the user experiences it

1. **Background check.** `UpdateManager` polls on an interval (and at launch). Hits the Longhorn provider → upgrade-responder JSON.
2. **New version found.** A notification and/or tray badge surfaces. The user clicks → the update window (`dist/app/updates.html`) opens.
3. **Download + install.** `autoUpdater.downloadUpdate()` pulls the signed artifact. Install happens on quit (`autoUpdater.quitAndInstall()` when the user confirms, or "next launch" if they defer).

## Release channels

Channel selection lives in the Longhorn provider config. Default is `stable`; users can opt into `beta` / `canary` via settings or the CLI (exact wiring lives in the UpdateManager). Each channel has its own version stream on the responder.

## Dev mode

In unpacked / dev builds, `lightweightCheck.ts` runs a short-circuit version compare against the dev upgrade-responder, skipping the full `autoUpdater` flow. This lets engineers verify "the check sees the new version" without producing a signed installer.

To point a dev build at a local upgrade-responder, edit [`dev-app-update.yml`](../../dev-app-update.yml) — the file is ignored in prod builds.

## What the agent can do today

There's no agent-facing `update/*` tool category yet — updates happen automatically in the background, and the user controls installation via the UI. The agent CAN:

- Tell the user their current version and whether the update UI is visible (tray badge).
- Direct them to the Updates window.
- Answer "is there an update available?" by noting the presence of the tray badge or by pointing them at the responder URL.

A future `update/check` or `update/install` agent tool would wrap `UpdateManager.checkForUpdates()` and `autoUpdater.quitAndInstall()` — **not built yet.**

## What the agent should NOT do

- Force-quit or trigger `quitAndInstall` from code paths the user hasn't consented to. Updates require user approval before install.
- Rename or edit release channel configuration without explicit user ask.
- Touch `dev-app-update.yml` unless the user is actively troubleshooting.

## Reference

- UpdateManager entry: `pkg/rancher-desktop/main/update/UpdateManager.ts`
- electron-updater docs: https://www.electron.build/auto-update
- Longhorn / upgrade-responder: `sulla-upgrade-responder` repo
- Release publishing script: `scripts/populate-update-server.ts`
