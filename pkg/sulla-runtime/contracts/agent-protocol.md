# Sulla runtime guest agent protocol (phase 0)

Version 1 freezes the host/guest boundary. The guest agent listens on `AF_VSOCK`, any local CID, and the host addresses guest CID 3. No CID appears on the kernel command line.

## Framing and limits

Control uses port 1024. Each message is one UTF-8 JSON object followed by LF. A frame, including LF, is at most 65,536 bytes. Invalid JSON, invalid UTF-8, an empty frame, or an oversized frame closes that connection. Integers are JSON integers. Unknown object fields are ignored for forward compatibility.

Immediately after accept the agent sends:

```json
{"type":"hello","protocol":1,"agentVersion":"0.1.0","bootUptimeMs":123}
```

It then replays the latest event for each known unit, followed by `docker-ready` and `shutting-down` when those milestones have occurred. Live events use:

```json
{"type":"event","name":"unit-started|unit-ready|unit-failed|docker-ready|shutting-down","unit":"dockerd","uptimeMs":456,"detail":"optional detail"}
```

`unit` is a unit name or JSON `null`. Uptime is monotonic milliseconds since the agent process began.

## Requests

`{"id":1,"method":"status"}` returns `{"id":1,"result":{"units":[{"name":"dockerd","state":"starting|ready|failed|stopped"}],"memTotalKiB":1,"memAvailableKiB":1,"loadAvg1":0.1}}`.

`{"id":2,"method":"shutdown"}` returns `{"id":2,"result":{"ok":true}}` before the agent emits `shutting-down`, synchronizes storage, terminates dockerd/containerd, unmounts the data disk, and powers off.

An unknown method returns `{"id":3,"error":{"code":"unknown_method","message":"unknown method: example"}}`. IDs are signed 64-bit integers and responses copy the request ID.

## Docker transport

Port 2375 proxies each accepted vsock stream byte-for-byte to `/run/docker.sock`. Both directions run concurrently and propagate half-close, preserving HTTP upgrades and long-lived attach, logs, and exec streams. The port has no HTTP awareness.

## Clock and suspend

`{"id":4,"method":"set-time","unixMs":1790000000000}` sets the guest clock. The host sends it on every control connection and every minute after, since the guest has no clock of its own and is as old as its saved state after a restore. `{"id":5,"method":"prepare-suspend"}` syncs disks and drops clean caches before the host saves the machine state.

The host's `sulla-runtime start ... --state FILE` restores FILE instead of cold-booting when FILE matches this configuration (kernel, initrd, /usr image, data disk, CPU, memory, shares, kernel arguments; the machine identifier and MAC address persist in the runtime directory). The state is deleted as soon as a restore begins, so it's never used twice. A failed restore falls back to a cold boot. `sulla-runtime suspend` saves the state and stops the VM (macOS 14+).

## Guest exec (port 1025)

One command per connection, for Desktop's own setup work. The client sends one JSON line, `{"argv":["sh","-c","..."],"workdir":"/","env":["K=V"]}`, then both directions carry binary frames: 1-byte stream, 4-byte big-endian length, payload (at most 1 MiB). Stream 0 is stdin (client to guest; an empty frame closes it), 1 stdout, 2 stderr, and 3 the exit code as a big-endian int32, which ends the session. 255 means the command could not be started. Commands run as root in their own process group; if the connection drops before the command exits, the agent kills that group.

## Published ports (port 2376)

The host opens one stream per Mac-side connection and sends one JSON line, `{"port":N}`. The agent dials guest `127.0.0.1:N` (dockerd's userland proxy listens there for every published port) and splices the two with half-close. Nothing but guest loopback is reachable this way.

## Mac loopback (port 1100, guest-initiated)

`192.168.5.2` stands for the Mac's loopback, under the names `host.sulla.internal` and `host.docker.internal` in the guest's `/etc/hosts`. TCP to that address from the guest or any container is redirected (iptables `REDIRECT`) to the agent on guest port 1100, which reads the original port and opens a vsock stream to the host (CID 2) port 1100 with `{"port":N}`. The host dials only `127.0.0.1:N` on the Mac.

## Host sockets

In the runtime directory (`~/Library/Application Support/Sulla/runtime`, or `$SULLA_RUNTIME_DIR`), all mode 0600: `docker.sock` (port 2375), `control.sock` (`status` / `stop`), and `guest.sock`, where a client writes `<port>\n` (1025 or 2376 only) and is then spliced to that guest port. The host binary runs guest commands itself: `sulla-runtime exec [--workdir DIR] [--env K=V] -- argv...` and `sulla-runtime copy [-r] SRC guest:PATH`.

## Boot milestones and readiness

1. Agent entered (`bootUptimeMs` origin).
2. proc, sysfs and devtmpfs mounted; the agent loads the modules in `/lib/sulla-boot-modules` (virtio PCI, block and console, erofs, overlay) and mounts the read-only erofs disk named by `sulla.usr=` at `/sulla/usr-image`, under a tmpfs overlay at `/usr` so `/usr` stays writable (in RAM, lost at reboot). Everything except PID 1's first steps lives there (Docker, the toolset, the kernel modules, which `/lib/modules` links to), so it is page cache the guest can reclaim rather than initramfs RAM. Then the remaining modules load with `modprobe`, and cgroup v2 and the `/run` tmpfs are mounted.
3. The data disk (`sulla.data=`) is mounted at `/mnt/data`: the whole disk if it is ext4, otherwise its first ext4 partition, which is how a Lima data disk is laid out. Only a provably blank disk (no filesystem and an all-zero first MiB, so no partition table) is formatted, as ext4 with label `sulla-data`. `/mnt/data/var/lib` is bind-mounted at `/var/lib` (Docker at `/var/lib/docker`) and `/mnt/data/worktrees` at `/mnt/worktrees`.
4. Control and Docker vsock listeners started; network configuration proceeds independently.
5. containerd and dockerd launched as supervised units in parallel. `unit-ready` means the process successfully started, not API readiness.
6. `docker-ready` fires exactly once, immediately after the first `GET /_ping` response with HTTP 200 on `/run/docker.sock`. No debounce, package install, download, SSH, time synchronization, or unrelated service gates it.

The mutable ext4 data disk is `/dev/vda` (`sulla.data=vda`); the read-only `/usr` image is `/dev/vdb` (`sulla.usr=vdb`). The initramfs is the rest of the immutable root and stays in RAM, so it holds only what runs before `/usr` is mounted. Agent logs are duplicated to `/dev/hvc0` and `/var/lib/sulla-runtime/logs/sulla-agent.log`.

On shutdown the agent stops dockerd first (up to 45 s, while it stops containers), then containerd (up to 10 s), syncs, unmounts the data disk and powers off. The host waits up to 60 s before forcing the VM off.
