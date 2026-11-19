// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VaultFormat } from './VaultFormat.js';

// Session start, unlock, first-run recovery key, recovery unlock and backup restore.
export class SessionController {
  constructor(dom, api, state, launch, window) {
    this.dom = dom;
    this.api = api;
    this.state = state;
    this.launch = launch;
    this.window = window;
    // Set by VaultConsoleApp: { loadItems(), openIntegrationHint() }.
    this.navigator = null;
  }

  setPhase(phase) {
    const unlocked = phase === 'unlocked';
    this.dom.byId('state').textContent = unlocked ? '● Unlocked' : 'Locked';
    this.dom.byId('unlock').hidden = unlocked;
    this.dom.byId('vault').hidden = !unlocked;
  }

  async start() {
    const byId = id => this.dom.byId(id); const { location, history } = this.window;
    const fragment = new URLSearchParams(location.hash.slice(1)); const grant = fragment.get('grant'); this.api.csrf = fragment.get('csrf') || ''; history.replaceState(null, '', '/vault/');
    if (!this.api.csrf) throw new Error('Open the vault from Sulla Desktop to start a protected session');
    const session = grant ? await this.api.post('/v1/human/session/exchange', { grant, csrf: this.api.csrf }) : await this.api.request('/v1/human/session');
    this.api.csrf = session.csrf;
    if (this.launch.filesRestore) {
      byId('unlock').hidden = true; byId('vault').hidden = true; byId('cloud-restore').hidden = false;
      return;
    }
    this.setPhase(session.phase);
    const setupCreatesVault = this.state.setupCreatesVault = session.setupRequired === true;
    if (session.phase === 'unlocked') {
      await Promise.all([this.navigator.loadItems(), this.navigator.openIntegrationHint()]);
    } else {
      byId('unlock-title').textContent = session.setupRequired ? 'Finish setting up your account' : 'Finish updating your account';
      byId('unlock-help').textContent = session.setupRequired ? 'Return to Sulla Desktop and sign in to finish setup.' : 'Enter your old vault password once. Sulla will move your existing encrypted data to your account password.';
      byId('password').autocomplete = session.setupRequired ? 'new-password' : 'current-password';
      byId('password-confirm-label').hidden = !setupCreatesVault;
      byId('password-confirm').required = setupCreatesVault;
    }
  }

  // Shown when the page cannot start a session at all.
  showUnavailable(error) {
    this.dom.byId('state').textContent = 'Unavailable'; this.dom.byId('unlock').hidden = false; this.dom.byId('unlock-error').textContent = error.message;
  }

  async configureOnboardingRecovery() {
    const byId = id => this.dom.byId(id);
    byId('onboarding-recovery').hidden = false;
    byId('onboarding-recovery-code').textContent = '';
    byId('onboarding-recovery-error').textContent = '';
    byId('onboarding-recovery-retry').hidden = true;
    byId('onboarding-recovery-copy').disabled = true;
    byId('onboarding-recovery-download').disabled = true;
    byId('onboarding-recovery-saved').disabled = true;
    byId('onboarding-recovery-continue').disabled = true;
    try {
      await this.api.post('/v1/human/recovery/configure', { recoveryCode: this.state.pendingRecoveryCode });
      byId('onboarding-recovery-code').textContent = this.state.pendingRecoveryCode;
      byId('onboarding-recovery-copy').disabled = false;
      byId('onboarding-recovery-download').disabled = false;
      byId('onboarding-recovery-saved').disabled = false;
      byId('onboarding-recovery').hidden = false;
    } catch (error) {
      byId('onboarding-recovery-error').textContent = `Your vault was created, but its recovery key was not saved: ${error.message}`;
      byId('onboarding-recovery-retry').hidden = false;
    }
  }

  async unlock(event) {
    const byId = id => this.dom.byId(id); const setupCreatesVault = this.state.setupCreatesVault;
    event.preventDefault(); byId('unlock-error').textContent = ''; const done = this.dom.busy(event.target, setupCreatesVault ? 'Creating vault…' : 'Unlocking…'); try {
      const password = byId('password').value;
      if (setupCreatesVault && password !== byId('password-confirm').value) throw new Error('Passwords do not match');
      const result = await this.api.post('/v1/human/unlock', { password });
      this.api.csrf = result.csrf; byId('password').value = ''; byId('password-confirm').value = ''; this.setPhase('unlocked');
      if (setupCreatesVault) {
        this.state.pendingRecoveryCode = VaultFormat.newRecoveryCode();
        byId('vault').hidden = true; byId('unlock').hidden = false; byId('unlock-form').hidden = true;
        byId('unlock-title').textContent = 'Vault created'; byId('unlock-help').textContent = 'Your vault is encrypted and its unlock cache is protected by this Mac.';
        await this.configureOnboardingRecovery();
      } else { await Promise.all([this.navigator.loadItems(), this.navigator.openIntegrationHint()]); }
    } catch (error) { byId('unlock-error').textContent = error.message || 'Could not unlock the vault. Try again.'; } finally { done(); }
  }

  async recoveryUnlock(event) {
    const byId = id => this.dom.byId(id);
    event.preventDefault(); byId('unlock-error').textContent = ''; const done = this.dom.busy(event.target, 'Unlocking…');
    try {
      const result = await this.api.post('/v1/human/recovery/unlock', { recoveryCode: byId('recovery-code').value.trim(), nextPassword: byId('recovery-password').value });
      this.api.csrf = result.csrf; event.target.reset(); this.setPhase('unlocked'); await Promise.all([this.navigator.loadItems(), this.navigator.openIntegrationHint()]);
    } catch (error) { byId('unlock-error').textContent = error.message || 'Could not unlock with that recovery key.'; } finally { done(); }
  }

  async restoreBackup(event) {
    const byId = id => this.dom.byId(id);
    event.preventDefault();
    try {
      const file = byId('backup-file').files[0]; if (file.size > 25 * 1024 * 1024) throw new Error('Backup files are limited to 25 MB');
      const backup = JSON.parse(await file.text());
      await this.api.post('/v1/human/backup/import', { backupPassword: byId('backup-import-password').value, backup });
      event.target.reset(); byId('unlock-error').textContent = 'Backup restored. Unlock it with the vault password from that backup.';
    } catch (error) { byId('unlock-error').textContent = error.message; }
  }

  bind() {
    const byId = id => this.dom.byId(id);
    byId('unlock-form').onsubmit = event => this.unlock(event);
    byId('onboarding-recovery-retry').onclick = () => { void this.configureOnboardingRecovery(); };
    byId('onboarding-recovery-saved').onchange = event => { byId('onboarding-recovery-continue').disabled = !event.target.checked; };
    byId('onboarding-recovery-copy').onclick = async() => { try { await navigator.clipboard.writeText(byId('onboarding-recovery-code').textContent); this.dom.message('Recovery key copied.'); } catch { byId('onboarding-recovery-error').textContent = 'Could not copy. Select the key and copy it manually.'; } };
    byId('onboarding-recovery-download').onclick = () => { this.dom.downloadBlob(new Blob([byId('onboarding-recovery-code').textContent + '\n'], { type: 'text/plain' }), 'sulla-vault-recovery-key.txt'); };
    byId('onboarding-recovery-continue').onclick = () => { if (byId('onboarding-recovery-saved').checked) { byId('unlock').hidden = true; byId('vault').hidden = false; void this.navigator.loadItems(); } };
    byId('recovery-unlock-form').onsubmit = event => this.recoveryUnlock(event);
    byId('backup-import-form').onsubmit = event => this.restoreBackup(event);
  }
}
