# Sulla Desktop -- Port Reference

All ports used by Sulla Desktop services. Host-side ports in the 301xx range are
forwarded into the Lima VM; lower ports run directly on the Electron host.

## Port Map

| Port  | Service                    | Protocol | Bind Address | Purpose                                                                 | Source File                                                                 |
|-------|----------------------------|----------|--------------|-------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| 3000  | ChatCompletionsServer      | HTTP     | 0.0.0.0      | OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`, `/v1/moderations`, `/v1/integrations`) | `pkg/rancher-desktop/main/chatCompletionsServer.ts`                         |
| 6107  | HttpCommandServer          | HTTP     | 127.0.0.1    | Internal CLI/settings server -- settings CRUD, diagnostics, extensions, snapshots, backend state, port forwarding | `pkg/rancher-desktop/main/commandServer/httpCommandServer.ts`               |
| 6108  | Terminal WebSocket Server  | WS       | 127.0.0.1    | PTY sessions inside the Lima VM via `limactl shell 0`; xterm frontend connects here | `pkg/rancher-desktop/main/terminalServer.ts`                                |
| 6120  | Dashboard Server           | HTTP/WS  | 127.0.0.1    | Rancher Dashboard UI and K8s API proxy (proxies `/k8s`, `/api`, `/apis`, `/v1`, `/v3` to `127.0.0.1:9443`) | `pkg/rancher-desktop/main/dashboardServer/index.ts`                         |
| 30114 | llama-server               | HTTP     | 127.0.0.1    | Local LLM inference (llama.cpp); serves OpenAI-compatible `/v1/embeddings` and completions endpoints | `pkg/rancher-desktop/agent/services/LlamaCppService.ts`                     |
| 30116 | PostgreSQL                 | TCP      | 127.0.0.1    | Persistent relational store (maps host 30116 to container 5432); used by n8n and general Sulla data | `pkg/rancher-desktop/assets/sulla-docker-compose.yaml` (service: `postgres`) |
| 30117 | Redis                      | TCP      | 127.0.0.1    | In-memory cache and queue backend (maps host 30117 to container 6379); used by n8n Bull queue | `pkg/rancher-desktop/assets/sulla-docker-compose.yaml` (service: `redis`)   |
| 30118 | WebSocket Hub              | WS       | 127.0.0.1    | Internal pub/sub communication bus (maps host 30118 to container 8080); used by ChatCompletionsServer tasker channel | `pkg/rancher-desktop/assets/sulla-docker-compose.yaml` (service: `ws-server`) |
| 30119 | n8n Workflow Engine        | HTTP     | 127.0.0.1    | Workflow automation UI and webhook runner (maps host 30119 to container 5678); backed by PostgreSQL and Redis | `pkg/rancher-desktop/assets/sulla-docker-compose.yaml` (service: `n8n`)     |

## Details

### 3000 -- ChatCompletionsServer

Express server exposing an OpenAI-compatible REST API. Accepts chat completion,
completion, embedding, and moderation requests. Also provides an integration API
for calling external service endpoints. Listens on all interfaces (`0.0.0.0`) so
it is reachable from the Lima guest and from LAN clients.

Connects to the WebSocket Hub (port 30118) on channel `tasker` to receive and
respond to asynchronous user messages (e.g. Slack app mentions).

### 6107 -- HttpCommandServer

Authenticated HTTP API used by the `rdctl` CLI and the Electron renderer to
read/write application settings, run diagnostic checks, manage extensions and
snapshots, trigger factory resets, and control the backend lifecycle. Credentials
are written to `~/Library/Application Support/rancher-desktop/rd-engine.json`.

### 6108 -- Terminal WebSocket Server

Spawns `node-pty` processes that run `limactl shell 0` to provide interactive
terminal sessions inside the guest VM. Supports multiple concurrent sessions,
automatic retry while the VM is booting, and terminal resize events.

### 6120 -- Dashboard Server

Serves the Rancher Dashboard static assets and proxies Kubernetes API requests
(`/k8s`, `/api`, `/apis`, `/v1`, `/v3`, etc.) to the cluster API at
`https://127.0.0.1:9443`. Supports WebSocket upgrades for real-time cluster
communication.

### 30114 -- llama-server

Local llama.cpp inference server. Downloaded and managed by `LlamaCppService`.
Provides embedding and completion endpoints consumed by the
ChatCompletionsServer for on-device AI capabilities.

### 30116 -- PostgreSQL

`postgres:16-alpine` container. Default credentials: user `sulla`, password
`sulla_dev_password`, database `sulla`. Data persisted at
`/var/lib/sulla/postgres` inside the VM.

### 30117 -- Redis

`redis:7-alpine` container with AOF persistence (`--appendonly yes`). Data
stored at `/var/lib/sulla/redis`. Used as the Bull queue backend for n8n job
execution.

### 30118 -- WebSocket Hub

Custom WebSocket relay (`byrdziak/sulla-websocket:latest`). Provides a
channel-based pub/sub bus for inter-service messaging. The
ChatCompletionsServer subscribes to the `tasker` channel to bridge external
events (e.g. Slack) into the agent graph.

### 30119 -- n8n Workflow Engine

`n8nio/n8n:latest` container. UI security is disabled for local development.
Uses PostgreSQL (port 30116) for persistence and Redis (port 30117) for the
execution queue. REST API and MCP feature flag are enabled.
