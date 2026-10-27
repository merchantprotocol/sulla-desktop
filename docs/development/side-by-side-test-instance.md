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
| Desktop chat/tools API | `main/chatCompletionsServer.ts` (`3000`) | Listener and token-file metadata use `variantPort(3000)` (`4000` for test). |
| Command, terminal and credential servers | `main/commandServer/httpCommandServer.ts` (`6107`), `main/terminalServer.ts` (`6108`), `main/credentialServer/httpCredentialHelperServer.ts` (`6109`) | Listeners, state files, menu/extension callers and the renderer terminal URL use `variantPort()` (`7107`–`7109` for test). Bind failures reject startup with the exact host, port and OS error code. |
| Sulla Accounts | `backend/sullaRuntimeBackend.ts`; `main/sullaAccountsClient.ts` (`3020`) | The host publication, public URL and Desktop client use `variantPort(3020)` (`4020` for test); the isolated container still listens internally on `3020`. |
| Vault and Files encrypted material / macOS Keychain | `sullaRuntimeBackend.ts`; `main/vaultBootstrapProcess.ts`; `main/vaultTls.ts`; `vault-broker/index.ts` | Files live below variant app/config paths and `safeStorage` uses the test bundle identity. The Vault host publication and every Desktop caller use `variantPort(30135)` (`31135` for test). Production app-group File Provider/Finder extensions are not embedded in test packages. |
| MCP/tools API and host relay | `main/chatCompletionsServer.ts:1294-1309`; `agent/services/AgentContainerLauncher.ts:91-104`; `main/sullaFilesSourceGateway.ts:92` | Tools/Files endpoints and relay URLs use the same +1000 port mapping. |
| Deep-link handler | `packaging/electron-builder.yml:65-72`; `background.ts:122-132` | Test package has no protocol declaration and never calls `setAsDefaultProtocolClient`, so it cannot take over `sulla://`. |
| Auto-updater | `packaging/electron-builder.yml:56-64`; `background.ts:622`; `main/update/index.ts` | Test packaging removes the publish feed and startup passes `enabled=false`. |
| Login item | `background.ts:268,1615`; `main/audio-driver/init.ts:446-452` | Test flavour never reads/writes the production login item. |
| Cloud device registration | `main/deviceIdentity.ts:29-33,109-128` | Device identity is stored in the variant `~/.sulla-test/device-id`, producing a separate Cloud device registration. |
| Native app-group extensions | `main/sullaAppGroup.ts:16`; `scripts/package.ts:248-284`; `native/SullaFileProvider/**` | Test packages omit Finder Sync, File Provider and its helper rather than sharing production bundle/app-group IDs. |

## Host-global resource audit

The test flavour treats host integration as opt-out-by-construction: a feature that cannot use a variant-owned location is skipped with a log message. It never falls back to the production location.

| Host-global resource | Production behaviour | Test-variant behaviour |
|---|---|---|
| `~/.docker/config.json` and Docker context `sulla-desktop` | Maintains the Desktop context and may select it while the runtime is active. | Docker context setup, cleanup and credential-helper configuration are skipped. The defensive `DockerDirManager` instance points at `~/.docker-test` and uses context name `sulla-desktop-test`, so an accidental caller still cannot read or rewrite production Docker configuration. |
| `~/.docker/cli-plugins` and CLI integration links | Installs bundled CLI/plugin symlinks and removes managed links on shutdown/reset. | `getIntegrationManager()` returns a logged no-op; no links are inspected, created or removed. The packaged `sulla`/`sulla-daemon` scripts (including `/tmp/sulla-tools.sock` and `/tmp/sulla-daemon.pid`) are consequently not installed or launched by the test app. |
| Docker credential helper routing (`credsStore` / `credHelpers`) | Ensures the Sulla helper is represented in Docker configuration and serves credentials on the production credential-server port. | Host Docker helper configuration is skipped. The isolated credential server still uses `variantPort(6109)` for internal test-runtime callers. |
| Shell profiles and global PATH links (`.zshrc`, `.bashrc`, `.bash_profile`, `.profile`, fish config, `/usr/local/bin`) | Applies the selected automatic PATH strategy. | `setPathManager()` always installs `ManualPathManager`; profile/link writes and removals are skipped and logged. |
| Login item and `sulla://` protocol handler | Registers the production app when enabled. | Both capabilities are false in `appVariant`; test startup, settings changes and reset never register or remove the production handlers. |
| Finder Sync, File Provider, Finder defaults, badge xattrs and production app group | Embeds/registers native extensions and uses the production app-group relay. | Native extensions are omitted. Registration reports unsupported, startup skips it, Finder defaults and badge xattrs are skipped, and the fallback relay lives below the variant `appHome`. |
| Audio driver, launch daemon, `/usr/local/bin/audio-driver`, `/tmp/audio-driver.sock`, and system audio settings | Initializes the host driver and may install/start/stop it or change audio routing. | Audio/Capture Studio host integration is not initialized or shut down. Legacy connect/disconnect calls fail closed and status returns disabled without probing shared files or sockets. |
| Claude Code host memory | Rewrites `~/.claude/CLAUDE.md` with the generated Sulla prompt. | Writes only `~/.claude-test/CLAUDE.md`; the production Claude directory is not read or changed. |
| Codex host credentials/config | Stores CLI OAuth material below `~/.codex`; generated agent configuration is guest-scoped. | Host OAuth material uses `~/.codex-test`; the test VM has its own guest home/data disk. Production `~/.codex` is not read or changed. |
| `~/.gitconfig`, `~/.ssh`, and `~/.kube` | Git identity may be read to render agent defaults; Desktop has no write path for these locations. | The test flavour has no writer for these resources. Git identity discovery is read-only; SSH and Kubernetes user configuration are neither imported nor changed. |
| Per-user deployment profiles (`~/Library/Preferences/io.sulla.desktop.profile.*` or XDG equivalents) | Reads production per-user defaults and locked settings after system profiles. | Per-user production profiles are not read. System administrator deployment profiles remain readable policy inputs; test-local settings remain under variant paths. |
| macOS Keychain / Electron `safeStorage` | Encrypts secrets under the production bundle/application identity. | Separate bundle ID, Electron `userData`, database and `safeStorage` identity prevent the test app from addressing production encrypted state; no production-named Keychain item writer exists. |
| Host temporary directories and runtime sockets | Uses `/tmp/sulla-desktop`, production runtime sockets, and production File Provider app-group relay. | Shared host temp root is `/tmp/sulla-desktop-test`; runtime sockets are below the variant runtime directory and File Provider fallback relay is below variant `appHome`. Guest-only `/tmp` and `/var/run/docker.sock` paths live inside the test VM's separate disk/daemon. |
| Docker Compose project inside the VM | Uses project `sulla`. | Uses `appVariant.composeProject` (`sulla-test`) for boot and on-demand service commands. Although the VM is already isolated, this prevents fallback to the production project name. |

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
