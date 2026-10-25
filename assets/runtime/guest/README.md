# Sulla immutable runtime guest

`build.sh arm64` (or `amd64`) creates a reproducible kernel and initramfs in `dist/<arch>/`. Alpine packages are resolved only while the artifact is built; the resulting guest contains no boot-time provisioning or package download.

The kernel is Alpine's LTS distribution kernel. Its shipped configuration enables the Virtualization.framework requirements, built in where Alpine provides them and with the matching immutable modules otherwise: virtio block/net/console, AF_VSOCK and virtio-vsock, overlayfs, cgroup v2, nftables, BPF, ext4, and binfmt_misc. The initramfs contains the static Sulla PID 1 agent plus BusyBox, Moby dockerd/containerd/runc/docker-init, buildx, iproute2, iptables/nftables, CA certificates, and ext4 tools.

Outputs are `vmlinuz`, `initramfs.img`, `VERSION`, and `SHA256SUMS`. Set `SOURCE_DATE_EPOCH` to the source commit timestamp for deterministic mtimes. The artifact has no mutable root: persistent state belongs on `/dev/vdb`.
