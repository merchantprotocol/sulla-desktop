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
`ipAddress` is `127.0.0.1` while running. The default runtime image
(`alpine:3.23`) is interim; replace with the pinned Sulla guest image once it is
published. **Not done / not claimed:** `SullaRuntimeBackend`'s managed-services
orchestration (`managesSullaServices` is false here), a real-engine smoke test,
and the Linux package target.

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
