// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VaultFormat } from './VaultFormat.js';

// The utility dialog: password change, recovery code, encrypted backup export and
// Bitwarden import (preview, then confirm).
export class UtilityPanels {
  constructor(dom, api) {
    this.dom = dom;
    this.api = api;
    this.pendingBitwarden = null;
    // Set by VaultConsoleApp: { loadItems() }.
    this.navigator = null;
  }

  openPanel(panel) {
    const byId = id => this.dom.byId(id);
    byId('utility-title').textContent = panel === 'security' ? 'Security & recovery' : panel === 'import' ? 'Import passwords' : 'Encrypted backup';
    this.dom.all('[data-utility]').forEach(value => { value.hidden = value.dataset.utility !== panel; });
    byId('utility-dialog').showModal();
  }

  async changePassword(event) {
    const byId = id => this.dom.byId(id);
    event.preventDefault();
    try {
      const result = await this.api.post('/v1/human/password', { currentPassword: byId('current-password').value, nextPassword: byId('new-password').value });
      if (result?.csrf) this.api.csrf = result.csrf; event.target.reset(); this.dom.message('Password changed. Use the new password next start.');
    } catch (error) { this.dom.message(error.message, true); }
  }

  async generateRecoveryCode(event) {
    const byId = id => this.dom.byId(id);
    event.preventDefault();
    try {
      const recoveryCode = VaultFormat.newRecoveryCode();
      await this.api.post('/v1/human/recovery/configure', { recoveryCode });
      event.target.reset(); byId('recovery-output').hidden = false; byId('recovery-output').textContent = recoveryCode; this.dom.message('Recovery code generated. Save it now; it will not be shown again.');
    } catch (error) { this.dom.message(error.message, true); }
  }

  async exportBackup(event) {
    event.preventDefault();
    try {
      const backup = await this.api.post('/v1/human/backup/export', { backupPassword: this.dom.byId('backup-export-password').value });
      this.dom.downloadBlob(new Blob([JSON.stringify(backup)], { type: 'application/json' }), `sulla-vault-backup-${new Date().toISOString().slice(0, 10)}.vault`);
      event.target.reset(); this.dom.message('Encrypted backup downloaded.');
    } catch (error) { this.dom.message(error.message, true); }
  }

  fileBase64(file) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('The export could not be read')); reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || ''); reader.readAsDataURL(file); });
  }

  async previewBitwarden(event) {
    const byId = id => this.dom.byId(id);
    event.preventDefault();
    try {
      const file = byId('bitwarden-file').files[0]; if (!file || file.size > 25 * 1024 * 1024) throw new Error('Choose a Bitwarden export up to 25 MB');
      const zip = file.name.toLowerCase().endsWith('.zip'); const content = zip ? await this.fileBase64(file) : await file.text();
      this.pendingBitwarden = { content, format: zip ? 'zip' : file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json', password: byId('bitwarden-password').value || undefined };
      const preview = await this.api.post('/v1/human/import/bitwarden/preview', this.pendingBitwarden);
      byId('bitwarden-counts').textContent = `Found ${preview.total}; ${preview.importable} ready to import, ${preview.duplicates} duplicates, ${preview.unmapped.length} unmapped. ${Object.entries(preview.counts).map(([type, count]) => `${type}: ${count}`).join(' · ')}`;
      byId('bitwarden-warnings').textContent = preview.warnings.join(' '); byId('bitwarden-preview').hidden = false; byId('bitwarden-confirm').disabled = !preview.importable;
    } catch (error) { this.pendingBitwarden = null; byId('bitwarden-preview').hidden = true; this.dom.message(error.message, true); }
  }

  async confirmBitwarden() {
    const byId = id => this.dom.byId(id);
    if (!this.pendingBitwarden) return;
    try {
      const result = await this.api.post('/v1/human/import/bitwarden', this.pendingBitwarden);
      this.pendingBitwarden = null; byId('bitwarden-import-form').reset(); byId('bitwarden-preview').hidden = true; byId('utility-dialog').close(); await this.navigator.loadItems();
      this.dom.message(`Imported ${result.imported} Bitwarden item${result.imported === 1 ? '' : 's'}; skipped ${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'}.`);
    } catch (error) { this.dom.message(error.message, true); }
  }

  bind() {
    const byId = id => this.dom.byId(id);
    this.dom.all('[data-panel-open]').forEach(button => button.onclick = () => this.openPanel(button.dataset.panelOpen));
    byId('utility-close').onclick = () => byId('utility-dialog').close();
    byId('password-form').onsubmit = event => this.changePassword(event);
    byId('recovery-form').onsubmit = event => this.generateRecoveryCode(event);
    byId('backup-export-form').onsubmit = event => this.exportBackup(event);
    byId('bitwarden-import-form').onsubmit = event => this.previewBitwarden(event);
    byId('bitwarden-confirm').onclick = () => this.confirmBitwarden();
  }
}
