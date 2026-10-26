# Sulla Runtime host for macOS

This is the macOS host for the Sulla native runtime. Desktop boots it as the macOS VM.

## Desktop integration

Desktop looks for `resources/darwin/sulla-runtime/sulla-runtime` and `resources/darwin/sulla-runtime/guest/{vmlinuz,initramfs.img}`. In a dev checkout, `just build` and `just package` run `scripts/fetch-sulla-runtime.sh`, which downloads the latest runtime CI published from `main` (the rolling `sulla-runtime-latest` release). To build it yourself instead, `scripts/build-sulla-runtime.sh` builds all three on a Mac (Swift plus Docker buildx for the guest) and marks the result as a local build so the fetch leaves it alone. For a packaged app, either run that script first, set `SULLA_RUNTIME_BUILD=1` so `scripts/package.ts` runs it, or point `SULLA_RUNTIME_ARTIFACTS_DIR` at a directory with the same layout taken from the CI artifacts (`sulla-runtime-host-macos.yml`, `sulla-runtime-guest.yml`). Packaging signs the binary with `sulla-runtime.entitlements`. `SULLA_RUNTIME_BIN` and `SULLA_RUNTIME_GUEST_DIR` override the locations at run time.

If anything is missing, or the runtime does not reach Docker-ready, Desktop reports the error and the VM stays down.

## Running it by hand

```bash
swift build -c release
.build/release/sulla-runtime start \
  --kernel /path/to/vmlinuz --initrd /path/to/initramfs \
  --rootfs /path/to/rootfs.raw --data-disk "$HOME/Library/Application Support/Sulla/runtime/data.raw"

.build/release/sulla-runtime status
.build/release/sulla-runtime stop
DOCKER_HOST="unix://$HOME/Library/Application Support/Sulla/runtime/docker.sock" docker run --rm alpine true
```

`--rootfs` is optional for an initramfs-only guest. The data disk is created as a 64 GiB sparse raw file and formatted by the guest. Run the benchmark in `bench/` for repeatable boot measurements.

## Memory

`--memory-mib` is the most the guest can ever have, not what it holds. Virtualization.framework only offers the traditional virtio balloon (a host-set target; no free-page reporting, no deflate-on-OOM), so `BalloonController.swift` sets that target from the guest's own numbers: every 2 s it reads the agent's `status` (MemAvailable, cache, shmem, PSI) and sizes the guest at what it uses plus a headroom of a quarter of that (768 MiB to 2 GiB), never below 1 GiB. It grows the guest at once when under half the headroom is left, when memory pressure (PSI some avg10) reaches 10%, or when the agent sends `memory-low` (it checks every 250 ms); it shrinks only 2 minutes after the last growth, at least 512 MiB at a time, under 1% pressure, after the previous step has settled, and evicts at most 512 MiB of cache per step (cgroup `memory.reclaim`, LRU order). The first shrink waits 2 minutes after the guest comes up. `sulla-runtime reclaim` asks the guest to drop its clean page cache once, which Desktop does after loading bundled images. Decisions print as `balloon ...` lines and a `memory ...` line goes to the runtime log every minute, with the VM process's macOS footprint. `SULLA_RUNTIME_BALLOON=off` leaves the guest at its configured size.

Real VM boot, socket proxy, shutdown, Rosetta, and performance testing require macOS and the matching guest artifact.
