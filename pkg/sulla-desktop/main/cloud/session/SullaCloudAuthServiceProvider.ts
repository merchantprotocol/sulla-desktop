// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import { BrowserWindow, clipboard, dialog } from 'electron';

import { IntegrationValueModel } from '@pkg/agent/database/models/IntegrationValueModel';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { applyFirstRunChoicesWhenReady } from '@pkg/main/firstRun/applyFirstRunChoices';
import { getFirstRunState, updateFirstRunState } from '@pkg/main/firstRun/firstRunState';
import { FirstRunVaultCreation } from '@pkg/main/firstRun/FirstRunVaultCreation';
import { firstRunTrace, initFirstRunTraceEvents } from '@pkg/utils/firstRunTraceSink';
import { clearPendingCredential, getPendingCredential, queuePendingCredential, startPendingCredentialFlush } from '@pkg/main/firstRun/pendingCredentials';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';
import { configuredVaultBrokerProvider, usesContainerVaultAuthority, VaultBrokerError } from '@pkg/vault-broker';

import { getDesktopRelayClient } from '../../desktopRelay';
import { DevicesCloudApi } from '../../devicesCloudApi';
import { readRecoveryKeyFromMacKeychain, recoveryKeyStorageStatus, saveRecoveryKeyToMacKeychain } from '../../recoveryKeychain';
import { runOAuthFlow } from '../../sullaOAuthService';
import { CloudAccountWrapService } from '../account/CloudAccountWrapService';
import { CloudPasswordSignIn } from '../account/CloudPasswordSignIn';
import { CloudRecoveryKeyActions } from '../account/CloudRecoveryKeyActions';
import { CloudSignInCompletion } from '../account/CloudSignInCompletion';
import { CloudSignInService } from '../account/CloudSignInService';
import { ElectronCloudAccountTransport } from '../account/ElectronCloudAccountTransport';
import { CloudAccountCredentialService } from '../CloudAccountCredentialService';
import { SessionBindSigner } from '../device/SessionBindSigner';
import { CloudAuthIpcRegistrar } from './CloudAuthIpcRegistrar';
import { CloudAuthStatusService } from './CloudAuthStatusService';
import { CloudFirstRunVaultCreationHook } from './CloudFirstRunVaultCreationHook';
import { cloudRecoveryKeyProvider } from './CloudRecoveryKeyServiceProvider';
import type { CloudRecoveryKeyNoticeStore } from './CloudRecoveryKeyNoticeStore';
import { cloudSessionKeyProvider } from './CloudSessionKeyServiceProvider';
import type { CloudSessionKeyStore } from './CloudSessionKeyStore';
import { CloudSessionRepository, type CloudSession } from './CloudSessionRepository';
import { cloudSessionStartupRestoreProvider } from './CloudSessionStartupRestoreCoordinator';
import { CloudSignOutService } from './CloudSignOutService';
import { CloudStartupSessionHandoff } from './CloudStartupSessionHandoff';
import { LegacyCloudSessionRefresher, type RefreshReporter } from './DesktopCloudSessionRefreshers';
import { DesktopCloudSignOut } from './DesktopCloudSignOut';
import { LegacyCloudSessionAdopter } from './LegacyCloudSessionAdopter';

type CloudAuthLogger = typeof Logging.background;

/**
 * Refresh is attempted from nearly every authenticated code path, so an
 * unreachable cloud produced thousands of identical warn lines per day
 * (observed: 4,084 in one background.log). Log the first failure, then
 * every 40th, and announce recovery so outage windows stay visible.
 */
export class CloudRefreshFailureLog implements RefreshReporter {
  private failures = 0;

  constructor(private readonly logger: { log(message: string): void; warn(message: string): void }) {}

  failed(message: string): void {
    this.failures++;
    if (this.failures === 1 || this.failures % 40 === 0) {
      this.logger.warn(`${ message }${ this.failures > 1 ? ` (${ this.failures } consecutive failures, logging every 40th)` : '' }`);
    }
  }

