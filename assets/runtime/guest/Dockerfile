# syntax=docker/dockerfile:1.7
ARG ALPINE_VERSION=3.22
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS agent
ARG TARGETARCH
WORKDIR /src
COPY src/runtime-agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /sulla-runtime-agent .

FROM alpine:${ALPINE_VERSION} AS image
ARG TARGETARCH
RUN apk add --no-cache alpine-base busybox ca-certificates containerd docker docker-cli-buildx \
      blkid e2fsprogs e2fsprogs-extra iproute2 iptables nftables runc tini linux-lts cpio gzip \
    && mkdir -p /image/rootfs/{dev,proc,sys,run,tmp,var/lib/docker,var/lib/sulla-data} \
    && for dir in bin sbin lib usr etc; do cp -a "/$dir" /image/rootfs/; done \
    && rm -rf /image/rootfs/etc/apk /image/rootfs/lib/firmware /image/rootfs/sbin/apk \
      /image/rootfs/var/cache/apk /image/rootfs/usr/share/man /image/rootfs/boot \
    && cp /boot/vmlinuz-lts /image/vmlinuz
COPY --from=agent /sulla-runtime-agent /image/rootfs/init
COPY assets/runtime/guest/config/daemon.json /image/rootfs/etc/docker/daemon.json
COPY assets/runtime/guest/config/containerd.toml /image/rootfs/etc/containerd/config.toml
COPY assets/runtime/guest/make-artifact.sh /usr/local/bin/make-artifact
RUN chmod 0755 /image/rootfs/init /usr/local/bin/make-artifact \
    && /usr/local/bin/make-artifact /image/rootfs /image/initramfs.img \
    && printf 'sulla-runtime-guest=0.1.0\nalpine=%s\narchitecture=%s\n' "$ALPINE_VERSION" "$TARGETARCH" > /image/VERSION \
    && cd /image && sha256sum vmlinuz initramfs.img VERSION > SHA256SUMS

FROM scratch
COPY --from=image /image/vmlinuz /vmlinuz
COPY --from=image /image/initramfs.img /initramfs.img
COPY --from=image /image/VERSION /VERSION
COPY --from=image /image/SHA256SUMS /SHA256SUMS
