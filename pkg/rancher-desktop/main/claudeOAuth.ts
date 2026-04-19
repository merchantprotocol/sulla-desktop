/**
 * Claude Code OAuth handler.
 *
 * Runs `claude setup-token` inside the Lima VM via PTY, opens the OAuth
 * URL in an embedded BrowserWindow, intercepts the callback to extract
 * the authorization code, feeds it back to the CLI, and captures the
 * long-lived OAuth token when Claude CLI prints it.
 *
 * After a token is captured, writes it to /etc/claude-env in the VM
 * so Claude Code can pick it up immediately without a VM restart.
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BrowserWindow } from 'electron';
import * as pty from 'node-pty';

import { resolveLimactlPath, resolveLimaHome } from '@pkg/agent/tools/util/CommandRunner';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

// Claude CLI emits the token on its own line after completion.
const TOKEN_PATTERN = /(sk-ant-oat01-[A-Za-z0-9_-]{40,})/;

// Match the OAuth URL even when the terminal wraps it across lines.
const URL_PATTERN = /(https?:\/\/(?:claude\.com|claude\.ai)\/[\s\S]+?state=[A-Za-z0-9_-]+)/;

// Claude CLI prints this after a bad code; we could retry but for now we bail.
const INVALID_CODE_PATTERN = /OAuth error: Invalid code/i;

interface OAuthSession {
  ptyProcess:   pty.IPty;
  stdoutBuffer: string;
  authWindow:   BrowserWindow | null;
}

let activeSession: OAuthSession | null = null;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/** Redact sensitive OAuth params so they never hit disk. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of ['code', 'state', 'code_challenge', 'access_token']) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '(redacted)');
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function killActiveSession() {
  if (activeSession) {
    try { activeSession.ptyProcess.kill() } catch { /* already dead */ }
    try { activeSession.authWindow?.close() } catch { /* already closed */ }
    activeSession = null;
  }
}

/**
 * Quick check that the Lima VM is running. Runs `limactl list --json` and
 * looks for instance '0' with status 'Running'. Returns false if we can't
 * reach limactl at all.
 */
async function isVMRunning(): Promise<boolean> {
  return await new Promise((resolve) => {
    const limactlPath = resolveLimactlPath({});
    const limaHome = resolveLimaHome({});
    const proc = childProcess.spawn(limactlPath, ['list', '--json'], {
      env: { ...process.env, LIMA_HOME: limaHome },
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString() });
    proc.on('close', () => {
      try {
        // `limactl list --json` outputs one JSON object per line
        for (const line of out.split('\n')) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line) as { name?: string; status?: string };
          if (entry.name === '0' && entry.status === 'Running') {
            resolve(true);
            return;
          }
        }
        resolve(false);
      } catch {
        resolve(false);
      }
    });
    proc.on('error', () => resolve(false));
  });
}

/**
 * Write the OAuth token into the running VM's /etc/claude-env so that
 * Claude Code can pick it up without a VM restart.
 */
async function injectTokenIntoVM(token: string): Promise<void> {
  const limactlPath = resolveLimactlPath({});
  const limaHome = resolveLimaHome({});
  const env = { ...process.env, LIMA_HOME: limaHome };

  // Write the token to a temp file on the host, copy into VM, then move to /etc.
  const tmpPath = path.join(os.tmpdir(), `sulla-claude-env-${ Date.now() }`);
  await fs.promises.writeFile(tmpPath, `CLAUDE_CODE_OAUTH_TOKEN=${ token }\n`, { mode: 0o600 });

  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    const proc = childProcess.spawn(limactlPath, args, { env });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString() });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`limactl ${ args.join(' ') } exited ${ code }: ${ stderr }`));
    });
    proc.on('error', reject);
  });

  try {
    await run(['copy', tmpPath, '0:/tmp/claude-env']);
    await run(['shell', '0', '--', 'sudo', 'mv', '/tmp/claude-env', '/etc/claude-env']);
    await run(['shell', '0', '--', 'sudo', 'chmod', '600', '/etc/claude-env']);
    console.log('[ClaudeOAuth] Token injected into VM at /etc/claude-env');
  } finally {
    fs.promises.unlink(tmpPath).catch(() => { /* ignore */ });
  }
}

/**
 * Open the OAuth URL in an Electron BrowserWindow and intercept the
 * callback to extract the authorization code and state.
 */
function openAuthWindow(url: string): { window: BrowserWindow; codePromise: Promise<string | null> } {
  const window = new BrowserWindow({
    width:          720,
    height:         800,
    title:          'Sign in with Claude',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
    },
  });

  const codePromise = new Promise<string | null>((resolve) => {
    let resolved = false;
    const doResolve = (code: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };

    const handleUrl = (targetUrl: string) => {
      try {
        const parsed = new URL(targetUrl);
        if (parsed.hostname.endsWith('claude.com') && parsed.pathname.includes('/oauth/code/callback')) {
          const code = parsed.searchParams.get('code');
          const state = parsed.searchParams.get('state');
          // Claude CLI expects "code#state" format.
          const combined = code && state ? `${ code }#${ state }` : code;
          console.log(`[ClaudeOAuth] Intercepted callback, combined=${ combined ? `${ combined.length } chars` : '(missing)' }`);
          doResolve(combined);
        }
      } catch { /* not a URL */ }
    };

    window.webContents.on('will-redirect', (_event, u) => handleUrl(u));
    window.webContents.on('will-navigate', (_event, u) => handleUrl(u));
    window.webContents.on('did-navigate', (_event, u) => handleUrl(u));
    window.webContents.on('did-navigate-in-page', (_event, u) => handleUrl(u));

    window.on('closed', () => doResolve(null));
  });

  console.log(`[ClaudeOAuth] Opening auth window: ${ redactUrl(url) }`);
  window.loadURL(url);
  return { window, codePromise };
}

