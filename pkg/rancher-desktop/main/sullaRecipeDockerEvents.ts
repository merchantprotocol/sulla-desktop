/**
 * Recipe Docker management IPC handlers.
 *
 * Provides container status, log streaming, and interactive PTY shell
 * sessions for recipes installed at ~/sulla/recipes/<slug>/.
 *
 *   recipe-docker-status      → container running state + port info
 *   recipe-logs-start         → start streaming docker compose logs
 *   recipe-logs-stop          → stop a log stream session
 *   recipe-shell-open         → open an interactive PTY into a container
 *   recipe-shell-input        → send keystrokes to an open PTY
 *   recipe-shell-resize       → resize an open PTY
 *   recipe-shell-close        → close a PTY session
 *
 * Log data is pushed back to the renderer via:
 *   recipe-logs-data   (sessionId, chunk)
 *   recipe-logs-end    (sessionId)
 *   recipe-shell-data  (sessionId, chunk)
 *   recipe-shell-exit  (sessionId, exitCode)
 */

import * as child_process from 'child_process';
import * as path from 'path';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

// ─── Session maps ────────────────────────────────────────────────────────────

interface LogSession {
  proc: child_process.ChildProcess;
  sender: Electron.WebContents;
}

interface ShellSession {
  pty: import('node-pty').IPty;
  sender: Electron.WebContents;
}

const logSessions = new Map<string, LogSession>();
const shellSessions = new Map<string, ShellSession>();
let sessionCounter = 0;

