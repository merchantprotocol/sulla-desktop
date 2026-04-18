/**
 * Claude Code OAuth handler.
 *
 * Runs `claude setup-token` inside the Lima VM via PTY, intercepts the
 * OAuth URL that Claude CLI prints, opens it in the host's default browser,
 * and captures the long-lived OAuth token from stdout when Claude prints it.
 */

import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { resolveLimactlPath, resolveLimaHome } from '@pkg/agent/tools/util/CommandRunner';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

// Recognizes both plain-token strings (claude-...) and OAuth-style tokens.
// claude setup-token prints the token on its own line when complete.
const TOKEN_PATTERNS = [
  /^(sk-ant-oat01-[A-Za-z0-9_-]{40,})\s*$/m,
  /^(sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{40,})\s*$/m,
];

// Match the full OAuth URL even when it's hard-wrapped across lines by the terminal.
// Matches https://{claude.com|claude.ai|anthropic.com}/... and eats whitespace inside.
const URL_PATTERN = /(https?:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com|anthropic\.com)\/[\s\S]+?state=[A-Za-z0-9_-]+)/;

interface OAuthSession {
  ptyProcess: pty.IPty;
  stdoutBuffer: string;
  authWindow:  BrowserWindow | null;
}

let activeSession: OAuthSession | null = null;

function extractToken(text: string): string | null {
  for (const pattern of TOKEN_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function killActiveSession() {
  if (activeSession) {
    try { activeSession.ptyProcess.kill(); } catch { /* already dead */ }
    try { activeSession.authWindow?.close(); } catch { /* already closed */ }
    activeSession = null;
  }
}

/**
 * Open the OAuth URL in an Electron BrowserWindow and intercept the
 * callback to extract the authorization code.
 * Returns a promise that resolves with the code when Anthropic redirects
 * to the callback URL.
 */
function openAuthWindow(url: string): { window: BrowserWindow; codePromise: Promise<string | null> } {
  console.log('[ClaudeOAuth] Creating BrowserWindow for:', url);

  const window = new BrowserWindow({
    width:  720,
    height: 800,
    title:  'Sign in with Claude',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
    },
  });

  // ── Log EVERY request going through this window ────────────────
  const session = window.webContents.session;

  session.webRequest.onBeforeRequest((details, callback) => {
    console.log(`[ClaudeOAuth][req] ${ details.method } ${ details.url }`, {
      resourceType: details.resourceType,
      referrer:     details.referrer,
    });
    callback({});
  });

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    console.log(`[ClaudeOAuth][headers] ${ details.method } ${ details.url }`, {
      headers: details.requestHeaders,
    });
    callback({ requestHeaders: details.requestHeaders });
  });

  session.webRequest.onHeadersReceived((details, callback) => {
    console.log(`[ClaudeOAuth][response] ${ details.statusCode } ${ details.url }`, {
      responseHeaders: details.responseHeaders,
    });
    callback({});
  });

  session.webRequest.onBeforeRedirect((details) => {
    console.log(`[ClaudeOAuth][redirect] ${ details.statusCode } ${ details.url } -> ${ details.redirectURL }`);
  });

  const codePromise = new Promise<string | null>((resolve) => {
    let resolved = false;
    const doResolve = (code: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };

    const handleUrl = (source: string, targetUrl: string) => {
      console.log(`[ClaudeOAuth][${ source }] ${ targetUrl }`);
      try {
        const parsed = new URL(targetUrl);
        console.log(`[ClaudeOAuth][parse] host=${ parsed.hostname } path=${ parsed.pathname } params=${ parsed.search }`);
        if (parsed.hostname.endsWith('claude.com') && parsed.pathname.includes('/oauth/code/callback')) {
          const code = parsed.searchParams.get('code');
          console.log(`[ClaudeOAuth] Intercepted callback, code=${ code ? '(present)' : '(missing)' }`);
          doResolve(code);
        }
      } catch { /* not a URL */ }
    };

    window.webContents.on('will-redirect', (_event, redirectUrl) => {
      handleUrl('will-redirect', redirectUrl);
    });
    window.webContents.on('will-navigate', (_event, navUrl) => {
      handleUrl('will-navigate', navUrl);
    });
    window.webContents.on('did-navigate', (_event, navUrl) => {
      handleUrl('did-navigate', navUrl);
    });
    window.webContents.on('did-navigate-in-page', (_event, navUrl) => {
      handleUrl('did-navigate-in-page', navUrl);
    });

    window.on('closed', () => {
      console.log('[ClaudeOAuth] Auth window closed');
      doResolve(null);
    });
  });

  window.loadURL(url);
  return { window, codePromise };
}

