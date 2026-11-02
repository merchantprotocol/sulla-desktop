// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import { claudeOAuthFailure, type ClaudeOAuthResult } from '@pkg/utils/claudeOAuthContract';
import Logging from '@pkg/utils/logging';

import { ClaudeCliUnavailableError, ClaudeSetupTokenAdapter } from './ClaudeSetupTokenAdapter';
import { OAuthAuthorizationWindow } from './OAuthAuthorizationWindow';

const console = Logging.background;

interface CoordinatorSession {
  key:          string;
  requesterId:  number;
  requester:    Electron.WebContents;
  attemptId:    string;
  adapter:      ClaudeSetupTokenAdapter;
  authWindow:   OAuthAuthorizationWindow | null;
  timers:       Set<ReturnType<typeof setTimeout>>;
  resolve:      (result: ClaudeOAuthResult) => void;
  settled:      boolean;
  requesterDestroyed: () => void;
}

export interface ClaudeOAuthStartOptions {
  firstRun?: boolean;
}

export class ClaudeOAuthCoordinator {
  private readonly sessions = new Map<string, CoordinatorSession>();
  private readonly currentAttempt = new Map<number, string>();
  private nextAttempt = 0;

  constructor(private readonly saveToken: (token: string, firstRun: boolean) => Promise<void>) {}

  async start(event: Electron.IpcMainInvokeEvent, options: ClaudeOAuthStartOptions = {}): Promise<ClaudeOAuthResult> {
    const requesterId = event.sender.id;
    const previous = this.currentAttempt.get(requesterId);

    // A repeated click may retire this requester's previous attempt, but never
    // touches a session owned by another BrowserWindow.
    if (previous) this.finish(this.sessions.get(previous), claudeOAuthFailure('cancelled', 'Sign-in was replaced by a new attempt.'));

    const attemptId = `${ Date.now().toString(36) }-${ ++this.nextAttempt }`;
    const key = `${ requesterId }:${ attemptId }`;

    return await new Promise<ClaudeOAuthResult>((resolve) => {
      const session: CoordinatorSession = {
        key, requesterId, requester: event.sender, attemptId, adapter: new ClaudeSetupTokenAdapter(), authWindow: null, timers: new Set(), resolve, settled: false,
        requesterDestroyed: () => undefined,
      };

      session.requesterDestroyed = () => this.finish(session, claudeOAuthFailure('cancelled', 'Sign-in was closed.'));
      event.sender.once('destroyed', session.requesterDestroyed);

      this.sessions.set(key, session);
      this.currentAttempt.set(requesterId, key);
      void this.run(session, event, options).catch((error) => {
        console.warn('[ClaudeOAuth] Coordinator failure:', error);
        this.finish(session, claudeOAuthFailure('provider_error', 'Claude sign-in failed. Try again.'));
      });
    });
  }

  cancel(event: Electron.IpcMainInvokeEvent): ClaudeOAuthResult {
    const key = this.currentAttempt.get(event.sender.id);
    const session = key ? this.sessions.get(key) : undefined;
    const result = claudeOAuthFailure('cancelled', 'Sign-in was closed.');

    this.finish(session, result);
    return result;
  }

  private async run(session: CoordinatorSession, event: Electron.IpcMainInvokeEvent, options: ClaudeOAuthStartOptions): Promise<void> {
    const stage = (text: string) => {
      firstRunTrace('claude', 'stage', { status: text });
      try { event.sender.send('claude-oauth:stage' as any, text) } catch { /* requester closed */ }
    };

    stage('Setting up Claude in your private workspace…');
    try {
      const version = await session.adapter.prepare();

      firstRunTrace('claude', 'CLI version probed', { version });
    } catch (error) {
      this.finish(session, claudeOAuthFailure('cli_unavailable', 'Claude is not available in your private workspace yet. Try again in a moment.'));
      return;
    }
    if (session.settled) return;

    stage('Starting Claude sign-in…');
    this.addTimer(session, 5 * 60_000, () => this.finish(session, claudeOAuthFailure('timeout', 'Claude sign-in took too long. Try again.')));
    const urlTimer = this.addTimer(session, 45_000, () => this.finish(session, claudeOAuthFailure('provider_error', 'Claude did not open a sign-in page. Try again.')));

    try {
      const token = await session.adapter.run({
        // Terminal output ends with the long-lived token, so it never leaves the
        // main process. The renderer gets stage text and the final result only.
        onOutput: () => undefined,
        onAuthorizeUrl: url => {
          clearTimeout(urlTimer);
          session.timers.delete(urlTimer);
          void this.authorize(session, event, url, stage);
        },
      });

      if (session.settled) return;
      try {
        await this.saveToken(token, !!options.firstRun);
        this.finish(session, { status: 'success', success: true });
      } catch (error) {
        console.warn('[ClaudeOAuth] Sign-in succeeded but custody failed:', error);
        this.finish(session, claudeOAuthFailure('provider_error', 'Claude signed in, but the sign-in could not be saved.'));
      }
    } catch (error) {
      if (session.settled) return;
      this.finish(session, error instanceof ClaudeCliUnavailableError
        ? claudeOAuthFailure('cli_unavailable', 'Claude is not available in your private workspace yet. Try again in a moment.')
        : claudeOAuthFailure('provider_error', error instanceof Error ? `Claude didn't accept the sign-in: ${ error.message }` : 'Claude sign-in failed. Try again.'));
    }
  }

  private async authorize(session: CoordinatorSession, event: Electron.IpcMainInvokeEvent, url: string, stage: (text: string) => void): Promise<void> {
    if (session.settled) return;
    try { event.sender.send('claude-oauth:url', url) } catch { /* requester closed */ }
    stage('Finish signing in to Claude in the window that just opened.');
    try {
      session.authWindow = new OAuthAuthorizationWindow(url);
      const code = await session.authWindow.open();

      if (session.settled) return;
      if (!code) {
        this.finish(session, claudeOAuthFailure('cancelled', 'Sign-in was closed.'));
        return;
      }
      session.authWindow.close();
      session.authWindow = null;
      session.adapter.submitCode(code);
      this.addTimer(session, 60_000, () => this.finish(session, claudeOAuthFailure('timeout', 'Claude did not finish signing in. Try again.')));
    } catch (error) {
      console.warn('[ClaudeOAuth] Authorization window failed:', error);
      this.finish(session, claudeOAuthFailure('provider_error', 'Claude returned an invalid sign-in response. Try again.'));
    }
  }

  private addTimer(session: CoordinatorSession, delay: number, callback: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      callback();
    }, delay);

    session.timers.add(timer);
    return timer;
  }

  /** The only terminal exit for success, errors, timeout, replacement and cancel. */
  private finish(session: CoordinatorSession | undefined, result: ClaudeOAuthResult): void {
    if (!session || session.settled) return;
    session.settled = true;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    session.adapter.dispose();
    session.authWindow?.close();
    session.authWindow = null;
    session.requester.removeListener('destroyed', session.requesterDestroyed);
    this.sessions.delete(session.key);
    if (this.currentAttempt.get(session.requesterId) === session.key) this.currentAttempt.delete(session.requesterId);
    firstRunTrace('claude', 'flow resolved', { success: result.success, status: result.status, attemptId: session.attemptId });
    session.resolve(result);
  }
}
