# syntax=docker/dockerfile:1.7
ARG ALPINE_VERSION=3.23
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS agent
ARG TARGETARCH
WORKDIR /src
COPY src/runtime-agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /sulla-runtime-agent .

FROM alpine:${ALPINE_VERSION} AS image
ARG ALPINE_VERSION
ARG TARGETARCH
COPY assets/runtime/guest/unzboot.sh /usr/local/bin/unzboot
RUN apk add --no-cache alpine-base busybox ca-certificates containerd docker docker-cli-buildx docker-cli-compose \
      blkid e2fsprogs e2fsprogs-extra iproute2 iptables nftables openssl runc tini linux-lts cpio gzip \
      cifs-utils nfs-utils fuse3 \
      python3 py3-pip git curl wget jq nodejs npm ripgrep tar unzip zstd bash \
      coreutils findutils grep sed gawk openssh-client \
    && for dir in dev proc sys run tmp var/lib var/log var/tmp mnt/data mnt/worktrees; do mkdir -p "/image/rootfs/$dir"; done \
    && ln -s ../run /image/rootfs/var/run \
    && chmod 1777 /image/rootfs/tmp \
    && for dir in bin sbin lib usr etc; do cp -a "/$dir" /image/rootfs/; done \
    && rm -rf /image/rootfs/etc/apk /image/rootfs/lib/firmware /image/rootfs/sbin/apk \
      /image/rootfs/etc/resolv.conf /image/rootfs/etc/hostname \
      /image/rootfs/var/cache/apk /image/rootfs/usr/share/man /image/rootfs/boot \
      /image/rootfs/usr/local/bin/unzboot \
    && /usr/local/bin/unzboot /boot/vmlinuz-lts /image/vmlinuz
COPY --from=agent /sulla-runtime-agent /image/rootfs/init
# Everything in the guest already runs as root; Desktop's setup commands
# still prefix some steps with sudo.
COPY assets/runtime/guest/sudo.sh /image/rootfs/usr/bin/sudo
COPY assets/runtime/guest/docker-credential-none.sh /image/rootfs/usr/bin/docker-credential-sulla-desktop
COPY assets/runtime/guest/config/daemon.json /image/rootfs/etc/docker/daemon.json
COPY assets/runtime/guest/config/containerd.toml /image/rootfs/etc/containerd/config.toml
COPY assets/runtime/guest/make-artifact.sh /usr/local/bin/make-artifact
# The agent bind-mounts /mnt/data/usr/local over /usr/local, so what models
# install with `pip install` and `npm install -g` lands on the data disk and
# survives reboots. pip.conf in sys.prefix is read only by the system
# interpreter, never inside a venv; Alpine's npm already defaults its global
# prefix to /usr/local (checked below).
COPY assets/runtime/guest/config/pip.conf /image/rootfs/usr/pip.conf
COPY assets/runtime/guest/config/sulla-usr-local.pth /image/rootfs/usr/sulla-usr-local.pth
# Only what PID 1 needs before /usr is mounted stays in the initramfs, which
# the kernel unpacks into RAM that is never reclaimed. Everything under /usr,
# kernel modules included, goes into usr.erofs, a read-only disk the agent
# mounts under a RAM overlay at /usr: only the pages actually read are cached,
# as clean page cache the guest drops under memory pressure, and /usr stays
# writable as before. To reach that disk (and the console, to report a
# failure) the agent loads a few modules itself, since kmod's libraries live
# in /usr/lib: lib/sulla-boot-modules, in file-name order (dependency order).
RUN set -eu; \
    chmod 0755 /image/rootfs/init /image/rootfs/usr/bin/sudo /image/rootfs/usr/bin/docker-credential-sulla-desktop /usr/local/bin/make-artifact; \
    mv /image/rootfs/usr/sulla-usr-local.pth /image/rootfs/usr/lib/python3.*/site-packages/; \
    grep -qx 'prefix=/usr/local' /image/rootfs/usr/lib/node_modules/npm/npmrc; \
    kver=$(ls /lib/modules); \
    [ -d "/lib/modules/$kver" ]; \
    boot=/image/rootfs/lib/sulla-boot-modules; \
    mkdir -p "$boot"; \
    n=0; \
    for module in virtio_pci virtio_blk virtio_console erofs overlay; do \
      modprobe -S "$kver" --show-depends "$module" > /tmp/deps; \
      for file in $(awk '$1 == "insmod" { print $2 }' /tmp/deps); do \
        name=$(basename "$file" .gz); \
        if ls "$boot" | grep -q -- "-$name\$"; then continue; fi; \
        n=$((n + 1)); \
        gzip -dc "$file" > "$boot/$(printf '%02d' "$n")-$name"; \
      done; \
    done; \
    ls "$boot"; \
    ls "$boot" | grep -q -- '-virtio_pci\.ko$'; \
    ls "$boot" | grep -q -- '-virtio_blk\.ko$'; \
    ls "$boot" | grep -q -- '-virtio_console\.ko$'; \
    ls "$boot" | grep -q -- '-erofs\.ko$'; \
    ls "$boot" | grep -q -- '-overlay\.ko$'; \
    mv /image/rootfs/lib/modules /image/rootfs/usr/lib/modules; \
    ln -s ../usr/lib/modules /image/rootfs/lib/modules; \
    mkdir -p /image/rootfs/usr/local; \
    mv /image/rootfs/usr /image/usr; \
    mkdir -m 0755 /image/rootfs/usr; \
    chroot /image/rootfs /bin/busybox true; \
    /usr/local/bin/make-artifact /image/rootfs /image/initramfs.img; \
    printf 'sulla-runtime-guest=0.3.0\nalpine=%s\narchitecture=%s\n' "$ALPINE_VERSION" "$TARGETARCH" > /image/VERSION

# A filesystem image does not depend on the CPU, so mkfs.erofs runs natively
# instead of under emulation. erofs with LZ4HC because the guest kernel
# decompresses it fast and in parallel (Alpine builds squashfs with a single
# decompressor, and this mkfs.erofs has no zstd). The bind mount keeps hard
# links and modes exactly as the image stage left them.
FROM --platform=$BUILDPLATFORM alpine:${ALPINE_VERSION} AS usr
ARG SOURCE_DATE_EPOCH=0
RUN apk add --no-cache erofs-utils
RUN --mount=type=bind,from=image,source=/image,target=/image \
    set -eu; \
    mkdir /out; \
    mkfs.erofs -b 4096 -zlz4hc,12 -C 65536 -E ztailpacking -T "$SOURCE_DATE_EPOCH" -U clear --all-root \
      -L sulla-usr /out/usr.erofs /image/usr; \
    [ $(( $(stat -c %s /out/usr.erofs) % 4096 )) -eq 0 ]; \
    cp /image/vmlinuz /image/initramfs.img /image/VERSION /out/; \
    cd /out; \
    ls -l; \
    sha256sum vmlinuz initramfs.img usr.erofs VERSION > SHA256SUMS

FROM scratch
COPY --from=usr /out/ /