export function initClaudeOAuthEvents(): void {
  const ipcMainProxy = getIpcMainProxy(console);

  /**
   * Start the OAuth flow. Returns the captured token, or an error message.
   */
  ipcMainProxy.handle('claude-oauth:start', async(event: Electron.IpcMainInvokeEvent): Promise<{ token?: string; error?: string }> => {
    if (activeSession) killActiveSession();

    // Bail out early with a clear message if the VM isn't ready.
    if (!await isVMRunning()) {
      return { error: 'The Lima VM is not running yet. Wait for Sulla Desktop to finish starting up, then try again.' };
    }

    return await new Promise((resolve) => {
      const limactlPath = resolveLimactlPath({});
      const limaHome = resolveLimaHome({});

      const ptyProcess = pty.spawn(limactlPath, ['shell', '0', '--', 'claude', 'setup-token'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        env:  {
          ...process.env,
          LIMA_HOME: limaHome,
          TERM:      'xterm-256color',
        } as Record<string, string>,
      });

      const session: OAuthSession = { ptyProcess, stdoutBuffer: '', authWindow: null };
      activeSession = session;

      let urlOpened = false;
      let codeSent = false;
      let enterSent = false;
      let resolved = false;

      const doResolve = (result: { token?: string; error?: string }) => {
        if (resolved) return;
        resolved = true;
        try { ptyProcess.kill() } catch { /* dead */ }
        try { session.authWindow?.close() } catch { /* closed */ }
        if (activeSession === session) activeSession = null;

        // Persist the token to /etc/claude-env so Claude Code picks it up now.
        if (result.token) {
          injectTokenIntoVM(result.token).catch((err) => {
            console.warn('[ClaudeOAuth] Failed to inject token into VM:', err);
          });
        }
        resolve(result);
      };

      const timeout = setTimeout(() => {
        doResolve({ error: 'OAuth flow timed out after 5 minutes' });
      }, 5 * 60 * 1000);

      console.log('[ClaudeOAuth] Starting OAuth flow');

      ptyProcess.onData((data: string) => {
        const clean = stripAnsi(data);
        session.stdoutBuffer += clean;

        // Stream progress to the renderer (UI status line)
        try {
          event.sender.send('claude-oauth:progress', clean);
        } catch { /* window closed */ }

        // Early exit on explicit OAuth error
        if (INVALID_CODE_PATTERN.test(session.stdoutBuffer)) {
          clearTimeout(timeout);
          doResolve({ error: 'OAuth error: Invalid code. Try again.' });
          return;
        }

        // 1) Detect the auth URL and open our embedded window
        if (!urlOpened) {
          const urlMatch = URL_PATTERN.exec(session.stdoutBuffer);
          if (urlMatch) {
            urlOpened = true;
            const url = urlMatch[1].replace(/\s+/g, '');

            try {
              event.sender.send('claude-oauth:url', url);
            } catch { /* window closed */ }

            const { window, codePromise } = openAuthWindow(url);
            session.authWindow = window;

            codePromise.then((code) => {
              if (!code) {
                console.log('[ClaudeOAuth] Auth window closed without a code');
                return;
              }
              console.log(`[ClaudeOAuth] Writing ${ code.length } chars to PTY`);
              try { session.authWindow?.close() } catch { /* closed */ }
              session.authWindow = null;
              try {
                ptyProcess.write(code);
                codeSent = true;
              } catch (err) {
                console.warn('[ClaudeOAuth] Failed to write code to PTY:', err);
              }
            });
          }
          return;
        }

        // 2) Wait until the PTY echoes back asterisks confirming the code was
        // buffered, then send Enter to submit it. This is more reliable than
        // a fixed timeout.
        if (codeSent && !enterSent && /\*{20,}/.test(session.stdoutBuffer)) {
          enterSent = true;
          console.log('[ClaudeOAuth] Code echoed — sending Enter');
          try {
            ptyProcess.write('\r');
          } catch (err) {
            console.warn('[ClaudeOAuth] Failed to send Enter:', err);
          }
        }

        // 3) Look for the final token
        const tokenMatch = TOKEN_PATTERN.exec(session.stdoutBuffer);
        if (tokenMatch) {
          clearTimeout(timeout);
          console.log('[ClaudeOAuth] Token captured');
          doResolve({ token: tokenMatch[1] });
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        clearTimeout(timeout);
        console.log(`[ClaudeOAuth] PTY exited code=${ exitCode } signal=${ signal }`);
        if (!resolved) {
          const tokenMatch = TOKEN_PATTERN.exec(session.stdoutBuffer);
          if (tokenMatch) {
            doResolve({ token: tokenMatch[1] });
          } else {
            doResolve({
              error: `Claude setup-token exited without producing a token (code=${ exitCode })`,
            });
          }
        }
      });
    });
  });

  /** Cancel an in-progress OAuth flow. */
  ipcMainProxy.handle('claude-oauth:cancel', async() => {
    console.log('[ClaudeOAuth] Flow cancelled by user');
    killActiveSession();
  });
}
