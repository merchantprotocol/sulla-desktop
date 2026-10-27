# Sulla immutable runtime guest

`build.sh arm64` (or `amd64`) creates a reproducible kernel, initramfs and `/usr` image in `dist/<arch>/`. Alpine packages are resolved only while the artifact is built; the resulting guest contains no boot-time provisioning or package download.

The kernel is Alpine's LTS distribution kernel. Its shipped configuration enables the Virtualization.framework requirements, built in where Alpine provides them and with the matching immutable modules otherwise: virtio block/net/console, AF_VSOCK and virtio-vsock, overlayfs, cgroup v2, nftables, BPF, ext4, and binfmt_misc. The guest contains the static Sulla PID 1 agent plus BusyBox, Moby dockerd/containerd/runc/docker-init, buildx, compose, iproute2, iptables/nftables, CA certificates, ext4 tools, OpenSSL, and SMB/NFS/FUSE mount helpers (cifs-utils, nfs-utils, fuse3).

It also carries a standard toolset for commands models run in the guest: Python 3 with pip, Node.js with npm, git, curl, wget, jq, ripgrep, GNU tar/coreutils/findutils/grep/sed/gawk, unzip, zstd, bash, and the OpenSSH client. There is no package manager at run time (apk is removed). Instead `pip install` and `npm install -g` write to `/usr/local`, which the agent bind-mounts from `/mnt/data/usr/local` on the data disk, so they persist across reboots: `usr/pip.conf` gives the system interpreter `prefix = /usr/local` (venvs never read it), `sulla-usr-local.pth` puts `/usr/local/lib/pythonX.Y/site-packages` on `sys.path`, and Alpine's npm already uses `/usr/local` as its global prefix.

On arm64, `vmlinuz` is the raw kernel `Image` unwrapped from Alpine's EFI zboot file, because Virtualization.framework's Linux boot loader cannot boot the compressed form.

## What is in RAM

The kernel unpacks the initramfs into RAM it never reclaims, so the initramfs carries only what runs before `/usr` is mounted: the static agent (`/init`), BusyBox and musl, `/etc`, `/bin`, `/sbin`, and the modules in `/lib/sulla-boot-modules` (virtio PCI with its two helpers, virtio block, virtio console, erofs, overlay), stored uncompressed and named in dependency order so the agent loads them itself. Everything under `/usr`, and the kernel modules (`/lib/modules` is a link to `/usr/lib/modules`), is in `usr.erofs`, an LZ4HC-compressed erofs image the host attaches as a read-only disk. The agent mounts it at `/sulla/usr-image` and, before it runs anything else, mounts an overlay at `/usr` with a tmpfs upper layer (`/sulla/usr-rw`). Only the pages a process actually reads are cached, as clean page cache the guest drops under memory pressure; Docker's binaries stay warm, while Python, Node, git and the module tree cost nothing until used. `/usr` stays writable as it was in the initramfs (changes live in RAM and are gone at reboot; only changed files take RAM), and `/usr/local` is still the data disk's `usr/local`, so `pip install` and `npm install -g` persist as before.

Measured from the 0.2.0 initramfs (Alpine 3.23, linux-lts 6.18.58, 4 KiB pages): 627 MiB in RAM, of which `/usr` was 512 MiB and `/lib/modules` 101 MiB; what stays in the initramfs now is about 15 MiB.

Outputs are `vmlinuz`, `initramfs.img`, `usr.erofs`, `VERSION`, and `SHA256SUMS`. Set `SOURCE_DATE_EPOCH` to the source commit timestamp for deterministic mtimes. The artifact has no mutable root: persistent state belongs on the data disk (`/dev/vda`).
