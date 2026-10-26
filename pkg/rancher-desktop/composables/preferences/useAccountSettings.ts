/**
 * Profile, Sulla Cloud sign-in, connected servers and the master password,
 * for Preferences › Account & Cloud. Moved here from the old My Account tab;
 * it uses the same settings and IPC.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { openMainTab } from '@pkg/composables/preferences/openInMain';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export function useAccountSettings() {
  interface AccountsProfile {
    id:          string;
    displayName: string;
    createdAt:   string;
    updatedAt:   string;
  }
  interface AccountsConnection {
    id:                string;
    issuer:            string;
    resourceAudiences: string[];
    subject:           string | null;
  }
  interface AccountsAuthority {
    authorityId:        string;
    issuer:             string;
    nativeClientId:     string;
    resourceAudiences:  string[];
    scopes:             string[];
    membershipResolver: string;
    membershipAudience: string;
  }
  interface AccountsMembership {
    authorityId:    string;
    issuer:         string;
    organizationId: string;
    roles:          string[];
  }
  interface AccountsMemberships {
    local:              AccountsMembership[];
    remoteDisplayHints: AccountsMembership[];
  }

  // The IPC implementation and shared declarations land in the sibling Desktop
  // integration branch. Keeping the narrow contract here lets this UI branch
  // compile independently without taking ownership of that worker's typings.
  interface AccountsRenderer {
    invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
  }
  const accountsRenderer = ipcRenderer as unknown as AccountsRenderer;

  const loading = ref(true);
  const saving = ref(false);
  const saved = ref(false);

  const userName = ref('');
  const email = ref('');
  const subscribeToUpdates = ref(true);

  // Local Accounts broker and remote authorities
  const accountsLoading = ref(true);
  const accountsPending = ref('');
  const accountsError = ref('');
  const accountsNotice = ref('');
  const accountsProfile = ref<AccountsProfile | null>(null);
  const accountsDisplayName = ref('');
  const accountsConnections = ref<AccountsConnection[]>([]);
  const accountsMemberships = ref<AccountsMemberships>({ local: [], remoteDisplayHints: [] });
  const authorityUrl = ref('');
  const authorityError = ref('');
  const discoveredAuthority = ref<AccountsAuthority | null>(null);
  const selectedAudience = ref<Record<string, string>>({});
  const authorizationNotice = ref('');
  let authorizationRefreshArmed = false;


  // Vault stats
  const vaultStats = ref({ totalAccounts: 0, integrationTypes: 0 });
  const vaultStatsKnown = ref(false);

  // Sulla Cloud
  interface CloudStatus {
    signedIn:           boolean;
    userId:             string;
    activeContractorId: string;
    phone:              string;
    name:               string;
    contractorCount:    number;
    lastError?:         string;
  }
  interface RelayStatus { pairedUserId: string; connected: boolean; lastError?: string }

  const cloudStatus = ref<CloudStatus>({
    signedIn:           false,
    userId:             '',
    activeContractorId: '',
    phone:              '',
    name:               '',
    contractorCount:    0,
  });
  const relayStatus = ref<RelayStatus>({ pairedUserId: '', connected: false });
  const cloudTab = ref<'phone' | 'email' | 'apple'>('email');
  const cloudError = ref('');
  const busy = ref(false);

  const phoneInput = ref('');
  const otpSent = ref(false);
  const otpCode = ref('');

  const emailInput = ref('');
  const emailPassword = ref('');
  const emailName = ref('');
  const emailMode = ref<'code' | 'login' | 'register'>('code');
  const emailCodeSent = ref(false);
  const emailCode = ref('');

  const appleToken = ref(''); // kept for compat with existing paste-token IPC

  async function loadProfile() {
    loading.value = true;
    try {
      userName.value = await SullaSettingsModel.get('primaryUserName') || '';
      email.value = await SullaSettingsModel.get('sullaEmail') || '';
      const sub = await SullaSettingsModel.get('sullaSubscribeToUpdates');
      subscribeToUpdates.value = sub !== null ? sub : true;
    } catch (err) {
      console.error('[Preferences] Profile load failed:', err);
    } finally {
      loading.value = false;
    }
    // The count is only shown when it could actually be read.
    try {
      const enabled = await getIntegrationService().getEnabledIntegrations();
      let total = 0;

      for (const { accounts } of enabled) {
        total += accounts.length;
      }
      vaultStats.value = { totalAccounts: total, integrationTypes: enabled.length };
      vaultStatsKnown.value = true;
    } catch (err) {
      console.warn('[Preferences] Could not count saved passwords:', err);
    }
  }

  async function saveProfile() {
    saving.value = true;
    saved.value = false;
    try {
      await SullaSettingsModel.set('primaryUserName', userName.value, 'string');
      await SullaSettingsModel.set('sullaEmail', email.value, 'string');
      await SullaSettingsModel.set('sullaSubscribeToUpdates', subscribeToUpdates.value, 'boolean');
      saved.value = true;
      setTimeout(() => { saved.value = false }, 2000);
    } catch (err) {
      console.error('[Preferences] Save failed:', err);
    } finally {
      saving.value = false;
    }
  }

  function accountsErrorMessage(error: unknown): string {
    const message = String((error as Error)?.message ?? error);
    if (message.includes('accounts_unavailable')) {
      return 'The Accounts service is unavailable. Check that Sulla is running, then retry.';
    }
    if (message.includes('authority_discovery_unavailable')) {
      return 'That server could not be reached. Check its address and availability, then retry.';
    }
    if (message.includes('invalid_authority_metadata')) {
      return 'That server did not publish valid Sulla authority details. ' +
        'Check the address or contact its administrator.';
    }
    if (message.includes('connection_not_found')) {
      return 'That connection no longer exists. Refresh the list and try again.';
    }
    if (message.includes('resource_audience_not_allowed')) {
      return 'That service is not offered by this server. Choose another service and try again.';
    }
    return 'Accounts could not complete that request. Retry, or check the server address.';
  }

  function authorityHost(issuer: string): string {
    try {
      return new URL(issuer).host;
    } catch {
      return issuer;
    }
  }

  async function refreshAccounts() {
    accountsLoading.value = accountsProfile.value === null;
    accountsPending.value = 'refresh';
    accountsError.value = '';
    accountsNotice.value = '';
    try {
      const [profile, connectionResult, memberships] = await Promise.all([
        accountsRenderer.invoke<AccountsProfile>('accounts:profile'),
        accountsRenderer.invoke<{ connections: AccountsConnection[] }>('accounts:connections'),
        accountsRenderer.invoke<AccountsMemberships>('accounts:memberships'),
      ]);
      accountsProfile.value = profile;
      accountsDisplayName.value = profile.displayName;
      accountsConnections.value = connectionResult.connections;
      accountsMemberships.value = memberships;
      for (const connection of connectionResult.connections) {
        selectedAudience.value[connection.id] ??= connection.resourceAudiences[0] ?? '';
      }
    } catch (error) {
      accountsError.value = accountsErrorMessage(error);
    } finally {
      accountsLoading.value = false;
      accountsPending.value = '';
    }
  }

  async function saveAccountsProfile() {
    accountsPending.value = 'profile';
    accountsNotice.value = '';
    accountsError.value = '';
    try {
      const profile = await accountsRenderer.invoke<AccountsProfile>('accounts:update-profile', {
        displayName: accountsDisplayName.value.trim(),
      });
      accountsProfile.value = profile;
      accountsDisplayName.value = profile.displayName;
      accountsNotice.value = 'Local profile saved.';
    } catch (error) {
      accountsError.value = accountsErrorMessage(error);
    } finally {
      accountsPending.value = '';
    }
  }

  async function discoverAuthority() {
    if (!authorityUrl.value.trim()) return;
    accountsPending.value = 'discover';
    authorityError.value = '';
    try {
      discoveredAuthority.value = await accountsRenderer.invoke<AccountsAuthority>(
        'accounts:discover-authority',
        authorityUrl.value.trim(),
      );
    } catch (error) {
      authorityError.value = accountsErrorMessage(error);
    } finally {
      accountsPending.value = '';
    }
  }

  function cancelAuthority() {
    discoveredAuthority.value = null;
    authorityError.value = '';
  }

  async function enrollAuthority() {
    const metadata = discoveredAuthority.value;
    if (!metadata) return;
    accountsPending.value = 'enroll';
    authorityError.value = '';
    try {
      await accountsRenderer.invoke<AccountsConnection>('accounts:create-connection', {
        issuer:              metadata.issuer,
        clientId:            metadata.nativeClientId,
        resourceAudiences:   metadata.resourceAudiences,
        scopes:              metadata.scopes,
        membershipEndpoint: metadata.membershipResolver,
        membershipAudience: metadata.membershipAudience,
        remoteAuthorityId:  metadata.authorityId,
      });
      authorityUrl.value = '';
      discoveredAuthority.value = null;
      await refreshAccounts();
    } catch (error) {
      authorityError.value = accountsErrorMessage(error);
    } finally {
      accountsPending.value = '';
    }
  }

  async function disconnectAccount(id: string) {
    accountsPending.value = `disconnect:${ id }`;
    accountsError.value = '';
    try {
      await accountsRenderer.invoke<void>('accounts:remove-connection', id);
      await refreshAccounts();
    } catch (error) {
      accountsError.value = accountsErrorMessage(error);
    } finally {
      accountsPending.value = '';
    }
  }

  async function authorizeAccount(id: string) {
    const resourceAudience = selectedAudience.value[id];
    if (!resourceAudience) {
      accountsError.value = 'This server does not offer a service that Sulla can authorize.';
      return;
    }
    accountsPending.value = `authorize:${ id }`;
    accountsError.value = '';
    authorizationNotice.value = '';
    try {
      const result = await accountsRenderer.invoke<{ opened: boolean; expiresAt: string }>(
        'accounts:authorize',
        { id, resourceAudience },
      );
      if (!result.opened) {
        accountsError.value = 'Sulla could not open the sign-in page. ' +
          'Retry, or open it after checking your default browser.';
        return;
      }
      const until = new Date(result.expiresAt).toLocaleTimeString();

      authorizationNotice.value = `Sign-in opened and is available until ${ until }.`;
      authorizationRefreshArmed = true;
      window.removeEventListener('focus', refreshAccountsAfterAuthorization);
      window.addEventListener('focus', refreshAccountsAfterAuthorization, { once: true });
    } catch (error) {
      accountsError.value = accountsErrorMessage(error);
    } finally {
      accountsPending.value = '';
    }
  }

  function refreshAccountsAfterAuthorization() {
    if (!authorizationRefreshArmed) return;
    authorizationRefreshArmed = false;
    refreshAccounts();
  }

  // ── Sulla Cloud handlers ──────────────────────────────────────

  async function refreshCloudStatus() {
    try {
      cloudStatus.value = await ipcRenderer.invoke('sulla-cloud:get-status');
      if (!cloudStatus.value.signedIn && cloudStatus.value.lastError) cloudError.value = cloudStatus.value.lastError;
    } catch (err) {
      console.error('[Preferences] get-status failed:', err);
    }
    try {
      relayStatus.value = await ipcRenderer.invoke('desktop-relay:get-status');
    } catch (err) {
      console.error('[Preferences] desktop-relay get-status failed:', err);
    }
  }

  function onRelayStatusChanged(_ev: unknown, status: RelayStatus) {
    relayStatus.value = status;
  }

  async function sendOtp() {
    cloudError.value = '';
    busy.value = true;
    try {
      const res = await ipcRenderer.invoke('sulla-cloud:send-otp', phoneInput.value.trim());
      cloudStatus.value = res.status;
      if (!res.ok) {
        cloudError.value = res.error || 'Failed to send code.';
        return;
      }
      otpSent.value = true;
    } finally {
      busy.value = false;
    }
  }

  async function verifyOtp() {
    cloudError.value = '';
    busy.value = true;
    try {
      const res = await ipcRenderer.invoke(
        'sulla-cloud:verify-otp',
        phoneInput.value.trim(),
        otpCode.value.trim(),
      );
      cloudStatus.value = res.status;
      if (!res.ok) {
        cloudError.value = res.error || 'Verification failed.';
        return;
      }
      resetPhoneFlow();
      await refreshCloudStatus();
    } finally {
      busy.value = false;
    }
  }

  function resetPhoneFlow() {
    otpSent.value = false;
    otpCode.value = '';
    cloudError.value = '';
  }

  async function sendEmailCode() {
    cloudError.value = '';
    busy.value = true;
    try {
      const res = await ipcRenderer.invoke('sulla-cloud:email-code-start', emailInput.value.trim());
      if (!res.ok) {
        cloudError.value = res.error || 'Could not send the code.';
        return;
      }
      emailCodeSent.value = true;
    } finally {
      busy.value = false;
    }
  }

  async function verifyEmailCode() {
    cloudError.value = '';
    busy.value = true;
    try {
      const res = await ipcRenderer.invoke(
        'sulla-cloud:email-code-verify',
        emailInput.value.trim(),
        emailCode.value.trim(),
      );
      cloudStatus.value = res.status;
      if (!res.ok) {
        cloudError.value = res.error || 'That code did not work.';
        return;
      }
      emailCode.value = '';
      emailCodeSent.value = false;
      await refreshCloudStatus();
    } finally {
      busy.value = false;
    }
  }

  async function emailSubmit() {
    cloudError.value = '';
    busy.value = true;
    try {
      const channel = emailMode.value === 'login' ? 'sulla-cloud:email-login' : 'sulla-cloud:email-register';
      const args: [string, string, string?] = emailMode.value === 'login'
        ? [emailInput.value.trim(), emailPassword.value]
        : [emailInput.value.trim(), emailPassword.value, emailName.value.trim() || undefined];
      const res = await ipcRenderer.invoke(channel, ...args);
      cloudStatus.value = res.status;
      if (!res.ok) {
        cloudError.value = res.error || 'Sign-in failed.';
        return;
      }
      emailPassword.value = '';
      await refreshCloudStatus();
    } finally {
      busy.value = false;
    }
  }

  async function appleSubmit() {
    cloudError.value = '';
    busy.value = true;
    try {
      const res = await ipcRenderer.invoke(
        'sulla-cloud:apple-sign-in',
        appleToken.value.trim(),
        undefined,
        undefined,
      );
      cloudStatus.value = res.status;
      if (!res.ok) {
        cloudError.value = res.error || 'Apple sign-in failed.';
        return;
      }
      appleToken.value = '';
      await refreshCloudStatus();
    } finally {
      busy.value = false;
    }
  }

  function openAppleInVault() {
    // Sign in with Apple is a Passwords integration in the main window.
    openMainTab('integrations');
  }

  async function signOut() {
    busy.value = true;
    try {
      cloudStatus.value = await ipcRenderer.invoke('sulla-cloud:logout');
      const signOutError = cloudStatus.value?.lastError;
      resetPhoneFlow();
      emailPassword.value = '';
      appleToken.value = '';
      await refreshCloudStatus();
      if (signOutError) cloudError.value = signOutError;
    } catch (err) {
      cloudError.value = `Sign-out failed: ${ (err as Error)?.message || err }`;
    } finally {
      busy.value = false;
    }
  }

  onMounted(async() => {
    await loadProfile();
    refreshAccounts();
    await refreshCloudStatus();
    ipcRenderer.on('desktop-relay:status-changed', onRelayStatusChanged);
  });

  onBeforeUnmount(() => {
    ipcRenderer.removeListener('desktop-relay:status-changed', onRelayStatusChanged);
    authorizationRefreshArmed = false;
    window.removeEventListener('focus', refreshAccountsAfterAuthorization);
  });

  return {
    loading,
    saving,
    saved,
    userName,
    email,
    subscribeToUpdates,
    accountsLoading,
    accountsPending,
    accountsError,
    accountsNotice,
    accountsProfile,
    accountsDisplayName,
    accountsConnections,
    accountsMemberships,
    authorityUrl,
    authorityError,
    discoveredAuthority,
    selectedAudience,
    authorizationNotice,
    vaultStats,
    vaultStatsKnown,
    cloudStatus,
    relayStatus,
    cloudTab,
    cloudError,
    busy,
    phoneInput,
    otpSent,
    otpCode,
    emailInput,
    emailPassword,
    emailName,
    emailMode,
    emailCodeSent,
    emailCode,
    appleToken,
    saveProfile,
    authorityHost,
    refreshAccounts,
    saveAccountsProfile,
    discoverAuthority,
    cancelAuthority,
    enrollAuthority,
    disconnectAccount,
    authorizeAccount,
    refreshCloudStatus,
    sendOtp,
    verifyOtp,
    resetPhoneFlow,
    sendEmailCode,
    verifyEmailCode,
    emailSubmit,
    appleSubmit,
    openAppleInVault,
    signOut,
  };
}
