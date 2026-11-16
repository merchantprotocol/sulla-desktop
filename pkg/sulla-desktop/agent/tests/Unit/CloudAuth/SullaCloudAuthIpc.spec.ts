// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Characterization of the `sulla-cloud:*` IPC surface that initSullaCloudAuthEvents registers. Written against the
 * procedural sullaCloudAuth.ts before it was split into classes (E4 S2) and kept passing after, so the split cannot
 * change channel names, payloads, status shapes, the account-wrap / recovery-key path or the sign-in persistence.
 * Every boundary (Electron, the vault broker, the integration store, Cloud HTTP, the relay) is a fake; the auth code
 * itself runs for real.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  type Handler = (...args: any[]) => Promise<any>;
  const handlers = new Map<string, Handler>();
  const sentToWindows: Array<{ channel: string; payload: unknown }> = [];
  const lifecycleListeners = new Map<string, Array<(...args: any[]) => void>>();
  const integrationValues = new Map<string, string>();
  const state = {
    containerVault: true,
    onboardingComplete: true,
    vaultUnlocked: true,
    credentialsSaved: undefined as boolean | undefined,
    brokerUnlocked: true,
    brokerAccounts: [] as Array<{ accountId: string; active?: boolean; connected: boolean }>,
    brokerActiveAccountId: undefined as string | undefined,
    pending: undefined as undefined | { values: Record<string, string> },
    enrollmentGate: 'trusted' as string,
    rewrapRecoveryKey: undefined as string | undefined,
  };
  const vaultCreationDeps: { current?: Record<string, any> } = {};
  const restoreDeps: { current?: Record<string, any> } = {};

  class VaultBrokerError extends Error {
    constructor(readonly code: string, message: string, readonly status?: number) { super(message); }
  }

  const approvalClient = {
    adoptSullaCloudSession: vi.fn(async(_: unknown) => {}),
    clearSullaCloudSession: vi.fn(async() => {}),
    rewrapForAccountPassword: vi.fn(async(_: unknown) => ({ recoveryKey: state.rewrapRecoveryKey })),
    rotateRecoveryKey: vi.fn(async() => ({ recoveryKey: 'R'.repeat(43) })),
  };
  const relay = { setPairedUserId: vi.fn(async(_: string) => {}) };
  const passwordSignIn = { login: vi.fn(), register: vi.fn(), continueFirstRun: vi.fn() };
  const transport = {
    phoneOtpSend: vi.fn(async(_: unknown) => ({})),
    phoneOtpVerify: vi.fn(),
    startEmailCode: vi.fn(),
    verifyEmailCode: vi.fn(),
    startPasswordReset: vi.fn(),
    completePasswordReset: vi.fn(),
    passwordResetAvailable: vi.fn(async() => true),
    apple: vi.fn(),
  };

  return {
    handlers, sentToWindows, lifecycleListeners, integrationValues, state, vaultCreationDeps, restoreDeps, VaultBrokerError,
    approvalClient, relay, passwordSignIn, transport,
    trace: vi.fn(),
    queuePendingCredential: vi.fn(async(entry: { values: Record<string, string> }) => { state.pending = { values: entry.values }; }),
    clearPendingCredential: vi.fn(async() => { state.pending = undefined; }),
    updateFirstRunState: vi.fn((patch: Record<string, unknown>) => {
      if ('credentialsSaved' in patch) state.credentialsSaved = patch.credentialsSaved as boolean | undefined;
    }),
    startCloudServices: vi.fn(async() => {}),
    stopCloudServices: vi.fn(async() => {}),
    removeApprovedClients: vi.fn(),
    stopHeartbeat: vi.fn(),
    onVaultUnlocked: vi.fn(async() => {}),
    saveRecoveryKey: vi.fn(async() => ({ location: 'keychain', label: 'Saved in Keychain' })),
    clipboardWrite: vi.fn(),
    enrollmentComplete: vi.fn(async() => {}),
    restoreStart: vi.fn(async(deps: Record<string, any>) => { restoreDeps.current = deps; }),
    restoreSignal: vi.fn(),
    settingsDelete: vi.fn(async() => {}),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => env.sentToWindows.push({ channel, payload }) } }],
    getFocusedWindow: () => null,
  }),
  clipboard: { writeText: env.clipboardWrite },
  dialog: { showMessageBox: vi.fn(async() => ({ response: 0 })), showSaveDialog: vi.fn(async() => ({ canceled: true })) },
}));
vi.mock('@pkg/utils/logging', () => {
  const channel = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { default: new Proxy({}, { get: () => channel }) };
});
vi.mock('@pkg/main/ipcMain', () => ({
  getIpcMainProxy: () => ({ handle: (channel: string, handler: (...args: any[]) => Promise<any>) => env.handlers.set(channel, handler) }),
}));
vi.mock('@pkg/vault-broker', () => ({
  VaultBrokerError:                 env.VaultBrokerError,
  usesContainerVaultAuthority:      () => env.state.containerVault,
  getConfiguredApprovalClient:      () => env.approvalClient,
  requireConfiguredCredentialBroker: () => ({
    status:              async() => ({ unlocked: env.state.brokerUnlocked }),
    integrationMetadata: async() => ({ activeAccountId: env.state.brokerActiveAccountId, accounts: env.state.brokerAccounts }),
  }),
}));
vi.mock('@pkg/agent/services/IntegrationService', () => ({
  getIntegrationService: () => ({
    setMultipleValues: async(rows: Array<{ account_id: string; property: string; value: string }>) => {
      for (const row of rows) env.integrationValues.set(`${ row.account_id }:${ row.property }`, row.value);
    },
    setConnectionStatus: async() => {},
    setActiveAccount:    async() => {},
    getAccounts:         async(integrationId: string) => {
      if (integrationId !== 'sulla-cloud') return [];
      const ids = new Set([...env.integrationValues.keys()].map(key => key.split(':')[0]));
      return [...ids].map(accountId => ({ account_id: accountId, active: true }));
    },
    getIntegrationValue: async(_integrationId: string, property: string, accountId: string) => {
      const value = env.integrationValues.get(`${ accountId }:${ property }`);
      return value === undefined ? null : { value };
    },
    deleteAccount: async(_integrationId: string, accountId: string) => {
      for (const key of [...env.integrationValues.keys()]) if (key.startsWith(`${ accountId }:`)) env.integrationValues.delete(key);
    },
  }),
}));
vi.mock('@pkg/agent/services/ServiceLifecycleManager', () => ({
  getServiceLifecycleManager: () => ({
    on:  (event: string, listener: (...args: any[]) => void) => env.lifecycleListeners.set(event, [...(env.lifecycleListeners.get(event) ?? []), listener]),
    off: vi.fn(),
    isVaultUnlocked:  () => env.state.vaultUnlocked,
    serviceStatuses:  () => [{ name: 'vault', status: env.state.vaultUnlocked ? 'ready' : 'starting' }],
  }),
}));
vi.mock('@pkg/agent/services/DesktopVaultClient', () => ({
  getDesktopVaultClient: () => ({ status: async() => ({ unlocked: env.state.vaultUnlocked, setup: { required: false } }) }),
}));
vi.mock('@pkg/agent/database/models/IntegrationValueModel', () => ({
  IntegrationValueModel: { deleteLegacySullaCloudSession: vi.fn(async() => {}), findLegacySullaCloudSession: vi.fn(async() => null) },
}));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { delete: env.settingsDelete } }));
vi.mock('@pkg/main/firstRun/applyFirstRunChoices', () => ({ applyFirstRunChoicesWhenReady: vi.fn() }));
vi.mock('@pkg/main/firstRun/firstRunState', () => ({
  getFirstRunState:    () => ({ onboardingComplete: env.state.onboardingComplete, credentialsSaved: env.state.credentialsSaved }),
  updateFirstRunState: env.updateFirstRunState,
}));
vi.mock('@pkg/main/firstRun/FirstRunVaultCreation', () => ({
  FirstRunVaultCreation: class {
    constructor(deps: Record<string, any>) { env.vaultCreationDeps.current = deps; }
    start(): void {}
    poke(): Promise<void> { return Promise.resolve(); }
    onLifecycleLocked(): Promise<void> { return Promise.resolve(); }
  },
}));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: env.trace, initFirstRunTraceEvents: vi.fn() }));
vi.mock('@pkg/main/firstRun/pendingCredentials', () => ({
  getPendingCredential:       () => env.state.pending,
  queuePendingCredential:     env.queuePendingCredential,
  clearPendingCredential:     env.clearPendingCredential,
  startPendingCredentialFlush: vi.fn(),
}));
vi.mock('@pkg/main/cloud/account/ElectronCloudAccountTransport', async(importActual) => {
  const actual = await importActual<typeof import('@pkg/main/cloud/account/ElectronCloudAccountTransport')>();
  return {
    ...actual,
    ElectronCloudAccountTransport: Object.assign(function FakeTransport() { return env.transport; }, { signIn: actual.ElectronCloudAccountTransport.signIn }),
  };
});
vi.mock('@pkg/main/cloud/account/CloudPasswordSignIn', () => ({
  CloudPasswordSignIn: function FakePasswordSignIn() { return env.passwordSignIn; },
}));
vi.mock('@pkg/main/cloud/CloudAccountCredentialService', () => ({
  CloudAccountCredentialService: { forDesktop: async() => ({ derive: async() => ({ authHash: 'hash', kdf: { algorithm: 'test' }, masterKey: new Uint8Array([9, 9]) }) }) },
}));
vi.mock('@pkg/main/cloud/device/SessionBindSigner', () => ({ SessionBindSigner: { forDesktop: () => ({}) } }));
vi.mock('@pkg/main/cloud/session/CloudSessionStartupRestoreCoordinator', () => ({
  cloudSessionStartupRestoreProvider: { start: env.restoreStart, signal: env.restoreSignal },
}));
vi.mock('@pkg/main/desktopRelay', () => ({ getDesktopRelayClient: () => env.relay }));
vi.mock('@pkg/main/devicesCloudApi', () => ({ DevicesCloudApi: { stopHeartbeat: env.stopHeartbeat } }));
vi.mock('@pkg/main/recoveryKeychain', () => ({
  readRecoveryKeyFromMacKeychain: async() => 'saved',
  recoveryKeyStorageStatus:       () => ({ location: 'unavailable', label: 'Not saved' }),
  saveRecoveryKeyToMacKeychain:   env.saveRecoveryKey,
}));
vi.mock('@pkg/main/sullaOAuthService', () => ({ runOAuthFlow: vi.fn() }));
vi.mock('@pkg/main/cloud/enrollment/DesktopVaultEnrollmentModule', () => ({
  DesktopVaultEnrollment: { coordinator: { gate: async() => env.state.enrollmentGate, complete: env.enrollmentComplete } },
}));
vi.mock('@pkg/main/cloud/cloudLifecycle', () => ({ startCloudServices: env.startCloudServices, stopCloudServices: env.stopCloudServices }));
vi.mock('@pkg/main/cloud/approvedClients', () => ({ ApprovedClients: { removeAll: env.removeApprovedClients } }));
vi.mock('@pkg/sulla', () => ({ onVaultUnlocked: env.onVaultUnlocked }));

