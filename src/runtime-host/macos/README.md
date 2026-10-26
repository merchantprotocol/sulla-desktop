# Sulla Runtime host for macOS

This is the macOS host for the Sulla native runtime. Desktop boots it as the macOS VM.

## Desktop integration

Desktop looks for `resources/darwin/sulla-runtime/sulla-runtime` and `resources/darwin/sulla-runtime/guest/{vmlinuz,initramfs.img,usr.erofs}`. In a dev checkout, `just build` and `just package` run `scripts/fetch-sulla-runtime.sh`, which downloads the latest runtime CI published from `main` (the rolling `sulla-runtime-latest` release). To build it yourself instead, `scripts/build-sulla-runtime.sh` builds all of them on a Mac (Swift plus Docker buildx for the guest) and marks the result as a local build so the fetch leaves it alone. For a packaged app, either run that script first, set `SULLA_RUNTIME_BUILD=1` so `scripts/package.ts` runs it, or point `SULLA_RUNTIME_ARTIFACTS_DIR` at a directory with the same layout taken from the CI artifacts (`sulla-runtime-host-macos.yml`, `sulla-runtime-guest.yml`). Packaging signs the binary with `sulla-runtime.entitlements`. `SULLA_RUNTIME_BIN` and `SULLA_RUNTIME_GUEST_DIR` override the locations at run time.

If anything is missing, or the runtime does not reach Docker-ready, Desktop reports the error and the VM stays down.

## Running it by hand

```bash
swift build -c release
.build/release/sulla-runtime start \
  --kernel /path/to/vmlinuz --initrd /path/to/initramfs.img \
  --usr-image /path/to/usr.erofs --data-disk "$HOME/Library/Application Support/Sulla/runtime/data.raw"

.build/release/sulla-runtime status
.build/release/sulla-runtime stop
DOCKER_HOST="unix://$HOME/Library/Application Support/Sulla/runtime/docker.sock" docker run --rm alpine true
```

`--usr-image` is attached read-only as the guest's second disk and mounted at `/usr`; the data disk is the first. The data disk is created as a 64 GiB sparse raw file and formatted by the guest. Run the benchmark in `bench/` for repeatable boot measurements.

Real VM boot, socket proxy, shutdown, Rosetta, and performance testing require macOS and the matching guest artifact.
