# Linux runtime adapter (draft)

The selected Linux x64 host is a user-installed **rootless Docker Engine** with
Docker Compose v2.17 or newer. The app must use a local Unix socket; rootful
and remote contexts are rejected. The app must not start/stop the user's
daemon. `LinuxDockerHost` owns only a `sulla-desktop-*` Compose project and its
`down` operation never removes volumes. Runtime state directories are private
(0700) under Electron's app-data directory.

`LinuxDockerHost` currently supplies the prerequisite probe, safe app-project
lifecycle, socket discovery and path preparation. `MobyClient` can use the
system Docker CLI and `docker compose` v2 plugin on Linux. This is **not yet a
launchable Linux Desktop backend**: the application factory remains macOS-only
and `SullaRuntimeBackend` still assumes the macOS Virtualization.framework
guest for its `VMExecutor`, data paths and compose binds. Do not enable a Linux
package target until the service compose paths and executor have been adapted
without exposing arbitrary host commands or user-home paths, then verified by
a real Linux install/start/stop smoke.

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