  refreshed(): void {
    if (this.failures > 1) {
      this.logger.log(`[sullaCloudAuth] Refresh recovered after ${ this.failures } consecutive failures`);
    }
    this.failures = 0;
  }
}

/**
 * Sulla Cloud authentication for the main process: builds the session,
 * sign-in, status, account-wrap and sign-out services once and binds the
 * `sulla-cloud:*` IPC channels. Constructing it does no I/O; `init()` does.
 */
export class SullaCloudAuthServiceProvider {
  /** Every Sulla Cloud /auth/ call (sign-in, refresh, logout, password reset) goes through this one transport. */
  readonly transport: ElectronCloudAccountTransport;
  readonly sessions: CloudSessionRepository;
  readonly startup: CloudStartupSessionHandoff;
  readonly status: CloudAuthStatusService;
  readonly accountWrap: CloudAccountWrapService;
  /** Legacy / first-run Cloud session refresh on the shared domain ClientSessionService. */
  readonly refresher: LegacyCloudSessionRefresher<CloudSession>;
  readonly completion: CloudSignInCompletion;
  readonly signIn: CloudSignInService;
  readonly signOut: CloudSignOutService;
  readonly recoveryKeys: CloudRecoveryKeyActions;
  private readonly vaultCreation: CloudFirstRunVaultCreationHook;
  private readonly ipc: CloudAuthIpcRegistrar;

