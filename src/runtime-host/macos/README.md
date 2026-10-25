# Sulla Runtime host for macOS

This is the dark-shipped macOS host for the Sulla native runtime. It is not connected to Desktop startup.

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
