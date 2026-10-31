// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Claude Code OAuth handler.
 *
 * Runs `claude setup-token` inside the Sulla VM via PTY, opens the OAuth
 * URL in an embedded BrowserWindow, intercepts the callback to extract
 * the authorization code, feeds it back to the CLI, and captures the
 * long-lived OAuth token when Claude CLI prints it.
 *
 * First-run tokens remain in main-process memory until the vault is ready.
 */

import * as childProcess from 'child_process';

import { app, BrowserWindow } from 'electron';
import * as pty from 'node-pty';

import { isSullaRuntimeActive } from '@pkg/backend/sullaRuntime/state';
import { withSuppressedConnectionStatus } from '@pkg/agent/integrations/integrationFlags';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { createContainedAuthWindow } from '@pkg/main/containedAuthWindow';
import { queuePendingCredential } from '@pkg/main/firstRun/pendingCredentials';
import { firstRunTrace, scrubText } from '@pkg/main/firstRun/firstRunTrace';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import * as window from '@pkg/window';
import { getConfiguredApprovalClient, usesContainerVaultAuthority } from '@pkg/vault-broker';

const CLAUDE_INTEGRATION_ID = 'claude-code';
const CLAUDE_OAUTH_ACCOUNT_ID = 'oauth';

const console = Logging.background;

// Claude CLI emits the token on its own line after completion.
// While output is still streaming, a chunk can end mid-token: require the
// whitespace that follows it. Once the CLI has exited the buffer is complete.
const TOKEN_PATTERN = /(sk-ant-oat01-[A-Za-z0-9_-]{40,})(?=[\s\x07\x1B])/;
const FINAL_TOKEN_PATTERN = /(sk-ant-oat01-[A-Za-z0-9_-]{40,})/;

// Match the OAuth URL even when the terminal wraps it across lines.
const URL_PATTERN = /(https?:\/\/(?:claude\.com|claude\.ai)\/[\s\S]+?state=[A-Za-z0-9_-]+)(?=[\s\x07\x1B])/;

type OAuthFailureReason = 'user-closed' | 'timeout' | 'offline' | 'cli-missing' | 'vm-not-ready' | 'provider-error';
type OAuthResult = { success?: boolean; error?: string; reason?: OAuthFailureReason };

// Claude CLI prints this after a bad code; we could retry but for now we bail.
// Any OAuth failure from setup-token (wording changes between CLI versions).
const INVALID_CODE_PATTERN = /OAuth error:/i;

interface OAuthSession {
  ptyProcess:   pty.IPty;
  rawBuffer:    string;
  stdoutBuffer: string;
  authWindow:   BrowserWindow | null;
}

let activeSession: OAuthSession | null = null;

function stripAnsi(text: string): string {
  return text
    // Terminal hyperlinks (OSC 8): keep only the complete target URL, padded
    // with spaces. Newer Claude CLIs print the sign-in URL this way, wrapped
    // in escape codes rather than followed by whitespace.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\]8;[^;\x07\x1B]*;([^\x07\x1B]*)(?:\x1B\\|\x07)/g, (_m, target: string) => (target ? ` ${ target } ` : ' '))
    // Any other complete OSC sequence (titles, notifications, queries).
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07\x1B]*(?:\x1B\\|\x07)/g, '')
    // CSI sequences (colors, cursor moves, private modes).
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;?<>=]*[a-zA-Z~]/g, '');
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

/** Whether the Sulla runtime VM is up; Desktop owns it, so this needs no process spawn. */
async function isVMRunning(): Promise<boolean> {
  return isSullaRuntimeActive();
}


/**
 * The guest image ships Node and npm but not the Claude CLI, so a fresh
 * install has no `claude` for `setup-token`. Install the pinned version
 * (global npm installs land on the persistent data disk) when it's missing.
 */

/**
 * The guest's init does not mount devpts, so the VM has no pseudo-terminals,
 * and `sulla-runtime exec` streams plain stdin/stdout without a terminal.
 * `claude setup-token` is an interactive terminal app: with no terminal it
 * prints nothing and waits forever. Mount devpts when missing, and run the
 * CLI inside this pseudo-terminal relay (python3 ships in the guest image).
 */
