// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { getIpcMainProxy } from '@pkg/main/ipcMain';

import type { CloudRecoveryKeyActions } from '../account/CloudRecoveryKeyActions';
import type { CloudSignInCompletion } from '../account/CloudSignInCompletion';
import type { CloudSignInService } from '../account/CloudSignInService';
import type { AuthResult, AuthStatus, CloudAuthStatusService } from './CloudAuthStatusService';
import type { CloudRecoveryKeyNoticeStore } from './CloudRecoveryKeyNoticeStore';
import type { CloudSignOutService } from './CloudSignOutService';

type IpcMainProxy = ReturnType<typeof getIpcMainProxy>;

/**
 * Binds the `sulla-cloud:*` IPC channels to the Cloud auth services. Channel
 * names, argument order and registration order are the renderer contract; the
 * handlers only translate arguments and delegate.
 */
export class CloudAuthIpcRegistrar {
  constructor(
    private readonly status: CloudAuthStatusService,
    private readonly completion: CloudSignInCompletion,
    private readonly signIn: CloudSignInService,
    private readonly signOut: CloudSignOutService,
    private readonly recoveryKeys: CloudRecoveryKeyActions,
    private readonly notices: CloudRecoveryKeyNoticeStore,
  ) {}

  register(ipcMainProxy: IpcMainProxy): void {
    ipcMainProxy.handle('sulla-cloud:first-run-session', async() => this.completion.firstRunSession());
    // Sulla Cloud deliberately does not reveal whether an email has an account
    // (prelogin returns a decoy KDF for unknown emails), so this cannot tell.
    // The first-run copy stays neutral until email-continue reports accountExists.
    ipcMainProxy.handle('sulla-cloud:account-exists', async() => ({ exists: null }));
    ipcMainProxy.handle('sulla-cloud:email-code-availability', async() => ({ available: true }));
    ipcMainProxy.handle('sulla-cloud:password-reset-availability' as any, async() => this.signIn.passwordResetAvailable());
    ipcMainProxy.handle('sulla-cloud:first-run-sign-out' as any, async() => this.completion.firstRunSignOut());
    ipcMainProxy.handle('sulla-cloud:recovery-key-pending', async() => this.notices.pending());
    ipcMainProxy.handle('sulla-cloud:recovery-key-shown', async() => { this.notices.clear() });

    ipcMainProxy.handle('sulla-cloud:get-status', async(): Promise<AuthStatus> => {
      return this.status.build();
    });

    ipcMainProxy.handle('sulla-cloud:recovery-key-status', async() => this.recoveryKeys.status());
    ipcMainProxy.handle('sulla-cloud:recovery-key-rotate', async() => this.recoveryKeys.rotate());
    ipcMainProxy.handle('sulla-cloud:recovery-key-copy', async(_event: unknown, recoveryKey: string) => this.recoveryKeys.copy(recoveryKey));
    ipcMainProxy.handle('sulla-cloud:recovery-key-print', async(_event: unknown, recoveryKey: string) => this.recoveryKeys.print(recoveryKey));
    ipcMainProxy.handle('sulla-cloud:recovery-key-save', async(_event: unknown, recoveryKey: string) => this.recoveryKeys.save(recoveryKey));

    ipcMainProxy.handle('sulla-cloud:send-otp', async(_event: unknown, phone: string): Promise<AuthResult> => this.signIn.sendOtp(phone));
    ipcMainProxy.handle('sulla-cloud:verify-otp', async(_event: unknown, phone: string, code: string): Promise<AuthResult> => this.signIn.verifyOtp(phone, code));
    ipcMainProxy.handle('sulla-cloud:email-login', async(_event: unknown, email: string, password: string): Promise<AuthResult> => this.signIn.emailLogin(email, password));
    ipcMainProxy.handle('sulla-cloud:email-code-start', async(_event: unknown, ...args: unknown[]) => {
      const [email] = args as [string];
      return this.signIn.emailCodeStart(email);
    });
    ipcMainProxy.handle('sulla-cloud:password-reset-start' as any, async(_event: unknown, ...args: unknown[]) => {
      const [email] = args as [string];
      return this.signIn.passwordResetStart(email);
    });
    ipcMainProxy.handle('sulla-cloud:password-reset-complete' as any, async(_event: unknown, ...args: unknown[]) => {
      const [email, code, password] = args as [string, string, string];
      return this.signIn.passwordResetComplete(email, code, password);
    });
    ipcMainProxy.handle('sulla-cloud:email-code-verify', async(_event: unknown, email: string, code: string, name?: string) => this.signIn.emailCodeVerify(email, code, name));
    ipcMainProxy.handle('sulla-cloud:email-continue', async(_event: unknown, email: string, password: string, name?: string) => this.signIn.emailContinue(email, password, name));
    ipcMainProxy.handle('sulla-cloud:email-register', async(_event: unknown, email: string, password: string, name?: string): Promise<AuthResult> => this.signIn.emailRegister(email, password, name));
    ipcMainProxy.handle('sulla-cloud:apple-sign-in', async(_event: unknown, identityToken: string, fullName?: string, email?: string): Promise<AuthResult> => this.signIn.appleSignIn(identityToken, fullName, email));
    ipcMainProxy.handle('sulla-cloud:apple-sign-in-browser', async(): Promise<AuthResult> => this.signIn.appleSignInBrowser());
    ipcMainProxy.handle('sulla-cloud:logout', async(): Promise<AuthStatus> => this.signOut.logout());
  }
}
