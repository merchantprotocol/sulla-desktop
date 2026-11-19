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

## Stalled-reader isolation (flow-control version 1)

A paused Mac reader used to stop drainage of a VZ stream. In an isolated VM
this blocked fresh published-port connections and Docker while the guest-local
service and VM control queue stayed healthy. Increasing database deadlines does
not repair that shared-device backpressure.

Matched new host/guest artifacts negotiate flow control before payload streams
start. The host waits for the guest HELLO capability; the guest waits for the
host's initial clock/control capability. An explicitly legacy peer retains its
existing raw protocol. Only the matched new pair provides stalled-reader
isolation, so install the host binary and guest initramfs together. Kernel,
read-only `/usr`, data disk and application protocols are unchanged.

Each direction permits 32 KiB of unconsumed data in frames no larger than 8 KiB.
The wire reader drains into that bounded window independently of the receiving
application. Credit is returned after the destination accepts bytes, so a slow
consumer backpressures its own producer without filling the shared VZ device.
EOF waits for accepted preceding bytes. Real wire failure aborts both endpoints;
a normal half-close still permits the other direction to finish. The existing
30-second blocked-write bound remains on both actual socket destinations.

`SULLA_RUNTIME_RELAY_DIAGNOSTICS=1` enables connection ID, route/port,
connect/first-byte/last-progress timing, byte counts and terminal reason logs.
Payloads, commands, SQL, passwords and provider credentials are never logged.
Do not enable broad HTTP/request-body logging to diagnose this transport.

Use a separate `SULLA_RUNTIME_DIR` for **every** test command. Do not run
`bench/benchmark.sh` beside live work: that older harness targets the default
Docker socket during cleanup. A disposable test directory must be below
`/private/tmp/sulla-relay-*` and contain `.test-owned` before the regression
harness accepts it. The fixture never mounts or reads the user's project.

```bash
python3 scripts/runtime-stall-isolation.py \
  --runtime /absolute/path/to/test-runtime \
  --runtime-dir /private/tmp/sulla-relay-yourRUNhere/vm \
  --direction guest-to-host --expect healthy --resume \
  --output /absolute/path/to/receipt.json
node scripts/runtime-postgres-isolation.cjs \
  /absolute/path/to/test-runtime \
  /private/tmp/sulla-relay-yourRUNhere/vm healthy \
  /absolute/path/to/postgres-receipt.json
```

The PostgreSQL fixture uses a fresh official PostgreSQL 16 Alpine container on
that private runtime only, a random in-memory password, loopback-only publishing,
and a separate private Mac listener. It removes only its own fixture container
and anonymous volume. Its image must already be present on that test runtime.
Keep actual live installation/recovery acceptance separate from fixture passes.