const MOUNT_DEVPTS = 'mountpoint -q /dev/pts || { mkdir -p /dev/pts && mount -t devpts devpts /dev/pts -o newinstance,ptmxmode=0666,mode=0620,gid=5; }';
const GUEST_PTY_RELAY = "import fcntl, os, pty, select, struct, sys, termios\npid, fd = pty.fork()\nif pid == 0:\n    os.environ.setdefault(\"TERM\", \"xterm-256color\")\n    os.execvp(sys.argv[1], sys.argv[1:])\nfcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack(\"HHHH\", 30, 1000, 0, 0))\ninputs = [fd, 0]\nwhile True:\n    ready, _, _ = select.select(inputs, [], [])\n    if fd in ready:\n        try:\n            data = os.read(fd, 65536)\n        except OSError:\n            break\n        if not data:\n            break\n        os.write(1, data)\n    if 0 in ready:\n        data = os.read(0, 65536)\n        if data:\n            # The host side runs this through a cooked terminal, which turns\n            # Enter (\\r) into \\n; interactive CLIs only submit on \\r.\n            os.write(fd, data.replace(b\"\\n\", b\"\\r\"))\n        else:\n            inputs.remove(0)\n_, status = os.waitpid(pid, 0)\nsys.exit(os.waitstatus_to_exitcode(status))";

async function ensureClaudeCliInVM(): Promise<void> {
  firstRunTrace('claude', 'CLI ensure started');
  const { ensureGuestCli } = await import('@pkg/backend/guestClis');
  await ensureGuestCli('claude');
  firstRunTrace('claude', 'CLI ensure completed', { success: true });
  const script = MOUNT_DEVPTS;
  await new Promise<void>((resolve, reject) => {
    const proc = childProcess.spawn(paths.sullaRuntime, ['exec', '--', 'sh', '-lc', script], { env: { ...process.env } });
    let output = '';
    const timer = setTimeout(() => { try { proc.kill() } catch { /* dead */ } reject(new Error('mounting the VM pseudo-terminal timed out after 30 seconds')) }, 30_000);
    proc.stdout.on('data', (d) => { output += d.toString() });
    proc.stderr.on('data', (d) => { output += d.toString() });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`mounting the VM pseudo-terminal exited ${ code }: ${ output.trim().split('\n').slice(-3).join(' ') }`));
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err) });
  });
}

function assertFirstRunOrMainSender(event: Electron.IpcMainInvokeEvent): void {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (sender !== window.getWindow('first-run') && sender !== window.getWindow('main-agent')) {
    throw new Error('Claude OAuth is only available from a trusted Sulla window');
  }
}

/**
 * Persist the captured OAuth token into the integration vault so the
 * Integrations page reflects the connection and ClaudeCodeService can
 * pick it up on its next request.
 *
 * Clears any api_key stored under the same account (the two are mutually
 * exclusive — OAuth supersedes a manually-pasted key).
 */
