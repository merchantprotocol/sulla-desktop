# Linux runtime adapter (draft)

The selected Linux x64 host is a user-installed **rootless Docker Engine** with
Docker Compose v2.17 or newer. The app must use a local Unix socket; rootful
and remote contexts are rejected. The app must not start/stop the user's
daemon. `LinuxDockerHost` owns only a `sulla-desktop-*` Compose project and its
`down` operation never removes volumes. Runtime state directories are private
(0700) under Electron's app-data directory.

## Backend (implemented)

`LinuxDockerBackend` (`linuxVmBackend.ts`) is the `VMBackend` the factory returns
on `linux` (`backend === 'linux-docker'`, never `sulla-runtime`). `start()`
verifies the rootless prerequisites, prepares the private app-data paths, writes
`docker-compose.json` (`LinuxRuntimeComposeBuilder`) and runs the shared
`compose up --detach --wait`; `stop()` runs `down --remove-orphans` without
volumes. Lifecycle calls are serialized and failures leave state `ERROR` with
`getFailureDetails()` data.

`LinuxContainerExecutor` (`linuxContainerExecutor.ts`) is the `VMExecutor`:
`execCommand`/`spawn` use `docker exec` in the single `sulla-desktop-*`
runtime container; `readFile`/`writeFile` stream through stdin/stdout (atomic
write, requested mode); `copyFileIn/Out` use `docker cp`. Env values are passed
by name so they never appear in the host process list.

Persistent mounts (host app-data -> container): `state`->`/mnt/data`,
`files`->`/mnt/sulla-files`, function catalog/invocations ->
`/mnt/sulla-functions/*`, `backups`->`/mnt/backups`, and a named `worktrees`
volume ->`/mnt/worktrees`. Only paths under the app-owned runtime root can be
bind-mounted; the Docker socket, privileged mode, host namespaces and non-loopback
ports are never configured, and capabilities are dropped to the file-writing set.

Explicitly unsupported on Linux: `reset()` (throws; Sulla never removes volumes
automatically) and `del()` only removes the container (data is kept).
`ipAddress` is `127.0.0.1` while running.

## Isolation model (no VM)

The user's **rootless Docker Engine is the outer host**. The runtime container
is only the command *executor* (shell, git, node, python, provider CLIs); it has
no engine socket and cannot start containers. Postgres, Redis and the function
runtimes are **sibling containers** on the same rootless engine, in their own
Compose project (`sulla-desktop-linux-services`). Isolation is what rootless
Docker provides (user namespaces, dropped capabilities, loopback-only ports),
not hypervisor isolation. Docker's default seccomp/AppArmor apply; a kernel
bug is a container escape, unlike a VM.

## Managed services (`linuxManagedServices.ts`)

`managesSullaServices` is true only when the services seam is wired
(production `create()` wires it), so `background.ts` waits for
`sulla-managed-services-ready`. `LinuxServicesComposeBuilder` derives the
compose file from the same `sulla-docker-compose.yaml` the macOS backend uses
and reuses `sullaComposeMounts.findHostBindMounts` (no host paths, no socket),
translating the two function directories to app-owned host dirs.
`LinuxManagedServices` brings up `postgres` + `redis`, health-gates them
(`first-run-ai-runtime-ready`), runs Sulla start, then emits
`sulla-managed-services-ready` (or `-failed` after four attempts; it keeps
retrying). The function runtimes start on demand via `onDemandServices`, whose
docker calls are routed through a verb-allowlisted runner. `stop()` runs
`down --remove-orphans` (never `--volumes`).

**Not generated on Linux yet** (reported in `deferred`): `sulla_accounts`,
`sulla_vault`, `sulla_files(_fuse)`, `sulla_relay`, `workflow_manager`, `tools`,
`threat_proxy`. They need host-provisioned secrets/TLS identities and guest
paths the macOS backend prepares. Windows can reuse `LinuxManagedServices` with
its own runner and hooks (constructor: `LinuxManagedServicesDependencies`).

## Runtime image

`assets/runtime/guest/Dockerfile` target `linux-runtime`
(`build-linux-runtime.sh [arm64|amd64]`) builds `sulla-desktop-linux-runtime`.
`start()` fails with the build command if the image is absent; there is no
fallback to a generic image. Alpine 3.23 package facts (verified against the
catalog and a real `apk add` on linux/arm64): `shadow-uidmap` is only a virtual
provided by `shadow-subids` (the Dockerfile now names `shadow-subids`);
`docker-rootless-extras` ships `/usr/bin/dockerd-rootless` (not `.sh`) and
depends on docker, rootlesskit, slirp4netns, fuse-overlayfs.

**Not done / not claimed:** a Linux x64 end-to-end smoke (only linux/arm64 was
available), Linux packaging (still gated in `package.ts`), and the deferred
services above.

The platform-neutral `DockerComposeRuntime` in
`backend/containerClient/dockerComposeRuntime.ts` is the shared compose
lifecycle surface for Windows WSL2: its runner accepts `docker` argv plus an
optional environment and returns `{ stdout, stderr, exitCode }`; its project
spec uses an absolute Linux compose path and a `sulla-desktop-*` namespace.
Windows can adapt `Wsl2Host.runInDistribution('docker', args)` to that runner,
then use `startProject`/`stopProject`. The WSL wrapper must start the daemon and
verify readiness before calling it; rootless enforcement belongs only to the
native Linux host adapter.

## Windows WSL2 rootfs

`assets/runtime/guest/build-wsl-rootfs.sh amd64 [output-directory]` builds the
`wsl-import-rootfs` target from the same Alpine/Docker guest image definition.
The verified output is `rootfs.tar` plus `rootfs.tar.sha256`; Windows imports
that file only as an app-owned WSL2 distribution. Start `/usr/bin/dockerd` as
the owned distro's long-lived process, probe `docker info` from that distro,
and stop only that distro with `wsl.exe --terminate <app-distro>`.

The Linux rootless-host restriction does not apply inside the isolated
app-owned WSL distro. WSL host integration must still verify the rootfs SHA-256
before import and must never enable Windows features, elevate, replace an
existing distro, or issue global `wsl --shutdown` as an automatic side effect.
