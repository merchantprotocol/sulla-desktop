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

## Boot milestones and readiness

1. Agent entered (`bootUptimeMs` origin).
2. proc, sysfs, cgroup v2, and `/run` tmpfs mounted.
3. `/dev/vdb` formatted as ext4 with label `sulla-data` only when blank, then mounted at `/var/lib/sulla-data`; its `docker` directory is bind-mounted at `/var/lib/docker`.
4. Control and Docker vsock listeners started; network configuration proceeds independently.
5. containerd and dockerd launched as supervised units in parallel. `unit-ready` means the process successfully started, not API readiness.
6. `docker-ready` fires exactly once, immediately after the first `GET /_ping` response with HTTP 200 on `/run/docker.sock`. No debounce, package install, download, SSH, time synchronization, or unrelated service gates it.

The immutable boot disk is `/dev/vda`; the mutable ext4 data disk is `/dev/vdb`. Agent logs are duplicated to `/dev/hvc0` and `/var/lib/sulla-data/logs/sulla-agent.log`.