async function persistTokenToVault(token: string): Promise<void> {
  if (usesContainerVaultAuthority()) {
    const client = getConfiguredApprovalClient();
    if (!client) throw new Error('Desktop vault session service is unavailable');
    await client.importIntegrationAccount(CLAUDE_INTEGRATION_ID, {
      accountId: CLAUDE_OAUTH_ACCOUNT_ID,
      label: 'Claude Code OAuth',
      values: { oauth_token: token, api_key: '', account_label: 'Claude Code OAuth' },
      active: true,
      connected: true,
    });
    console.log('[ClaudeOAuth] Token persisted to integration vault');
    return;
  }
  const svc = getIntegrationService();
  // Wrap connection-status write in the suppression flag so the Integrations
  // listener in agent/integrations/index.ts doesn't try to spin up a runtime
  // client for claude-code (there is no IntegrationRegistry factory for it —
  // credentials are consumed directly by ClaudeCodeService).
  await withSuppressedConnectionStatus(async() => {
      await svc.setMultipleValues([
        {
          integration_id: CLAUDE_INTEGRATION_ID,
          account_id:     CLAUDE_OAUTH_ACCOUNT_ID,
          property:       'oauth_token',
          value:          token,
        },
        {
          integration_id: CLAUDE_INTEGRATION_ID,
          account_id:     CLAUDE_OAUTH_ACCOUNT_ID,
          property:       'api_key',
          value:          '',
        },
        {
          integration_id: CLAUDE_INTEGRATION_ID,
          account_id:     CLAUDE_OAUTH_ACCOUNT_ID,
          property:       'account_label',
          value:          'Claude Code OAuth',
        },
      ]);
      await svc.setConnectionStatus(CLAUDE_INTEGRATION_ID, true, CLAUDE_OAUTH_ACCOUNT_ID);
      await svc.setActiveAccount(CLAUDE_INTEGRATION_ID, CLAUDE_OAUTH_ACCOUNT_ID);
  });
  console.log('[ClaudeOAuth] Token persisted to integration vault');
}

// claude.ai's login session cookie.
const CLAUDE_SESSION_COOKIE = 'sessionKey';
// Pages only a logged-in user lands on.
const LOGGED_IN_PATH = /^\/(new|chats?|recents|projects?)(\/|$)/;
// Enough to recover from a dropped authorize step, never a reload loop.
const MAX_AUTHORIZE_RETURNS = 3;

function isClaudeHost(hostname: string): boolean {
  return hostname === 'claude.ai' || hostname.endsWith('.claude.ai') || hostname === 'claude.com' || hostname.endsWith('.claude.com');
}

/**
 * Open the OAuth URL in an Electron BrowserWindow and intercept the
 * callback to extract the authorization code and state.
 */
function openAuthWindow(url: string): { window: BrowserWindow; codePromise: Promise<string | null> } {
  let resolveCode!: (code: string | null) => void;
  let resolved = false;
  const codePromise = new Promise<string | null>((resolve) => {
    resolveCode = resolve;
  });
  const doResolve = (code: string | null) => {
    if (resolved) return;
    resolved = true;
    firstRunTrace('claude', 'auth window resolved', { codeReceived: !!code, codeLength: code?.length ?? 0 });
    resolveCode(code);
  };

  // Returns true for the OAuth callback. Checked in the window and in every
  // popup, since claude.com can finish sign-in in a popup (e.g. Google SSO).
  const handleUrl = (targetUrl: string): boolean => {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.hostname.endsWith('claude.com') && parsed.pathname.includes('/oauth/code/callback')) {
        const code = parsed.searchParams.get('code');
        const state = parsed.searchParams.get('state');
        // Claude CLI expects "code#state" format.
        const combined = code && state ? `${ code }#${ state }` : code;
        console.log(`[ClaudeOAuth] Intercepted callback, combined=${ combined ? `${ combined.length } chars` : '(missing)' }`);
        if (combined) {
          doResolve(combined);
          return true;
        }
      }
      // claude.ai drops the authorize step when it sends a logged-out user to
      // log in, and leaves them on the Claude app after login. Once a
      // logged-in page shows up, go back to the authorize URL.
      if (isClaudeHost(parsed.hostname) && LOGGED_IN_PATH.test(parsed.pathname)) {
        returnToAuthorize(`landed on ${ parsed.pathname }`);
      } else if (isClaudeHost(parsed.hostname) && parsed.pathname === '/') {
        // '/' is both the login page and the app home, so ask the cookie jar.
        window.webContents.session.cookies.get({ name: CLAUDE_SESSION_COOKIE }).then((found) => {
          const signedIn = found.some(c => isClaudeHost((c.domain ?? '').replace(/^\./, '')));
          console.log(`[ClaudeOAuth] At claude.ai home — signed in: ${ signedIn ? 'yes' : 'no' }`);
          if (signedIn) returnToAuthorize('already signed in at home page');
        }).catch(() => { /* cookie jar unavailable */ });
      }
    } catch { /* not a URL */ }
    return false;
  };

  // Contained so claude.com can't hand sign-in to the host's Claude app.
  const window = createContainedAuthWindow({
    width:     720,
    height:    800,
    title:     'Sign in with Claude',
    partition: 'persist:claude-oauth',
    logPrefix: '[ClaudeOAuth]',
    onUrl:     handleUrl,
  });

  let returns = 0;
  function returnToAuthorize(reason: string) {
    if (resolved || window.isDestroyed() || returns >= MAX_AUTHORIZE_RETURNS) return;
    returns++;
    console.log(`[ClaudeOAuth] Signed in (${ reason }) — returning to the authorize page (${ returns }/${ MAX_AUTHORIZE_RETURNS })`);
    window.loadURL(url).catch((err) => console.warn('[ClaudeOAuth] Could not reload the authorize page:', err));
  }

  // Login sets claude.ai's session cookie, whichever page or popup it
  // happened in. That's the reliable signal to resume the authorize step.
  const cookies = window.webContents.session.cookies;
  const onCookie = (_e: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
    if (!removed && cookie.name === CLAUDE_SESSION_COOKIE && isClaudeHost((cookie.domain ?? '').replace(/^\./, ''))) {
      returnToAuthorize('session cookie set');
    }
  };
  cookies.on('changed', onCookie);

  window.on('closed', () => {
    cookies.removeListener('changed', onCookie);
    doResolve(null);
  });

  firstRunTrace('claude', 'auth window opened', { urlLength: url.length });
  console.log(`[ClaudeOAuth] Opening auth window: ${ redactUrl(url) }`);
  window.loadURL(url);
  return { window, codePromise };
}

