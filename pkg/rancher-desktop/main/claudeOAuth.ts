/**
 * Claude Code OAuth handler.
 *
 * Runs `claude setup-token` inside the Lima VM via PTY, intercepts the
 * OAuth URL that Claude CLI prints, opens it in the host's default browser,
 * and captures the long-lived OAuth token from stdout when Claude prints it.
 */

import * as pty from 'node-pty';
import { shell } from 'electron';
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

const URL_PATTERN = /(https?:\/\/[^\s]+)/;

interface OAuthSession {
  ptyProcess: pty.IPty;
  stdoutBuffer: string;
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
    activeSession = null;
  }
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

      const session: OAuthSession = { ptyProcess, stdoutBuffer: '' };
      activeSession = session;

      let urlOpened = false;
      let resolved = false;

      const doResolve = (result: { token?: string; error?: string }) => {
        if (resolved) return;
        resolved = true;
        try { ptyProcess.kill(); } catch { /* dead */ }
        if (activeSession === session) activeSession = null;
        resolve(result);
      };

      const timeout = setTimeout(() => {
        doResolve({ error: 'OAuth flow timed out after 5 minutes' });
      }, 5 * 60 * 1000);

      ptyProcess.onData((data: string) => {
        const clean = stripAnsi(data);
        session.stdoutBuffer += clean;

        // Forward raw output to the renderer so it can show progress
        try {
          event.sender.send('claude-oauth:progress', clean);
        } catch { /* window closed */ }

        // Look for an OAuth URL — open it in the host browser once
        if (!urlOpened) {
          const urlMatch = URL_PATTERN.exec(session.stdoutBuffer);
          if (urlMatch && urlMatch[1].includes('anthropic.com')) {
            urlOpened = true;
            const url = urlMatch[1];
            console.log(`[ClaudeOAuth] Opening auth URL: ${ url }`);
            shell.openExternal(url).catch((err) => {
              console.warn('[ClaudeOAuth] Failed to open browser:', err);
            });
            try {
              event.sender.send('claude-oauth:url', url);
            } catch { /* window closed */ }
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
