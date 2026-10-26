# Sulla immutable runtime guest

`build.sh arm64` (or `amd64`) creates a reproducible kernel and initramfs in `dist/<arch>/`. Alpine packages are resolved only while the artifact is built; the resulting guest contains no boot-time provisioning or package download.

The kernel is Alpine's LTS distribution kernel. Its shipped configuration enables the Virtualization.framework requirements, built in where Alpine provides them and with the matching immutable modules otherwise: virtio block/net/console, AF_VSOCK and virtio-vsock, overlayfs, cgroup v2, nftables, BPF, ext4, and binfmt_misc. The initramfs contains the static Sulla PID 1 agent plus BusyBox, Moby dockerd/containerd/runc/docker-init, buildx, compose, iproute2, iptables/nftables, CA certificates, ext4 tools, OpenSSL, and SMB/NFS/FUSE mount helpers (cifs-utils, nfs-utils, fuse3).

It also carries a standard toolset for commands models run in the guest: Python 3 with pip, Node.js with npm, git, curl, wget, jq, ripgrep, GNU tar/coreutils/findutils/grep/sed/gawk, unzip, zstd, bash, and the OpenSSH client. There is no package manager at run time (apk is removed). Instead `pip install` and `npm install -g` write to `/usr/local`, which the agent bind-mounts from `/mnt/data/usr/local` on the data disk, so they persist across reboots: `usr/pip.conf` gives the system interpreter `prefix = /usr/local` (venvs never read it), `sulla-usr-local.pth` puts `/usr/local/lib/pythonX.Y/site-packages` on `sys.path`, and Alpine's npm already uses `/usr/local` as its global prefix.

On arm64, `vmlinuz` is the raw kernel `Image` unwrapped from Alpine's EFI zboot file, because Virtualization.framework's Linux boot loader cannot boot the compressed form.

Outputs are `vmlinuz`, `initramfs.img`, `VERSION`, and `SHA256SUMS`. Set `SOURCE_DATE_EPOCH` to the source commit timestamp for deterministic mtimes. The artifact has no mutable root: persistent state belongs on `/dev/vdb`.