const auth = await import('@pkg/main/sullaCloudAuth');

const USER = 'user-0001';
const KDF = { algorithm: 'synthetic-test-fixture' };
const contractor = { id: USER, phone: '+15550000001', businessName: 'Example Co', name: 'Example Owner', email: 'owner@example.test' };

function signInData() {
  return { contractor, accessToken: 'access-fixture', refreshToken: 'refresh-fixture', userId: USER };
}

function call(channel: string, ...args: unknown[]): Promise<any> {
  const handler = env.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${ channel }`);
  return handler({}, ...args);
}

function signedInVault(): void {
  env.state.brokerAccounts = [{ accountId: USER, active: true, connected: true }];
  env.state.brokerActiveAccountId = USER;
}

beforeAll(() => {
  auth.initSullaCloudAuthEvents();
});

beforeEach(() => {
  Object.assign(env.state, {
    containerVault: true, onboardingComplete: true, vaultUnlocked: true, credentialsSaved: undefined, brokerUnlocked: true,
    brokerAccounts: [], brokerActiveAccountId: undefined, pending: undefined, enrollmentGate: 'trusted', rewrapRecoveryKey: undefined,
  });
  env.integrationValues.clear();
  env.sentToWindows.length = 0;
  env.approvalClient.adoptSullaCloudSession.mockImplementation(async() => {});
  env.approvalClient.clearSullaCloudSession.mockImplementation(async() => {});
});

afterEach(() => {
  auth.clearPendingCloudMasterKey();
  vi.clearAllMocks();
});

describe('sullaCloudAuth IPC surface', () => {
  it('risk: renderer contract. registers every sulla-cloud channel the renderer and first-run wizard call', () => {
    expect([...env.handlers.keys()].sort()).toEqual([
      'sulla-cloud:account-exists', 'sulla-cloud:apple-sign-in', 'sulla-cloud:apple-sign-in-browser',
      'sulla-cloud:email-code-availability', 'sulla-cloud:email-code-start', 'sulla-cloud:email-code-verify',
      'sulla-cloud:email-continue', 'sulla-cloud:email-login', 'sulla-cloud:email-register', 'sulla-cloud:first-run-session',
      'sulla-cloud:first-run-sign-out', 'sulla-cloud:get-status', 'sulla-cloud:logout', 'sulla-cloud:password-reset-availability',
      'sulla-cloud:password-reset-complete', 'sulla-cloud:password-reset-start', 'sulla-cloud:recovery-key-copy',
      'sulla-cloud:recovery-key-pending', 'sulla-cloud:recovery-key-print',
      'sulla-cloud:recovery-key-rotate', 'sulla-cloud:recovery-key-save', 'sulla-cloud:recovery-key-shown',
      'sulla-cloud:recovery-key-status', 'sulla-cloud:send-otp', 'sulla-cloud:verify-otp',
    ].sort());
  });

  it('risk: startup restore. starts the restore coordinator with the vault lifecycle and surfaces its last error in the status', async() => {
    const deps = env.restoreDeps.current;
    expect(deps).toBeDefined();
    expect(typeof deps?.restoreIdentity).toBe('function');
    expect(env.lifecycleListeners.get('vault:state')?.length).toBeGreaterThanOrEqual(1);
    expect(env.lifecycleListeners.get('service:ready')?.length).toBeGreaterThanOrEqual(1);

    deps?.setLastError('Sulla Cloud restore stopped: boom');
    expect((await call('sulla-cloud:get-status')).lastError).toBe('Sulla Cloud restore stopped: boom');
    deps?.setLastError(undefined);
    expect((await call('sulla-cloud:get-status')).lastError).toBeUndefined();

    auth.signalSullaCloudStartupRestore();
    expect(env.restoreSignal).toHaveBeenCalledTimes(1);
  });
});

describe('status building', () => {
  it('risk: wrong account shown. reports the vault account identity when signed in under the container vault', async() => {
    signedInVault();
    expect(await call('sulla-cloud:get-status')).toEqual({
      signedIn: true, userId: USER, activeContractorId: USER, phone: '', name: '', contractorCount: 0, lastError: undefined,
    });
    expect(await auth.isCloudSignedIn()).toBe(true);
    expect(await auth.getCurrentUserId()).toBe(USER);
    expect(await auth.getActiveContractorId()).toBe(USER);
    expect(await auth.getCurrentAccessToken()).toBe('');
  });

  it('risk: signed-out lies. a locked vault reports signed out with vaultLocked, not as a signed-in session', async() => {
    signedInVault();
    env.state.brokerUnlocked = false;
    expect(await call('sulla-cloud:get-status')).toEqual({
      signedIn: false, userId: '', activeContractorId: '', phone: '', name: '', contractorCount: 0,
      lastError: 'Waiting for the vault to be unlocked.', vaultLocked: true,
    });
  });

  it('risk: signed-out lies. no connected account is signed out with no error', async() => {
    expect(await call('sulla-cloud:get-status')).toEqual({
      signedIn: false, userId: '', activeContractorId: '', phone: '', name: '', contractorCount: 0, lastError: undefined,
    });
    expect(await auth.getCurrentUserId()).toBe('');
  });

  it('risk: wrong account shown. server mode reads the contractor name and phone from the stored session', async() => {
    env.state.containerVault = false;
    env.integrationValues.set(`${ USER }:access_token`, 'access-fixture');
    env.integrationValues.set(`${ USER }:user_id`, USER);
    env.integrationValues.set(`${ USER }:active_contractor_id`, USER);
    env.integrationValues.set(`${ USER }:contractors_json`, JSON.stringify([contractor]));
    expect(await call('sulla-cloud:get-status')).toEqual({
      signedIn: true, userId: USER, activeContractorId: USER, phone: contractor.phone, name: contractor.name, contractorCount: 1, lastError: undefined,
    });
  });
});

describe('sign-in flows', () => {
  it('risk: bad input reaches Cloud. send-otp rejects a non-E.164 phone without calling Cloud', async() => {
    const result = await call('sulla-cloud:send-otp', '555-1234');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid phone format. Use E.164, e.g. +15551234567.');
    expect(result.status.signedIn).toBe(false);
    expect(env.transport.phoneOtpSend).not.toHaveBeenCalled();
  });

  it('risk: lockout. a wrong password returns the sign-in error in the result and the status', async() => {
    env.passwordSignIn.login.mockResolvedValue({ ok: false, error: 'That password is not correct.' });
    const result = await call('sulla-cloud:email-login', ' Owner@Example.test ', 'pw');
    expect(env.passwordSignIn.login).toHaveBeenCalledWith('owner@example.test', 'pw');
    expect(result).toEqual({ ok: false, error: 'That password is not correct.', status: expect.objectContaining({ signedIn: false, lastError: 'That password is not correct.' }) });
  });

  it('risk: session lost. email-login with a ready vault adopts the session into the vault, pairs the relay and starts Cloud services', async() => {
    const key = new Uint8Array([1, 2, 3, 4]);
    env.passwordSignIn.login.mockResolvedValue({ ok: true, data: signInData(), masterKey: key, kdf: KDF });
    env.approvalClient.adoptSullaCloudSession.mockImplementation(async() => { signedInVault(); });

    const result = await call('sulla-cloud:email-login', 'owner@example.test', 'pw');

    expect(env.approvalClient.adoptSullaCloudSession).toHaveBeenCalledWith({
      userId: USER, activeContractorId: USER, contractors: [contractor], accessToken: 'access-fixture', refreshToken: 'refresh-fixture',
    });
    expect(env.relay.setPairedUserId).toHaveBeenCalledWith(USER);
    expect(env.startCloudServices).toHaveBeenCalledTimes(1);
    expect(env.queuePendingCredential).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, status: expect.objectContaining({ signedIn: true, userId: USER }), needsVaultMigration: false });
  });

  it('risk: vault created early. first-run email-login keeps the session in memory and holds the key for vault creation', async() => {
    env.state.onboardingComplete = false;
    const key = new Uint8Array([5, 6, 7]);
    env.passwordSignIn.login.mockResolvedValue({ ok: true, data: signInData(), masterKey: key, kdf: KDF });

    const result = await call('sulla-cloud:email-login', 'owner@example.test', 'pw');

    expect(env.queuePendingCredential).toHaveBeenCalledWith({
      integrationId: 'sulla-cloud', accountId: USER, activate: true,
      values: {
        access_token: 'access-fixture', refresh_token: 'refresh-fixture', user_id: USER, active_contractor_id: USER,
        contractors_json: JSON.stringify([contractor]),
      },
    });
    expect(env.approvalClient.adoptSullaCloudSession).not.toHaveBeenCalled();
    expect(env.approvalClient.rewrapForAccountPassword).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(await call('sulla-cloud:first-run-session')).toEqual({
      sessionInMemory: true, masterKeyRetained: true, email: 'owner@example.test', oldVaultLocked: false,
    });
    // The vault-creation gate sees the held key (regression: it used to read a deleted module variable).
    expect(env.vaultCreationDeps.current?.hasPendingKey()).toBe(true);
    await env.vaultCreationDeps.current?.enrollmentComplete();
    expect(env.enrollmentComplete).toHaveBeenCalledWith(key, USER);
  });

  it('risk: enrollment bypass. Cloud services stay stopped while another device must approve this computer', async() => {
    env.state.enrollmentGate = 'waiting_for_approver';
    env.passwordSignIn.login.mockResolvedValue({ ok: true, data: signInData(), masterKey: new Uint8Array([1]), kdf: KDF });
    env.approvalClient.adoptSullaCloudSession.mockImplementation(async() => { signedInVault(); });

    const result = await call('sulla-cloud:email-login', 'owner@example.test', 'pw');

    expect(result.ok).toBe(true);
    expect(env.startCloudServices).not.toHaveBeenCalled();
    expect(env.relay.setPairedUserId).toHaveBeenCalledWith(USER);
  });

  it('risk: stale hold. a fresh sign-in clears the expired first-run credentialsSaved hold', async() => {
    env.state.onboardingComplete = false;
    env.state.credentialsSaved = false;
    env.passwordSignIn.login.mockResolvedValue({ ok: true, data: signInData(), masterKey: new Uint8Array([1]), kdf: KDF });
    await call('sulla-cloud:email-login', 'owner@example.test', 'pw');
    expect(env.updateFirstRunState).toHaveBeenCalledWith({ credentialsSaved: undefined });
  });

  it('risk: secrets kept. first-run sign-out drops the in-memory session and zeros the held key', async() => {
    env.state.onboardingComplete = false;
    const key = new Uint8Array([5, 6, 7]);
    env.passwordSignIn.login.mockResolvedValue({ ok: true, data: signInData(), masterKey: key, kdf: KDF });
    await call('sulla-cloud:email-login', 'owner@example.test', 'pw');

    expect(await call('sulla-cloud:first-run-sign-out')).toEqual({ ok: true });
    expect(env.clearPendingCredential).toHaveBeenCalledWith('sulla-cloud');
    expect([...key]).toEqual([0, 0, 0]);
    expect(auth.takePendingCloudMasterKey()).toBeUndefined();
  });

  it('risk: throttling hidden. password-reset-start maps 429 to the wait message', async() => {
    const { CloudAccountHttpError } = await import('@pkg/main/cloud/account/ElectronCloudAccountTransport');
    const error = Object.assign(Object.create(CloudAccountHttpError.prototype), { status: 429 });
    env.transport.startPasswordReset.mockRejectedValue(error);
    expect(await call('sulla-cloud:password-reset-start', 'owner@example.test')).toEqual({ ok: false, error: 'Too many tries. Wait a few minutes and try again.' });
    expect(await call('sulla-cloud:password-reset-start', 'not-an-email')).toEqual({ ok: false, error: 'Enter a valid email address.' });
  });
});

describe('account wrap and recovery key', () => {
  it('risk: vault key / recovery key lost. a signed-in password login re-wraps the vault, publishes unlock, saves and announces the recovery key', async() => {
    env.state.rewrapRecoveryKey = 'K'.repeat(43);
    const key = new Uint8Array([11, 12, 13]);
    env.passwordSignIn.login.mockResolvedValue({ ok: true, data: signInData(), masterKey: key, kdf: KDF });
    env.approvalClient.adoptSullaCloudSession.mockImplementation(async() => { signedInVault(); });

    await call('sulla-cloud:email-login', 'owner@example.test', 'pw');

    expect(env.approvalClient.rewrapForAccountPassword).toHaveBeenCalledWith({
      masterKey: Buffer.from([11, 12, 13]).toString('base64url'), cloudUserId: USER, kdf: KDF,
    });
    expect(env.onVaultUnlocked).toHaveBeenCalled();
    expect([...key]).toEqual([0, 0, 0]);
    expect(env.saveRecoveryKey).toHaveBeenCalledWith(USER, 'K'.repeat(43));
    const announced = env.sentToWindows.find(message => message.channel === 'sulla-cloud:recovery-key-created');
    expect(announced?.payload).toEqual(expect.objectContaining({ recoveryKey: 'K'.repeat(43), storage: { location: 'keychain', label: 'Saved in Keychain' } }));
    expect(await call('sulla-cloud:recovery-key-pending')).toEqual(announced?.payload);
    await call('sulla-cloud:recovery-key-shown');
    expect(await call('sulla-cloud:recovery-key-pending')).toBeUndefined();
  });

  it('risk: recovery key lost. rotate requires a signed-in session and saves the new key to the Keychain', async() => {
    await expect(call('sulla-cloud:recovery-key-rotate')).rejects.toThrow('Sign in to Sulla Cloud before making a recovery key.');
    signedInVault();
    const rotated = await call('sulla-cloud:recovery-key-rotate');
    expect(rotated).toEqual(expect.objectContaining({ recoveryKey: 'R'.repeat(43), storage: { location: 'keychain', label: 'Saved in Keychain' } }));
    expect(env.saveRecoveryKey).toHaveBeenCalledWith(USER, 'R'.repeat(43));
  });

  it('risk: clipboard injection. copy accepts only a well-formed recovery key', async() => {
    await expect(call('sulla-cloud:recovery-key-copy', 'short')).rejects.toThrow('Recovery key is invalid.');
    expect(env.clipboardWrite).not.toHaveBeenCalled();
    await call('sulla-cloud:recovery-key-copy', 'A'.repeat(43));
    expect(env.clipboardWrite).toHaveBeenCalledWith('A'.repeat(43));
  });
});

describe('sign-out', () => {
  it('risk: session left alive. logout clears the vault session, unpairs the relay and stops Cloud services', async() => {
    signedInVault();
    env.approvalClient.clearSullaCloudSession.mockImplementation(async() => { env.state.brokerAccounts = []; env.state.brokerActiveAccountId = undefined; });

    const status = await call('sulla-cloud:logout');

    expect(env.approvalClient.clearSullaCloudSession).toHaveBeenCalledTimes(1);
    expect(env.relay.setPairedUserId).toHaveBeenCalledWith('');
    expect(env.stopCloudServices).toHaveBeenCalledTimes(1);
    expect(env.removeApprovedClients).toHaveBeenCalledTimes(1);
    expect(env.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(status.signedIn).toBe(false);
  });

  it('risk: half sign-out. a failed vault clear keeps Desktop paired and reports why', async() => {
    signedInVault();
    env.approvalClient.clearSullaCloudSession.mockRejectedValue(new env.VaultBrokerError('vault_locked', 'locked', 423));

    const status = await call('sulla-cloud:logout');

    expect(status).toEqual(expect.objectContaining({
      signedIn: true, lastError: 'Your signed-in session could not be restored. Sign in to Sulla Cloud again to sign out.',
    }));
    expect(env.relay.setPairedUserId).not.toHaveBeenCalled();
    expect(env.stopCloudServices).not.toHaveBeenCalled();
  });
});
