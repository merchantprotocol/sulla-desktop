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
RUN apk add --no-cache alpine-base busybox ca-certificates containerd docker docker-cli-buildx \
      blkid e2fsprogs e2fsprogs-extra iproute2 iptables nftables openssl runc tini linux-lts cpio gzip \
    && for dir in dev proc sys run tmp var/lib var/log var/tmp mnt/data mnt/worktrees; do mkdir -p "/image/rootfs/$dir"; done \
    && ln -s ../run /image/rootfs/var/run \
    && chmod 1777 /image/rootfs/tmp \
    && for dir in bin sbin lib usr etc; do cp -a "/$dir" /image/rootfs/; done \
    && rm -rf /image/rootfs/etc/apk /image/rootfs/lib/firmware /image/rootfs/sbin/apk \
      /image/rootfs/etc/resolv.conf /image/rootfs/etc/hostname \
      /image/rootfs/var/cache/apk /image/rootfs/usr/share/man /image/rootfs/boot \
    && /usr/local/bin/unzboot /boot/vmlinuz-lts /image/vmlinuz
COPY --from=agent /sulla-runtime-agent /image/rootfs/init
# Everything in the guest already runs as root; Desktop's setup commands
# still prefix some steps with sudo.
COPY assets/runtime/guest/sudo.sh /image/rootfs/usr/bin/sudo
COPY assets/runtime/guest/docker-credential-none.sh /image/rootfs/usr/bin/docker-credential-rancher-desktop
COPY assets/runtime/guest/config/daemon.json /image/rootfs/etc/docker/daemon.json
COPY assets/runtime/guest/config/containerd.toml /image/rootfs/etc/containerd/config.toml
COPY assets/runtime/guest/make-artifact.sh /usr/local/bin/make-artifact
RUN chmod 0755 /image/rootfs/init /image/rootfs/usr/bin/sudo /image/rootfs/usr/bin/docker-credential-rancher-desktop /usr/local/bin/make-artifact \
    && /usr/local/bin/make-artifact /image/rootfs /image/initramfs.img \
    && printf 'sulla-runtime-guest=0.1.0\nalpine=%s\narchitecture=%s\n' "$ALPINE_VERSION" "$TARGETARCH" > /image/VERSION \
    && cd /image && sha256sum vmlinuz initramfs.img VERSION > SHA256SUMS

FROM scratch
COPY --from=image /image/vmlinuz /vmlinuz
COPY --from=image /image/initramfs.img /initramfs.img
COPY --from=image /image/VERSION /VERSION
COPY --from=image /image/SHA256SUMS /SHA256SUMS
