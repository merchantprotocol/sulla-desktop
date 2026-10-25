# Sulla Runtime host for macOS

This is the macOS host for the Sulla native runtime. Desktop boots it instead of Lima when the experimental `experimental.sullaRuntime` setting is on (Preferences › Virtual Machine › Emulation); it is off by default.

## Desktop integration

Desktop looks for `resources/darwin/sulla-runtime/sulla-runtime` and `resources/darwin/sulla-runtime/guest/{vmlinuz,initramfs.img}`. In a dev checkout, `scripts/build-sulla-runtime.sh` builds all three there on a Mac (Swift plus Docker buildx for the guest). For a packaged app, either run that script first, set `SULLA_RUNTIME_BUILD=1` so `scripts/package.ts` runs it, or point `SULLA_RUNTIME_ARTIFACTS_DIR` at a directory with the same layout taken from the CI artifacts (`sulla-runtime-host-macos.yml`, `sulla-runtime-guest.yml`). Packaging signs the binary with `sulla-runtime.entitlements`. `SULLA_RUNTIME_BIN` and `SULLA_RUNTIME_GUEST_DIR` override the locations at run time.

If anything is missing, or the runtime does not reach Docker-ready within 60 s, Desktop logs `[sulla-runtime] falling back to Lima: …` and boots Lima in the same launch.

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

Real VM boot, socket proxy, shutdown, Rosetta, and performance testing require macOS and the matching guest artifact.
