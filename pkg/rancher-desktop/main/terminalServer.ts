import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { resolveLimactlPath, resolveLimaHome } from '@pkg/agent/tools/util/CommandRunner';

const TERMINAL_PORT = 6108;
const PTY_RETRY_INTERVAL_MS = 3000;
const PTY_MAX_RETRIES = 20;

interface TerminalSession {
  ptyProcess: pty.IPty;
  clients:    Set<WebSocket>;
}

/**
 * WebSocket server that spawns PTY sessions inside the Lima VM.
 * Each session runs `limactl shell 0` to get a shell in the guest.
 * Multiple xterm clients can connect to independent sessions.
 */
export class WebSocketTerminalServer {
  private server: http.Server | null = null;
  private wss:    WebSocketServer | null = null;
  private sessions = new Map<string, TerminalSession>();

  private trySpawnPty(cols: number, rows: number, command?: string): pty.IPty {
    const limactlPath = resolveLimactlPath({});
    const limaHome = resolveLimaHome({});

    const args = command
      ? ['shell', '0', '--', 'sh', '-lc', command]
      : ['shell', '0'];

    return pty.spawn(limactlPath, args, {
      name: 'xterm-256color',
      cols,
      rows,
      env:  {
        ...process.env,
        LIMA_HOME: limaHome,
        TERM:      'xterm-256color',
      } as Record<string, string>,
    });
  }

  private createPtySession(sessionId: string, ptyProcess: pty.IPty): TerminalSession {
    const session: TerminalSession = {
      ptyProcess,
      clients: new Set(),
    };

    ptyProcess.onData((data: string) => {
      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    });

    ptyProcess.onExit(() => {
      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send('\r\n\x1B[1;33m[Session ended]\x1B[0m\r\n');
          client.close();
        }
      }
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  private async startSessionWithRetry(
    ws: WebSocket,
    sessionId: string,
    cols: number,
    rows: number,
    command?: string,
  ): Promise<void> {
    // Show booting message
    ws.send('\x1B[1;36mVM is starting up, connecting...\x1B[0m');

    for (let attempt = 1; attempt <= PTY_MAX_RETRIES; attempt++) {
      if (ws.readyState !== WebSocket.OPEN) {
        return; // client disconnected while waiting
      }

      try {
        const ptyProcess = this.trySpawnPty(cols, rows, command);
        // Success — create the session and attach client
        const session = this.createPtySession(sessionId, ptyProcess);
        session.clients.add(ws);

        // Clear the booting message and let the shell prompt take over
        ws.send('\x1B[2K\r');
        console.log(`[TerminalServer] PTY connected on attempt ${ attempt }`);
        return;
      } catch (err) {
        console.log(`[TerminalServer] Spawn attempt ${ attempt }/${ PTY_MAX_RETRIES } failed:`, String(err));
        ws.send('.');
      }

      await new Promise(resolve => setTimeout(resolve, PTY_RETRY_INTERVAL_MS));
    }

    // Exhausted retries
    ws.send('\r\n\x1B[1;31mCould not connect to VM. Please ensure it is running.\x1B[0m\r\n');
    ws.close();
  }

  private handleConnection(ws: WebSocket): void {
    let session: TerminalSession | null = null;
    let sessionId: string | null = null;

    ws.on('message', async(raw: Buffer | string) => {
      const msg = raw.toString();

      let parsed: any = null;
      try {
        parsed = JSON.parse(msg);
      } catch {
        // Not JSON — raw terminal input
      }

      if (parsed?.type === 'start') {
        const cols = parsed.cols || 80;
        const rows = parsed.rows || 24;
        const command = parsed.command || undefined;
        sessionId = parsed.sessionId || `session-${ Date.now() }-${ Math.random().toString(36).slice(2, 8) }`;

        // Join existing session
        if (sessionId && this.sessions.has(sessionId)) {
          session = this.sessions.get(sessionId)!;
          session.clients.add(ws);
          return;
        }

        // Try to spawn immediately
        if (sessionId) {
          try {
            const ptyProcess = this.trySpawnPty(cols, rows, command);
            session = this.createPtySession(sessionId, ptyProcess);
            session.clients.add(ws);
          } catch (err) {
            console.log('[TerminalServer] Initial spawn failed, retrying:', String(err));
            this.startSessionWithRetry(ws, sessionId, cols, rows, command).then(() => {
              // Update the closure's session reference so subsequent input goes to PTY
              if (sessionId && this.sessions.has(sessionId)) {
                session = this.sessions.get(sessionId)!;
              }
            });
          }
        }
        return;
      }

      if (parsed?.type === 'resize' && session) {
        session.ptyProcess.resize(parsed.cols || 80, parsed.rows || 24);
        return;
      }

      // Raw input goes to PTY
      if (session) {
        session.ptyProcess.write(msg);
      }
    });

    ws.on('close', () => {
      if (session) {
        session.clients.delete(ws);
        if (session.clients.size === 0 && sessionId) {
          session.ptyProcess.kill();
          this.sessions.delete(sessionId);
        }
      }
    });
  }

  async start(port: number = TERMINAL_PORT): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = http.createServer();
        this.wss = new WebSocketServer({ server: this.server });

        this.wss.on('connection', (ws: WebSocket) => {
          this.handleConnection(ws);
        });

        this.server.listen(port, '127.0.0.1', () => {
          console.log(`[TerminalServer] WebSocket server listening on ws://127.0.0.1:${ port }`);
          resolve();
        });

        this.server.on('error', (err: Error) => {
          console.error('[TerminalServer] Server error:', err);
          reject(err);
        });
      } catch (err) {
        console.error('[TerminalServer] Failed to start:', err);
        reject(err);
      }
    });
  }

  stop(): Promise<void> {
    for (const [, session] of this.sessions) {
      session.ptyProcess.kill();
      for (const client of session.clients) {
        client.close();
      }
    }
    this.sessions.clear();

    const wssClose = new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve());
        this.wss = null;
      } else {
        resolve();
      }
    });

    const serverClose = new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });

    return Promise.all([wssClose, serverClose]).then(() => {
      console.log('[TerminalServer] Stopped');
    });
  }
}

// Singleton
let terminalServer: WebSocketTerminalServer | null = null;

export function getTerminalServer(): WebSocketTerminalServer {
  if (!terminalServer) {
    terminalServer = new WebSocketTerminalServer();
  }
  return terminalServer;
}