export function initClaudeOAuthEvents(): void {
  const ipcMainProxy = getIpcMainProxy(console);

  /**
   * Start the OAuth flow. Returns the captured token, or an error message.
   */
  ipcMainProxy.handle('claude-oauth:start', async(event: Electron.IpcMainInvokeEvent, options?: { firstRun?: boolean }): Promise<OAuthResult> => {
    assertFirstRunOrMainSender(event);
    const vmRunning = await isVMRunning();
    firstRunTrace('claude', 'flow started', { firstRun: !!options?.firstRun, vmRunning });
    if (!(app?.isPackaged ?? true) && process.env.SULLA_E2E === '1') {
      if (process.env.SULLA_E2E_OAUTH_RESULT === 'closed') return { success: false, error: 'Sign-in was closed.', reason: 'user-closed' };
      const endpoint = process.env.SULLA_E2E_OAUTH_URL;
      if (!endpoint) return { success: false, error: 'Sign-in is unavailable.', reason: 'provider-error' };
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ integrationId: CLAUDE_INTEGRATION_ID }) });
      if (!response.ok) return { success: false, error: 'Sign-in failed.', reason: 'provider-error' };
      const tokens = await response.json() as Record<string, string>;
      queuePendingCredential({ integrationId: CLAUDE_INTEGRATION_ID, accountId: CLAUDE_OAUTH_ACCOUNT_ID, values: tokens, activate: true });
      return { success: true };
    }
    if (activeSession) killActiveSession();

    // Bail out early with a clear message if the VM isn't ready.
    if (!vmRunning) {
      firstRunTrace('claude', 'flow resolved', { success: false, reason: 'vm-not-ready' });
      return { error: 'Your private workspace is still starting. Try again in a moment.', reason: 'vm-not-ready' };
    }

    const stage = (text: string) => {
      firstRunTrace('claude', 'stage', { status: text });
      try { event.sender.send('claude-oauth:stage' as any, text) } catch { /* window closed */ }
    };
    stage('Setting up Claude in your private workspace…');
    try {
      await ensureClaudeCliInVM();
    } catch (err) {
      firstRunTrace('claude', 'CLI ensure completed', { success: false, error: err instanceof Error ? err.message : String(err) });
      console.warn('[ClaudeOAuth] Could not install the Claude CLI in the VM:', err);
      return { error: 'Claude could not be reached. Check your connection, then try again.', reason: 'offline' };
    }

    return await new Promise((resolve) => {
      const runtimePath = paths.sullaRuntime;

      const ptyProcess = pty.spawn(runtimePath, ['exec', '--', 'python3', '-c', GUEST_PTY_RELAY, 'claude', 'setup-token'], {
        name: 'xterm-256color',
        cols: 1000,
        rows: 30,
        env:  {
          ...process.env,
          
          TERM:      'xterm-256color',
        } as Record<string, string>,
      });
      firstRunTrace('claude', 'PTY spawned');

      const session: OAuthSession = { ptyProcess, rawBuffer: '', stdoutBuffer: '', authWindow: null };
      activeSession = session;

      let urlOpened = false;
      let codeSent = false;
      let enterSent = false;
      let resolved = false;
      let noUrlTimeout: ReturnType<typeof setTimeout>;
      let noTokenTimeout: ReturnType<typeof setTimeout> | undefined;

      const doResolve = async(result: { token?: string; error?: string; reason?: OAuthFailureReason }) => {
        if (resolved) return;
        resolved = true;
        if (noUrlTimeout) clearTimeout(noUrlTimeout);
        if (noTokenTimeout) clearTimeout(noTokenTimeout);
        try { ptyProcess.kill() } catch { /* dead */ }
        try { session.authWindow?.close() } catch { /* closed */ }
        if (activeSession === session) activeSession = null;
        firstRunTrace('claude', 'flow resolving', { success: !!result.token, reason: result.reason, error: result.error });

        if (result.token) {
          if (options?.firstRun) {
            // First run has no durable secret store. Keep the token in main
            // memory until lane 1b's vault-ready hook flushes it.
            queuePendingCredential({
              integrationId: CLAUDE_INTEGRATION_ID,
              accountId: CLAUDE_OAUTH_ACCOUNT_ID,
              values: { oauth_token: result.token, api_key: '', account_label: 'Claude Code OAuth' },
              activate: true,
            });
            const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');
            await getModelProviderService().reconcilePrimaryProvider(false, CLAUDE_INTEGRATION_ID);
          } else {
            try {
              await persistTokenToVault(result.token);
            } catch {
              resolve({ success: false, error: 'Claude signed in, but the sign-in could not be saved.', reason: 'provider-error' });
              return;
            }
          }
        }
        firstRunTrace('claude', 'flow resolved', { success: !!result.token, reason: result.reason, error: result.error });
        resolve(result.token ? { success: true } : result);
      };

      const timeout = setTimeout(() => {
        firstRunTrace('claude', 'flow timeout fired', { outputTail: scrubText(session.stdoutBuffer).replace(/https?:\/\/\S+/g, '[link]').replace(/\s+/g, ' ').trim().slice(-400) });
        void doResolve({ error: 'Claude sign-in took too long. Try again.', reason: 'timeout' });
      }, 5 * 60 * 1000);
      noUrlTimeout = setTimeout(() => {
        const tail = session.stdoutBuffer.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]').replace(/https?:\/\/\S+/g, '[link]').replace(/\s+/g, ' ').trim().slice(-240);
        firstRunTrace('claude', 'URL timeout fired', { outputTail: tail });
        console.warn(`[ClaudeOAuth] No sign-in URL after 45 seconds. Output tail: ${ tail }`);
        void doResolve({ error: 'Claude did not open a sign-in page. Try again.', reason: 'provider-error' });
      }, 45_000);

      console.log('[ClaudeOAuth] Starting OAuth flow');
      stage('Starting Claude sign-in…');

      ptyProcess.onData((data: string) => {
        const clean = stripAnsi(data);
        // Clean the whole stream, not each chunk: an escape sequence split
        // across chunks would otherwise survive and hide the URL or token.
        session.rawBuffer += data;
        session.stdoutBuffer = stripAnsi(session.rawBuffer);

        // Stream progress to the renderer (UI status line)
        if (!options?.firstRun) {
          try {
            event.sender.send('claude-oauth:progress', clean);
          } catch { /* window closed */ }
        }

        // Early exit on explicit OAuth error
        if (INVALID_CODE_PATTERN.test(session.stdoutBuffer)) {
          clearTimeout(timeout);
          const detail = /OAuth error:\s*([^\n]*)/i.exec(session.stdoutBuffer)?.[1]?.trim();
          void doResolve({ error: `Claude didn't accept the sign-in${ detail ? `: ${ detail }` : '.' } Try again.`, reason: 'provider-error' });
          return;
        }

        // 1) Detect the auth URL and open our embedded window
        if (!urlOpened) {
          const urlMatch = URL_PATTERN.exec(session.stdoutBuffer);
          if (urlMatch) {
            clearTimeout(noUrlTimeout);
            urlOpened = true;
            const url = urlMatch[1].replace(/\s+/g, '');
            firstRunTrace('claude', 'URL detected', { urlLength: url.length });

            try {
              event.sender.send('claude-oauth:url', url);
            } catch { /* window closed */ }
            stage('Finish signing in to Claude in the window that just opened.');

            const { window, codePromise } = openAuthWindow(url);
            session.authWindow = window;

            codePromise.then((code) => {
              if (!code) {
                // Don't leave `claude setup-token` waiting in the VM forever.
                console.log('[ClaudeOAuth] Auth window closed without a code');
                clearTimeout(timeout);
                void doResolve({ error: 'Sign-in was closed.', reason: 'user-closed' });
                return;
              }
              console.log(`[ClaudeOAuth] Writing ${ code.length } chars to PTY`);
              firstRunTrace('claude', 'code written', { codeLength: code.length });
              try { session.authWindow?.close() } catch { /* closed */ }
              session.authWindow = null;
              try {
                ptyProcess.write(code);
                codeSent = true;
                // The CLI answers within seconds once the code is submitted.
                // Don't leave the user on a spinner for the full 5 minutes.
                noTokenTimeout = setTimeout(() => {
                  console.warn(`[ClaudeOAuth] No token 60 seconds after the code was sent (enterSent=${ enterSent })`);
                  firstRunTrace('claude', 'token timeout fired', { enterSent });
                  void doResolve({ error: 'Claude did not finish signing in. Try again.', reason: 'timeout' });
                }, 60_000);
                // Newer CLIs echo the pasted code as plain text, not asterisks,
                // so the echo check below never fires. Submit shortly after the
                // write either way; whichever path runs first sends Enter once.
                setTimeout(() => {
                  if (enterSent || resolved) return;
                  enterSent = true;
                  firstRunTrace('claude', 'Enter sent', { path: 'timer' });
                  console.log('[ClaudeOAuth] Submitting code');
                  try { ptyProcess.write('\r') } catch (err) { console.warn('[ClaudeOAuth] Failed to send Enter:', err) }
                }, 400);
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
          firstRunTrace('claude', 'Enter sent', { path: 'echo' });
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
          firstRunTrace('claude', 'token captured', { tokenLength: tokenMatch[1].length });
          void doResolve({ token: tokenMatch[1] });
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        clearTimeout(timeout);
        clearTimeout(noUrlTimeout);
        console.log(`[ClaudeOAuth] PTY exited code=${ exitCode } signal=${ signal }`);
        firstRunTrace('claude', 'PTY exited', { exitCode, signal, tokenSeen: FINAL_TOKEN_PATTERN.test(session.stdoutBuffer) });
        if (!resolved) {
          const tokenMatch = FINAL_TOKEN_PATTERN.exec(session.stdoutBuffer);
          if (tokenMatch) {
            void doResolve({ token: tokenMatch[1] });
          } else {
            console.warn('[ClaudeOAuth] setup-token ended without a token');
            void doResolve({
              error: exitCode === 127
                ? 'Claude isn\'t installed in the Sulla VM yet. Try again in a moment.'
                : 'Claude sign-in ended before it finished. Try again.',
              reason: exitCode === 127 ? 'cli-missing' : 'provider-error',
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
