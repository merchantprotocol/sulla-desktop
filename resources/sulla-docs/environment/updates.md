# In-App Updates

Sulla Desktop self-updates with **electron-updater's generic provider**, reading the update feed at `https://releases.sulladesktop.com/channels/latest/latest-mac.yml`. Release zips live next to it in the releases bucket (`releases/v<version>/`), not on GitHub (they are larger than GitHub's 2 GiB asset limit). Users get a notification when a new version is available and can install with one click.

## Pieces

| File | Role |
|------|------|
| [`pkg/sulla-desktop/main/update/UpdateManager.ts`](../../../pkg/sulla-desktop/main/update/UpdateManager.ts) | Coordinates the update lifecycle — schedules checks, wires `autoUpdater` events, shows the tray badge + UI notification |
| [`pkg/sulla-desktop/main/update/index.ts`](../../../pkg/sulla-desktop/main/update/index.ts) | Builds the `MacUpdater` from `app-update.yml` (generic provider) and wires its events |
| [`pkg/sulla-desktop/main/update/lightweightCheck.ts`](../../../pkg/sulla-desktop/main/update/lightweightCheck.ts) | Fast "is there an update?" check that reads the same `latest-mac.yml` without the download pipeline — used in dev builds and for the tray badge |
| [`packaging/electron-builder.yml`](../../../packaging/electron-builder.yml) | `publish` block: the feed URL. electron-builder writes it into the app as `app-update.yml` |
| [`dev-app-update.yml`](../../../dev-app-update.yml) | The same feed settings for unpacked (`yarn dev`) builds |
| [`docs/releasing.md`](../../../docs/releasing.md) | How CI uploads zips and promotes the feed (`.github/workflows/package.yaml`, `update-feed.yaml`, `scripts/release/`) |

## How the user experiences it

1. **Background check.** `UpdateManager` polls on an interval (and at launch) and reads `latest-mac.yml` from the feed.
2. **New version found.** A notification and/or tray badge surfaces. The user clicks → the update window (`dist/app/updates.html`) opens.
3. **Download + install.** electron-updater downloads the signed zip for the Mac's architecture from `releases.sulladesktop.com` (differentially, using `.blockmap` files, when it can). Install is requested through `UpdateManager.installUpdate()` after the download completes. `autoInstallOnAppQuit` is false; ordinary quit does not install automatically.

## Feed configuration

The feed is `channels/latest/` in the releases bucket. A new version reaches it
only when its GitHub Release is published (the Update feed workflow promotes
it). There is one channel, `latest`; prereleases are not promoted.

## Dev mode

Every check first uses `lightweightCheck.ts`, in both development and packaged builds. Unpacked builds stop after this version comparison; packaged builds continue into electron-updater when an update is available. This lets engineers verify "the check sees the new version" without producing a signed installer.

To point a dev build at another feed, edit `url` in [`dev-app-update.yml`](../../../dev-app-update.yml) — the file is ignored in prod builds.

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
- Release process and bucket layout: `docs/releasing.md`
- Current release manifest: https://releases.sulladesktop.com/channels/latest/latest.json