  constructor(
    keys: CloudSessionKeyStore = cloudSessionKeyProvider.keys,
    notices: CloudRecoveryKeyNoticeStore = cloudRecoveryKeyProvider.notices,
    private readonly logger: CloudAuthLogger = Logging.background,
  ) {
    const usesContainerVault = () => usesContainerVaultAuthority();
    const approvalClient = () => configuredVaultBrokerProvider.getConfiguredApprovalClient();
    const containerStatus = async() => {
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      const status = await getDesktopVaultClient().status();
      return { unlocked: status.unlocked, setupRequired: status.setup?.required };
    };
    const publishVaultUnlocked = async() => {
      const { onVaultUnlocked } = await import('@pkg/sulla');
      await onVaultUnlocked();
    };
    const enrollment = async() => {
      const { DesktopVaultEnrollment } = await import('../enrollment/DesktopVaultEnrollmentModule');
      return DesktopVaultEnrollment.coordinator;
    };
    const pairRelay = (userId: string) => getDesktopRelayClient().setPairedUserId(userId);
    const startCloudServices = async() => {
      const { startCloudServices: start } = await import('../cloudLifecycle');
      await start();
    };

    // The signed-in calls (set/change password, recovery availability) use the server-mode session's access token.
    // Sign-ins and refreshes carry this device's session-bind proof so Cloud can bind the session to it.
    this.transport = new ElectronCloudAccountTransport({
      accessToken: () => this.currentAccessToken(),
      sessionBind: SessionBindSigner.forDesktop(message => logger.warn(message)),
    });
    const passwords = new CloudPasswordSignIn(this.transport, () => CloudAccountCredentialService.forDesktop(), firstRunTrace);

    this.sessions = new CloudSessionRepository({
      usesContainerVault,
      approvalClient,
      credentialBroker:               () => configuredVaultBrokerProvider.requireConfiguredCredentialBroker(),
      integrations:                   () => getIntegrationService(),
      pendingCredential:              integrationId => getPendingCredential(integrationId),
      queuePendingCredential:         entry => queuePendingCredential(entry),
      clearPendingCredential:         integrationId => clearPendingCredential(integrationId),
      deleteLegacyIntegrationSession: () => IntegrationValueModel.deleteLegacySullaCloudSession(),
      deleteSetting:                  key => SullaSettingsModel.delete(key),
      vaultLockedError:               () => new VaultBrokerError('vault_locked', 'Waiting for the vault to be unlocked.', 423),
    });
    this.startup = new CloudStartupSessionHandoff(this.sessions, new LegacyCloudSessionAdopter(this.transport), {
      usesContainerVault,
      approvalClient,
      credentialBroker:               () => configuredVaultBrokerProvider.requireConfiguredCredentialBroker(),
      findLegacyIntegrationSession:   () => IntegrationValueModel.findLegacySullaCloudSession(),
      deleteLegacyIntegrationSession: () => IntegrationValueModel.deleteLegacySullaCloudSession(),
      isInvalidOperation:             error => error instanceof VaultBrokerError && error.code === 'invalid_operation',
      logger,
    });
    this.status = new CloudAuthStatusService(
      this.sessions,
      this.startup,
      error => error instanceof VaultBrokerError ? { code: error.code, status: error.status } : undefined,
    );
    this.accountWrap = new CloudAccountWrapService(keys, notices, {
      usesContainerVault,
      approvalClient,
      publishVaultUnlocked,
      recoveryKeyStorageStatus: () => recoveryKeyStorageStatus(),
      saveRecoveryKey:          (userId, recoveryKey) => saveRecoveryKeyToMacKeychain(userId, recoveryKey),
      announceRecoveryKey:      (notice) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('sulla-cloud:recovery-key-created', notice);
        }
      },
      hasExpiredSignInHold:   () => getFirstRunState().credentialsSaved === false,
      clearExpiredSignInHold: () => { updateFirstRunState({ credentialsSaved: undefined }) },
      trace:                  (message, details) => firstRunTrace('vault', message, details),
      logger,
    });
    this.refresher = new LegacyCloudSessionRefresher<CloudSession>(
      {
        load:  () => this.sessions.load(),
        save:  session => this.sessions.saveRefreshed(session),
        /** Server-mode sign-out: drop the first-run copy and the stored account. Throws when the account could not be removed. */
        clear: async() => {
          await this.sessions.clearPending();
          await this.sessions.clear();
        },
      },
      this.transport,
      new CloudRefreshFailureLog(logger),
    );
    this.completion = new CloudSignInCompletion(this.sessions, this.refresher, this.status, this.accountWrap, {
      usesContainerVault,
      enrollmentGate:   async() => (await enrollment()).gate(),
      showApprovalWait: async(message) => {
        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const options = { type: 'info' as const, buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true, title: 'Sulla Desktop', message };
        if (window) await dialog.showMessageBox(window, options);
        else await dialog.showMessageBox(options);
      },
      pairRelay,
      startCloudServices,
      onboardingComplete: () => !!getFirstRunState().onboardingComplete,
      vaultReady:         () => {
        const lifecycle = getServiceLifecycleManager();
        return lifecycle.isVaultUnlocked() &&
          lifecycle.serviceStatuses().some(({ name, status }) => name === 'vault' && status === 'ready');
      },
      containerVaultStatus: containerStatus,
      trace:                (area, message, details) => firstRunTrace(area, message, details),
      logger,
      sleep:                ms => new Promise(resolve => setTimeout(resolve, ms)),
      now:                  () => Date.now(),
    });
    this.signIn = new CloudSignInService(this.transport, passwords, this.completion, this.status, this.accountWrap, {
      usesContainerVault,
      credentials:  () => CloudAccountCredentialService.forDesktop(),
      appleOAuth:   () => runOAuthFlow('apple', 'sulla-cloud'),
      integrations: () => getIntegrationService(),
      timezone:     () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      trace:        (message, details) => firstRunTrace('account', message, details),
      logger,
    });
    /** `sulla-cloud:logout`: container vault unchanged; server mode clears locally, then revokes on Sulla Cloud. */
    const desktopSignOut = new DesktopCloudSignOut({
      usesContainerVault:     usesContainerVault,
      clearPendingMasterKey:  () => this.accountWrap.clear(),
      clearPendingCredential: () => this.sessions.clearPending(),
      clearContainerSession:  () => this.sessions.clear(),
    }, this.refresher);
    this.signOut = new CloudSignOutService(desktopSignOut, this.status, {
      usesContainerVault,
      integrations:      () => getIntegrationService(),
      pairRelay,
      stopCloudServices: async() => {
        const { stopCloudServices } = await import('../cloudLifecycle');
        await stopCloudServices();
      },
      removeApprovedClients: async() => {
        const { ApprovedClients } = await import('../approvedClients');
        ApprovedClients.removeAll();
      },
      stopHeartbeat: () => DevicesCloudApi.stopHeartbeat(),
      logger,
    });
    this.recoveryKeys = new CloudRecoveryKeyActions({
      status:                   () => this.status.build(),
      approvalClient,
      recoveryKeyStorageStatus: () => recoveryKeyStorageStatus(),
      readRecoveryKey:          () => readRecoveryKeyFromMacKeychain(),
      saveRecoveryKey:          (userId, recoveryKey) => saveRecoveryKeyToMacKeychain(userId, recoveryKey),
      copyToClipboard:          text => clipboard.writeText(text),
      focusedWindow:            () => BrowserWindow.getFocusedWindow(),
      openHiddenPage:           (owner) => {
        const page = new BrowserWindow({ show: false, parent: (owner as BrowserWindow | null) ?? undefined, webPreferences: { sandbox: true } });
        return {
          loadURL:    url => page.loadURL(url),
          print:      () => new Promise<void>((resolve, reject) => page.webContents.print({}, (ok, reason) => ok ? resolve() : reject(new Error(reason)))),
          printToPDF: () => page.webContents.printToPDF({}),
          destroy:    () => page.destroy(),
        };
      },
      chooseSavePath: async(owner, options) => {
        const window = owner as BrowserWindow | null;
        const output = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
        return output.canceled || !output.filePath ? undefined : output.filePath;
      },
      writePrivateFile: (filePath, data) => fs.promises.writeFile(filePath, data, { mode: 0o600 }),
      now:              () => new Date(),
    });
    this.vaultCreation = new CloudFirstRunVaultCreationHook(this.accountWrap, {
      lifecycle: () => getServiceLifecycleManager(),
      // First run never calls, waits on, or creates the vault while its sign-in
      // is held only in memory for a returning Cloud session.
      holdUntilWizardCloses: () => getFirstRunState().credentialsSaved === false,
      containerStatus,
      enrollment,
      publishUnlocked:       publishVaultUnlocked,
      trace:                 (message, detail) => firstRunTrace('vault', message, detail),
      logger,
      createRunner:          dependencies => new FirstRunVaultCreation(dependencies),
    });
    this.ipc = new CloudAuthIpcRegistrar(this.status, this.completion, this.signIn, this.signOut, this.recoveryKeys, notices);
  }

  /**
   * Returns the currently-signed-in access token, or empty string if not
   * signed in. Automatically refreshes the token when it is within 60s of
   * expiry (or already expired), so callers never need to handle 401s.
   */
  async currentAccessToken(): Promise<string> {
    if (usesContainerVaultAuthority()) return '';
    return this.refresher.currentAccessToken();
  }

  /** Wake (or restart) the startup restore: something may have made a Cloud session loadable. */
  signalStartupRestore(): void {
    cloudSessionStartupRestoreProvider.signal();
  }

  /** `initSullaCloudAuthEvents`: first-run hooks, the vault-creation hook, the IPC channels, then startup restore. */
  init(): void {
    initFirstRunTraceEvents();
    applyFirstRunChoicesWhenReady();
    startPendingCredentialFlush();
    this.vaultCreation.install();
    this.ipc.register(getIpcMainProxy(this.logger));

    // Restore the signed-in Cloud session when vault and storage are ready.
    void cloudSessionStartupRestoreProvider.start({
      lifecycle:          getServiceLifecycleManager(),
      restoreIdentity:    () => this.startup.restoreIdentity(),
      pairRelay:          userId => getDesktopRelayClient().setPairedUserId(userId),
      startCloudServices: async() => {
        const { startCloudServices } = await import('../cloudLifecycle');
        await startCloudServices();
      },
      trace:        (message, metadata) => firstRunTrace('account', message, metadata),
      logger:       this.logger,
      setLastError: message => this.startup.setLastError(message),
    });
  }
}

export const sullaCloudAuthProvider = new SullaCloudAuthServiceProvider();
