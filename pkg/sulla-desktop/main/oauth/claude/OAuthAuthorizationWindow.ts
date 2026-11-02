// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BrowserWindow } from 'electron';

import { createContainedAuthWindow } from '@pkg/main/containedAuthWindow';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import { isClaudeHost, isClaudeOAuthCallbackUrl } from '@pkg/utils/claudeOAuthContract';

const CLAUDE_SESSION_COOKIE = 'sessionKey';
const LOGGED_IN_PATH = /^\/(new|chats?|recents|projects?)(\/|$)/;
const MAX_AUTHORIZE_RETURNS = 3;

/** Contained, state-checking browser surface for Claude authorization. */
export class OAuthAuthorizationWindow {
  private window: BrowserWindow | null = null;
  private settled = false;
  private authorizeReturns = 0;
  private readonly expectedState: string;

  constructor(private readonly authorizeUrl: string) {
    const parsed = new URL(authorizeUrl);
    const state = parsed.searchParams.get('state');

    if (!state) throw new Error('Claude authorize URL did not include state.');
    this.expectedState = state;
  }

  open(): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const finish = (code: string | null) => {
        if (this.settled) return;
        this.settled = true;
        firstRunTrace('claude', 'auth window resolved', { codeReceived: !!code, codeLength: code?.length ?? 0 });
        resolve(code);
      };
      const handleUrl = (target: string): boolean => {
        try {
          const parsed = new URL(target);

          if (isClaudeOAuthCallbackUrl(target)) {
            const code = parsed.searchParams.get('code');
            const state = parsed.searchParams.get('state');

            if (!code || state !== this.expectedState) {
              this.settled = true;
              reject(new Error('Claude returned an invalid OAuth state.'));
              this.close();
              return true;
            }
            finish(`${ code }#${ state }`);
            return true;
          }
          if (isClaudeHost(parsed.hostname) && LOGGED_IN_PATH.test(parsed.pathname)) this.returnToAuthorize();
          else if (isClaudeHost(parsed.hostname) && parsed.pathname === '/') this.returnIfSignedIn();
        } catch { /* malformed navigation is blocked by the container */ }
        return false;
      };

      try {
        this.window = createContainedAuthWindow({
          width: 720, height: 800, title: 'Sign in with Claude', partition: 'persist:claude-oauth', logPrefix: '[ClaudeOAuth]',
          // No host allowlist: Claude's login embeds Cloudflare challenges and
          // SSO providers load from many domains. The contained window already
          // blocks hand-offs to other apps; the callback is state-checked below.
          onUrl: handleUrl,
        });
        const cookies = this.window.webContents.session.cookies;
        const onCookie = (_event: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
          if (!removed && cookie.name === CLAUDE_SESSION_COOKIE && isClaudeHost((cookie.domain ?? '').replace(/^\./, ''))) this.returnToAuthorize();
        };

        cookies.on('changed', onCookie);
        this.window.on('closed', () => {
          cookies.removeListener('changed', onCookie);
          this.window = null;
          finish(null);
        });
        firstRunTrace('claude', 'auth window opened', { urlLength: this.authorizeUrl.length });
        this.window.loadURL(this.authorizeUrl).catch((error) => {
          this.settled = true;
          reject(error);
          this.close();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  close(): void {
    try { this.window?.close() } catch { /* already closed */ }
    this.window = null;
  }


  private returnToAuthorize(): void {
    if (this.settled || !this.window || this.window.isDestroyed() || this.authorizeReturns >= MAX_AUTHORIZE_RETURNS) return;
    this.authorizeReturns++;
    this.window.loadURL(this.authorizeUrl).catch(() => undefined);
  }

  private returnIfSignedIn(): void {
    const current = this.window;

    if (!current) return;
    current.webContents.session.cookies.get({ name: CLAUDE_SESSION_COOKIE }).then((cookies) => {
      if (cookies.some(cookie => isClaudeHost((cookie.domain ?? '').replace(/^\./, '')))) this.returnToAuthorize();
    }).catch(() => undefined);
  }
}
