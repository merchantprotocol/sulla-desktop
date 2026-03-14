# Terminal Server

The terminal server provides interactive shell access to the Lima VM (instance `0`) from the Sulla Desktop UI. It pairs a WebSocket server on the main process side with an xterm.js frontend component, bridging browser-based terminal emulation to a real PTY running inside the guest VM.

## Architecture Overview

```
XTermTerminal.vue  --(WebSocket)-->  WebSocketTerminalServer  --(node-pty)-->  limactl shell 0
   (renderer)           :6108             (main process)                         (Lima VM)
```

Source files:

- **Server**: `pkg/rancher-desktop/main/terminalServer.ts`
- **Frontend**: `pkg/rancher-desktop/pages/editor/XTermTerminal.vue`

## Terminal WebSocket Server (Port 6108)

`WebSocketTerminalServer` is an HTTP + WebSocket server that listens on `ws://127.0.0.1:6108`. It is started during application initialization (`onMainProxyLoad()`) and stopped during shutdown (`sullaEnd()`).

The server is managed as a singleton via `getTerminalServer()`. It binds exclusively to `127.0.0.1` so it is not reachable from outside the host machine.

### Starting and Stopping

```ts
import { getTerminalServer } from '@pkg/main/terminalServer';

// Start
const server = getTerminalServer();
await server.start();       // defaults to port 6108

// Stop (kills all PTY processes and closes all client connections)
server.stop();
```

## PTY Sessions

Each terminal session spawns a PTY process using `node-pty`. The PTY runs `limactl shell 0`, which opens an interactive shell inside the Lima VM.

### Spawn Details

The server resolves `limactlPath` and `LIMA_HOME` from `CommandRunner` utilities, then calls:

```ts
pty.spawn(limactlPath, ['shell', '0'], {
  name: 'xterm-256color',
  cols,
  rows,
  env: { ...process.env, LIMA_HOME: limaHome, TERM: 'xterm-256color' },
});
```

If a `command` is provided in the start message, the args become `['shell', '0', '--', 'sh', '-lc', command]`, which executes that command in the guest instead of opening an interactive shell.

### Known Issue: node-pty spawn-helper Permissions

Prebuilt `node-pty` packages ship without the execute bit set on `spawn-helper`. This causes `posix_spawnp failed` errors. The fix is applied automatically in the project's `postinstall.ts` script, which runs `chmod +x` on the binary.

### Important: node-pty Must Be External

`node-pty` (along with `ws`, `bufferutil`, and `utf-8-validate`) is declared as a webpack external in `build-utils.ts`. The terminal server module is loaded via `await import()` in `sulla.ts` to prevent webpack from bundling native modules into the renderer process.

## Multiple Concurrent Client Support

The server maintains a `Map<string, TerminalSession>` where each session holds a PTY process and a `Set<WebSocket>` of connected clients.

### Session Management

- **New session**: When a client sends a `start` message with a new or absent `sessionId`, the server spawns a fresh PTY and creates a session.
- **Join existing session**: If the `sessionId` matches an existing session, the client is added to that session's client set. All clients in the same session see the same PTY output.
- **Session cleanup**: When a client disconnects, it is removed from the session's client set. If no clients remain, the PTY process is killed and the session is deleted.
- **PTY exit**: If the PTY process exits on its own (e.g., the user types `exit`), all connected clients receive a `[Session ended]` message and are closed.

### Data Flow

PTY output is broadcast to every client in the session. Any client's keyboard input is written directly to the shared PTY. This means multiple clients attached to the same session share a single shell.

## Frontend Integration (XTermTerminal.vue)

`XTermTerminal.vue` is a Vue 3 component that renders an xterm.js terminal and connects to the WebSocket server.

### Props

| Prop         | Type    | Default                                        | Description                                |
|--------------|---------|-------------------------------------------------|--------------------------------------------|
| `wsUrl`      | String  | `ws://127.0.0.1:6108`                          | WebSocket server URL                       |
| `sessionId`  | String  | `''`                                            | Session ID to create or join               |
| `command`    | String  | `''`                                            | Command to run instead of interactive shell |
| `isDark`     | Boolean | `true`                                          | Dark/light theme toggle                    |
| `fontSize`   | Number  | `14`                                            | Terminal font size                         |
| `fontFamily` | String  | `Menlo, Monaco, "Courier New", monospace`       | Terminal font family                       |
| `readOnly`   | Boolean | `false`                                         | Disables keyboard input when true          |

### Events

| Event          | Description                             |
|----------------|-----------------------------------------|
| `connected`    | Emitted when the WebSocket opens        |
| `disconnected` | Emitted when the WebSocket closes       |
| `error`        | Emitted on WebSocket error              |

### Resize Handling

The component uses the `FitAddon` from xterm.js and a `ResizeObserver` on the terminal container. When the container resizes:

1. A debounced (30ms) call to `fitAddon.fit()` recalculates the terminal dimensions.
2. A `resize` message (`{ type: 'resize', cols, rows }`) is sent over the WebSocket.
3. The server calls `ptyProcess.resize(cols, rows)` to update the PTY dimensions.

### Theme Support

The component watches the `isDark` prop and updates the xterm.js theme in real time. Dark mode uses a slate background (`#1e293b`); light mode uses near-white (`#f8fafc`).

## Connection Lifecycle and Retry Logic

### Normal Flow

1. Component mounts and creates an xterm.js `Terminal` instance.
2. A WebSocket connection opens to `ws://127.0.0.1:6108`.
3. On `onopen`, the client sends a JSON start message:
   ```json
   { "type": "start", "sessionId": "...", "cols": 80, "rows": 24 }
   ```
4. The server spawns a PTY via `limactl shell 0` and attaches the client.
5. PTY output flows to the client; client keystrokes flow to the PTY.
6. On unmount, the component closes the WebSocket. The server removes the client and kills the PTY if no other clients remain.

### Server-Side Retry (VM Not Ready)

If the Lima VM is not yet running when the server tries to spawn the PTY, the server enters a retry loop:

- **Max retries**: 20
- **Interval**: 3 seconds between attempts
- **Total wait**: up to 60 seconds

During this time, the client sees a cyan "VM is starting up, connecting..." message followed by dots for each failed attempt. If the VM becomes available within the retry window, the session is created transparently. If all retries are exhausted, the client receives a red error message and the WebSocket is closed.

### Client-Side Disconnect

When the WebSocket closes (server shutdown, network issue, or PTY exit), the component writes a red "Disconnected." message to the terminal and emits the `disconnected` event. The parent component can use this event to trigger reconnection or show UI controls.

## WebSocket Protocol Reference

All control messages are JSON. Raw (non-JSON) strings sent by the client are forwarded directly as PTY input.

### Client to Server

| Message                          | Description                        |
|----------------------------------|------------------------------------|
| `{ type: "start", sessionId?, cols?, rows?, command? }` | Create or join a PTY session |
| `{ type: "resize", cols, rows }` | Resize the PTY                     |
| *(raw string)*                   | Keyboard input forwarded to PTY    |

### Server to Client

| Message            | Description                                  |
|--------------------|----------------------------------------------|
| *(raw string)*     | PTY output (shell text, escape sequences)    |
| `[Session ended]`  | PTY process exited (yellow ANSI text)        |
| Retry dots (`.`)   | Spawn retry in progress                      |
| Error message      | VM unreachable after all retries (red ANSI)  |
