# Side-by-side Sulla Desktop test instance

`SULLA_DESKTOP_VARIANT=test` is a build-time flavour. It produces **Sulla Desktop Test** with one identity object in `pkg/sulla-desktop/utils/appVariant.ts`; the production defaults are unchanged.

## Collision audit

Locations below identify the production collision and the test-flavour isolation:

| Surface | Production source | Isolation |
|---|---|---|
| Bundle/application identity | `packaging/electron-builder.yml:10-12` | `scripts/package.ts` changes product name to `Sulla Desktop Test` and bundle ID to `io.sulla.desktop.test`. |
| Single-instance lock | `background.ts:118` | Electron's lock follows the variant's separate application/user-data identity. |
| Electron name and user data | `background.ts:103-109`; `pkg/sulla-desktop/utils/paths.ts:82-113` | Test paths have `-test`; Electron userData is under `sulla-desktop-test/electron`. |
| Sulla home/config/code mirror | `pkg/sulla-desktop/utils/paths.ts:150-159` | `~/sulla-test`, `~/.sulla-test`, and `~/.sulla-desktop-test`. |
| Runtime VM, disk, sockets and host state | `pkg/sulla-desktop/backend/sullaRuntime/artifacts.ts:24-42`; `dataDisk.ts:19-25`; `background.ts:101-104` | `~/Library/Application Support/Sulla-test/runtime`, including its own `data.img`, control/guest/Docker sockets and inherited `SULLA_RUNTIME_DIR`. The test binary cannot address the production runtime directory. |
| Docker Compose project, containers and volumes | `pkg/sulla-desktop/backend/sullaRuntimeBackend.ts:1069-1076,1630,1691,1924`; `assets/sulla-docker-compose.yaml:9-139` | Project is `sulla-test`; its containers and volumes live on the test VM's separate data disk. Explicit container names are harmless because Docker daemons are separate. |
| PostgreSQL, Redis, runtimes, tools, Files, workflows and relay ports | `assets/sulla-docker-compose.yaml:13,69,89,109,128`; `sullaRuntimeBackend.ts:1266,1300,1358,1432` | Test host publications and every Desktop caller use the production port plus 1000 (`31116`–`31126`). |
| Vault and Files encrypted material / macOS Keychain | `sullaRuntimeBackend.ts:790-899`; `main/vaultBootstrapProcess.ts:60-61,196`; `main/sullaFilesBootstrapProcess.ts:44-45,65-66` | Files live below variant app/config paths and `safeStorage` uses the test bundle identity, so test ciphertext/keychain material is not the production app's. Production app-group File Provider/Finder extensions are not embedded in test packages. |
| MCP/tools API and host relay | `main/chatCompletionsServer.ts:1294-1309`; `agent/services/AgentContainerLauncher.ts:91-104`; `main/sullaFilesSourceGateway.ts:92` | Tools/Files endpoints and relay URLs use the same +1000 port mapping. |
| Deep-link handler | `packaging/electron-builder.yml:65-72`; `background.ts:122-132` | Test package has no protocol declaration and never calls `setAsDefaultProtocolClient`, so it cannot take over `sulla://`. |
| Auto-updater | `packaging/electron-builder.yml:56-64`; `background.ts:622`; `main/update/index.ts` | Test packaging removes the publish feed and startup passes `enabled=false`. |
| Login item | `background.ts:268,1615`; `main/audio-driver/init.ts:446-452` | Test flavour never reads/writes the production login item. |
| Cloud device registration | `main/deviceIdentity.ts:29-33,109-128` | Device identity is stored in the variant `~/.sulla-test/device-id`, producing a separate Cloud device registration. |
| Native app-group extensions | `main/sullaAppGroup.ts:16`; `scripts/package.ts:248-284`; `native/SullaFileProvider/**` | Test packages omit Finder Sync, File Provider and its helper rather than sharing production bundle/app-group IDs. |

## Build and launch from a branch

Do not use the primary checkout and do not install the test app in `/Applications`:

```bash
cd ~/Sites/sulla
git clone https://github.com/merchantprotocol/sulla-desktop.git sulla-desktop-test
cd sulla-desktop-test
git fetch origin
git switch --detach origin/<branch>
yarn install --frozen-lockfile
SULLA_DESKTOP_VARIANT=test yarn build
SULLA_DESKTOP_VARIANT=test yarn package
open "dist/mac-arm64/Sulla Desktop Test.app"
```

Use `dist/mac/Sulla Desktop Test.app` for an Intel package if electron-builder selects that output directory. Keep `SULLA_DESKTOP_VARIANT=test` on both build and package commands; otherwise the compiled identity and package identity intentionally do not match.

## Cost and rollback

The default second VM reserves 2 GiB RAM (`pkg/sulla-desktop/config/settings.ts:110`) while running, plus service/container memory. Its data disk is a separate 64 GiB sparse file (`src/runtime-host/macos/README.md:24`), so initial physical disk use is small and grows with images, volumes and databases; the packaged app and bundled assets add their normal on-disk size.

Rollback is simply: quit **Sulla Desktop Test**, then move its `.app` and the separate test clone to Trash. If test state must also be removed, do that manually only after confirming these exact test-only paths: `~/Library/Application Support/Sulla-test`, `~/Library/Application Support/sulla-desktop-test`, `~/Library/{Caches,Logs,Preferences}/sulla-desktop-test`, `~/sulla-test`, `~/.sulla-test`, and `~/.sulla-desktop-data-test`. None is read by production.