export function initClaudeOAuthEvents(): void {
  const ipcMainProxy = getIpcMainProxy(console);

  /**
   * Start the OAuth flow. Returns a promise that resolves with the token
   * when Claude CLI prints it. The renderer should listen for
   * 'claude-oauth:url' to know when to prompt the user (though we open
   * the browser ourselves via shell.openExternal).
   */
  ipcMainProxy.handle('claude-oauth:start', async(event: Electron.IpcMainInvokeEvent): Promise<{ token?: string; error?: string }> => {
    if (activeSession) {
      killActiveSession();
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
      let resolved = false;

      const doResolve = (result: { token?: string; error?: string }) => {
        if (resolved) return;
        resolved = true;
        try { ptyProcess.kill(); } catch { /* dead */ }
        try { session.authWindow?.close(); } catch { /* closed */ }
        if (activeSession === session) activeSession = null;
        resolve(result);
      };

      const timeout = setTimeout(() => {
        doResolve({ error: 'OAuth flow timed out after 5 minutes' });
      }, 5 * 60 * 1000);

      console.log('[ClaudeOAuth] Spawning claude setup-token in VM');

      ptyProcess.onData((data: string) => {
        const clean = stripAnsi(data);
        session.stdoutBuffer += clean;

        // Forward raw output to the renderer so it can show progress
        try {
          event.sender.send('claude-oauth:progress', clean);
        } catch { /* window closed */ }

        // Look for the OAuth URL — open it in an embedded BrowserWindow
        // and intercept the callback code when Anthropic redirects.
        if (!urlOpened) {
          const urlMatch = URL_PATTERN.exec(session.stdoutBuffer);
          if (urlMatch) {
            urlOpened = true;
            // Strip whitespace that the terminal inserted to wrap the URL across lines
            const url = urlMatch[1].replace(/\s+/g, '');
            console.log(`[ClaudeOAuth] Opening auth URL in embedded window: ${ url }`);
            try {
              event.sender.send('claude-oauth:url', url);
            } catch { /* window closed */ }

            const { window, codePromise } = openAuthWindow(url);
            session.authWindow = window;

            codePromise.then((code) => {
              if (!code) {
                console.warn('[ClaudeOAuth] Auth window closed without a code');
                return;
              }
              console.log('[ClaudeOAuth] Got code, sending to CLI');
              try { session.authWindow?.close(); } catch { /* closed */ }
              session.authWindow = null;
              // Claude CLI is waiting at "Paste code here if prompted >"
              // Send the code followed by CR.
              try {
                ptyProcess.write(code + '\r');
              } catch (err) {
                console.warn('[ClaudeOAuth] Failed to write code to PTY:', err);
              }
            });
          }
        }

        // Check for token in output
        const token = extractToken(session.stdoutBuffer);
        if (token) {
          clearTimeout(timeout);
          console.log('[ClaudeOAuth] Token captured');
          doResolve({ token });
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        clearTimeout(timeout);
        if (!resolved) {
          // If we never got a token, check the buffer one more time
          const token = extractToken(session.stdoutBuffer);
          if (token) {
            doResolve({ token });
          } else {
            doResolve({
              error: `Claude setup-token exited (code=${ exitCode }, signal=${ signal }) without producing a token`,
            });
          }
        }
      });
    });
  });

  /**
   * Cancel an in-progress OAuth flow.
   */
  ipcMainProxy.handle('claude-oauth:cancel', async() => {
    killActiveSession();
  });

  /**
   * Send user input to the Claude CLI (for pasting the auth code if needed).
   */
  ipcMainProxy.handle('claude-oauth:send-input', async(_event: unknown, input: string) => {
    if (activeSession) {
      activeSession.ptyProcess.write(input);
    }
  });
}