function nextSessionId(): string {
  return `rds-${ ++sessionCounter }-${ Date.now() }`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getRecipeDir(slug: string): string {
  const { resolveSullaRecipesDir } = require('@pkg/agent/utils/sullaPaths');

  return path.join(resolveSullaRecipesDir(), slug);
}

/** Augmented PATH that includes common Docker binary locations. */
function dockerEnv(): Record<string, string> {
  const extra = ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin', '~/.rd/bin'].join(path.delimiter);

  return {
    ...process.env as Record<string, string>,
    PATH: `${ process.env.PATH ?? '' }${ path.delimiter }${ extra }`,
  };
}

/** Run a short docker compose command and return stdout. */
async function runCompose(recipeDir: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const proc = child_process.spawn('docker', ['compose', ...args], {
      cwd: process.env.HOME ? recipeDir.replace(/^~/, process.env.HOME) : recipeDir,
      env: dockerEnv(),
    });

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on('error', (err) => {
      stderr += err.message;
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

// ─── IPC registration ────────────────────────────────────────────────────────

export function initSullaRecipeDockerEvents(): void {
  // ── Status ──────────────────────────────────────────────────────────────

  ipcMainProxy.handle('recipe-docker-status', async(_event: Electron.IpcMainInvokeEvent, slug: string) => {
    try {
      const recipeDir = getRecipeDir(slug);

      // Run ps and config --services in parallel.
      const [psResult, svcResult] = await Promise.all([
        runCompose(recipeDir, ['ps', '--all', '--format', 'json']),
        runCompose(recipeDir, ['config', '--services']),
      ]);

      const containers: Array<{ name: string; service: string; state: string; status: string; ports: string[] }> = [];

      for (const line of psResult.stdout.trim().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          const ports: string[] = [];
          if (Array.isArray(obj.Publishers)) {
            for (const pub of obj.Publishers) {
              if (pub.PublishedPort && pub.TargetPort) {
                ports.push(`${ pub.PublishedPort }→${ pub.TargetPort }/${ pub.Protocol ?? 'tcp' }`);
              } else if (pub.PublishedPort) {
                ports.push(String(pub.PublishedPort));
              }
            }
          }
          containers.push({
            name:    obj.Name ?? obj.Service ?? 'container',
            service: obj.Service ?? obj.Name ?? 'container',
            state:   (obj.State ?? obj.Status ?? '').toLowerCase(),
            status:  obj.Status ?? obj.State ?? '',
            ports,
          });
        } catch {
          // Skip malformed lines
        }
      }

      // Add services declared in compose that have no container yet.
      const seenServices = new Set(containers.map(c => c.service));
      for (const svc of svcResult.stdout.trim().split('\n').map(s => s.trim()).filter(Boolean)) {
        if (!seenServices.has(svc)) {
          containers.push({
            name:    svc,
            service: svc,
            state:   'not created',
            status:  'Not created',
            ports:   [],
          });
        }
      }

      const running = containers.some(c => c.state === 'running');

      return { running, containers };
    } catch (err) {
      console.error('[RecipeDocker] status error:', err);

      return { running: false, containers: [], error: String(err) };
    }
  });

  // ── Log streaming ────────────────────────────────────────────────────────

  ipcMainProxy.handle('recipe-logs-start', (event: Electron.IpcMainInvokeEvent, slug: string, service?: string) => {
    const sessionId = nextSessionId();
    const recipeDir = getRecipeDir(slug);

    const args = ['compose', 'logs', '--follow', '--tail=2000', '--no-color'];
    if (service) args.push(service);

    const proc = child_process.spawn(
      'docker',
      args,
      {
        cwd: process.env.HOME ? recipeDir.replace(/^~/, process.env.HOME) : recipeDir,
        env: dockerEnv(),
      },
    );

    logSessions.set(sessionId, { proc, sender: event.sender });

    const push = (chunk: Buffer | string) => {
      try {
        event.sender.send('recipe-logs-data', sessionId, chunk.toString());
      } catch { /* renderer closed */ }
    };

    proc.stdout?.on('data', push);
    proc.stderr?.on('data', push);

    proc.on('close', () => {
      logSessions.delete(sessionId);
      try { event.sender.send('recipe-logs-end', sessionId); } catch { /* closed */ }
    });

    proc.on('error', (err) => {
      try {
        event.sender.send('recipe-logs-data', sessionId, `\r\n[error] ${ err.message }\r\n`);
        event.sender.send('recipe-logs-end', sessionId);
      } catch { /* closed */ }
      logSessions.delete(sessionId);
    });

    return { sessionId };
  });

  ipcMainProxy.handle('recipe-logs-stop', (_event: Electron.IpcMainInvokeEvent, sessionId: string) => {
    const session = logSessions.get(sessionId);
    if (session) {
      try { session.proc.kill(); } catch { /* dead */ }
      logSessions.delete(sessionId);
    }

    return { ok: true };
  });

  // ── PTY shell ────────────────────────────────────────────────────────────

  ipcMainProxy.handle(
    'recipe-shell-open',
    async(event: Electron.IpcMainInvokeEvent, slug: string, containerName: string, cols = 120, rows = 30) => {
      try {
        const ptyModule = await import('node-pty');
        const pty = ptyModule.default ?? ptyModule;

        const sessionId = nextSessionId();

        const ptyProcess = pty.spawn('docker', ['exec', '-it', containerName, '/bin/sh'], {
          name: 'xterm-256color',
          cols,
          rows,
          env: dockerEnv(),
        });

        shellSessions.set(sessionId, { pty: ptyProcess, sender: event.sender });

        ptyProcess.onData((data: string) => {
          try { event.sender.send('recipe-shell-data', sessionId, data); } catch { /* closed */ }
        });

        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          shellSessions.delete(sessionId);
          try { event.sender.send('recipe-shell-exit', sessionId, exitCode); } catch { /* closed */ }
        });

        return { sessionId };
      } catch (err) {
        console.error('[RecipeDocker] shell-open error:', err);

        return { error: String(err) };
      }
    },
  );

  ipcMainProxy.handle('recipe-shell-input', (_event: Electron.IpcMainInvokeEvent, sessionId: string, data: string) => {
    const session = shellSessions.get(sessionId);
    if (session) {
      try { session.pty.write(data); } catch { /* dead */ }
    }

    return { ok: true };
  });

  ipcMainProxy.handle('recipe-shell-resize', (_event: Electron.IpcMainInvokeEvent, sessionId: string, cols: number, rows: number) => {
    const session = shellSessions.get(sessionId);
    if (session) {
      try { session.pty.resize(cols, rows); } catch { /* dead */ }
    }

    return { ok: true };
  });

  ipcMainProxy.handle('recipe-shell-close', (_event: Electron.IpcMainInvokeEvent, sessionId: string) => {
    const session = shellSessions.get(sessionId);
    if (session) {
      try { session.pty.kill(); } catch { /* dead */ }
      shellSessions.delete(sessionId);
    }

    return { ok: true };
  });

  // ── Start / Stop ─────────────────────────────────────────────────────────

  // Streaming start: returns sessionId immediately, pushes docker compose up output in real time.
  ipcMainProxy.handle('recipe-start-stream', (event: Electron.IpcMainInvokeEvent, slug: string) => {
    const sessionId = nextSessionId();
    const recipeDir = getRecipeDir(slug);

    const proc = child_process.spawn(
      'docker',
      ['compose', 'up', '-d', '--no-color', '--remove-orphans'],
      {
        cwd: process.env.HOME ? recipeDir.replace(/^~/, process.env.HOME) : recipeDir,
        env: dockerEnv(),
      },
    );

    const push = (chunk: Buffer | string) => {
      try { event.sender.send('recipe-start-output', sessionId, chunk.toString()); } catch { /**/ }
    };

    proc.stdout?.on('data', push);
    proc.stderr?.on('data', push);

    proc.on('close', (code) => {
      try { event.sender.send('recipe-start-done', sessionId, code ?? 1); } catch { /**/ }
    });

    proc.on('error', (err) => {
      try {
        event.sender.send('recipe-start-output', sessionId, `\r\n[error] ${ err.message }\r\n`);
        event.sender.send('recipe-start-done', sessionId, 1);
      } catch { /**/ }
    });

    return { sessionId };
  });

  ipcMainProxy.handle('recipe-start', async(_event: Electron.IpcMainInvokeEvent, slug: string) => {
    try {
      const recipeDir = getRecipeDir(slug);
      const { stdout, stderr, exitCode } = await runCompose(recipeDir, ['up', '-d', '--remove-orphans']);

      return { ok: exitCode === 0, stdout, stderr };
    } catch (err) {
      console.error('[RecipeDocker] start error:', err);

      return { ok: false, error: String(err) };
    }
  });

  ipcMainProxy.handle('recipe-stop', async(_event: Electron.IpcMainInvokeEvent, slug: string) => {
    try {
      const recipeDir = getRecipeDir(slug);
      const { stdout, stderr, exitCode } = await runCompose(recipeDir, ['down', '--remove-orphans']);

      return { ok: exitCode === 0, stdout, stderr };
    } catch (err) {
      console.error('[RecipeDocker] stop error:', err);

      return { ok: false, error: String(err) };
    }
  });
}
