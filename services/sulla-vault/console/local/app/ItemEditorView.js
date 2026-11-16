// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VaultFormat } from './VaultFormat.js';

// The create/edit item screen and its save and delete actions.
export class ItemEditorView {
  constructor(dom, api, state, customFields, properties, proxyRules) {
    this.dom = dom;
    this.api = api;
    this.state = state;
    this.customFields = customFields;
    this.properties = properties;
    this.proxyRules = proxyRules;
    // Set by VaultConsoleApp: { loadItems(), showBrowser() }.
    this.navigator = null;
  }

  setPolicyLevel(level) {
    this.dom.byId('policy-level').value = level;
    this.dom.all('[data-level]').forEach(button => button.classList.toggle('on', button.dataset.level === level));
  }

  syncPolicyEnabled() {
    const byId = id => this.dom.byId(id);
    const enabled = byId('agent-enabled').checked; byId('policy-mode').value = enabled ? 'agents' : 'only_me';
    byId('item-form').classList.toggle('policy-disabled', !enabled);
  }

  async open(item) {
    const byId = id => this.dom.byId(id); const state = this.state;
    const generation = state.nextDetailGeneration();
    byId('item-form').reset(); let detail = item;
    if (item?.id && !item.password && !item.integration?.properties) {
      const revealed = await this.api.revealItem(item.id);
      if (generation !== state.detailGeneration) return;
      detail = { ...revealed.item, id: revealed.id, revision: revealed.revision };
    }
    state.editingItem = detail ? JSON.parse(JSON.stringify(detail)) : null;
    byId('proxy-hosts').value = detail?.proxy?.hosts?.join(', ') || ''; this.proxyRules.render(detail?.proxy?.rules); byId('proxy-hint').textContent = '';
    const itemPolicy = VaultFormat.policy(detail);
    byId('item-id').value = detail?.id || ''; byId('revision').value = detail?.revision || ''; byId('item-type').value = detail?.integration ? 'integration' : detail?.type || 'login';
    byId('name').value = detail?.name || ''; byId('username').value = detail?.username || detail?.integration?.accountId || ''; byId('item-password').value = detail?.password || ''; byId('website').value = detail?.uris?.[0]?.uri || ''; byId('notes').value = detail?.notes || ''; byId('favorite').checked = Boolean(detail?.favorite);
    byId('integration-id').value = detail?.integration?.integrationId || ''; byId('account-id').value = detail?.integration?.accountId || ''; this.properties.render(detail?.integration?.properties); this.customFields.render(detail?.customFields);
    const agentsEnabled = itemPolicy.mode === 'agents'; byId('agent-enabled').checked = agentsEnabled; byId('only-me-access').checked = !agentsEnabled; this.setPolicyLevel(itemPolicy.level); byId('ask-first').checked = Boolean(itemPolicy.askFirst); byId('allow-server-agents').checked = Boolean(itemPolicy.allowServerAgents); byId('policy-sites').value = itemPolicy.sites.join(', '); byId('policy-expiry').value = VaultFormat.localDateValue(itemPolicy.expiresAt); this.syncPolicyEnabled();
    const integration = byId('item-type').value === 'integration'; byId('integration-fields').hidden = !integration; byId('item-secret-field').hidden = integration;
    this.proxyRules.syncVisibility();
    byId('delete-item').hidden = !detail?.id; byId('editor-title').textContent = detail?.id ? `Edit ${detail.name}` : 'New vault item'; byId('editor-crumb').textContent = detail?.name || 'New item'; byId('editor-tile').textContent = VaultFormat.initials(detail) || '＋';
    byId('browser-view').hidden = true; byId('connect-view').hidden = true; byId('editor-view').hidden = false; byId('name').focus();
  }

  payload() {
    const byId = id => this.dom.byId(id);
    const type = byId('item-type').value; const origin = byId('website').value.trim(); const expiry = byId('policy-expiry').value;
    const item = this.state.editingItem ? JSON.parse(JSON.stringify(this.state.editingItem)) : {};
    delete item.id; delete item.revision;
    const existingUris = Array.isArray(item.uris) ? item.uris : [];
    item.type = type === 'integration' ? 'apiKey' : type;
    item.name = byId('name').value.trim(); item.favorite = byId('favorite').checked;
    item.username = byId('username').value; item.password = byId('item-password').value; item.notes = byId('notes').value;
    item.uris = origin ? [{ ...(existingUris[0] || {}), uri: origin }, ...existingUris.slice(1)] : existingUris.slice(1);
    item.agentPolicy = { mode: byId('policy-mode').value, level: byId('policy-level').value, agents: [], sites: VaultFormat.sites(byId('policy-sites').value), expiresAt: expiry ? new Date(expiry).toISOString() : null, askFirst: byId('ask-first').checked, allowServerAgents: byId('allow-server-agents').checked };
    if (type === 'integration') item.integration = { ...(item.integration || {}), integrationId: byId('integration-id').value.trim(), accountId: byId('account-id').value.trim(), properties: this.properties.read() };
    else delete item.integration;
    const customFields = this.customFields.read();
    if (customFields.length) item.customFields = customFields; else delete item.customFields;
    if (['apiKey', 'login'].includes(type)) {
      const hosts = VaultFormat.entries(byId('proxy-hosts').value); const rules = this.proxyRules.read();
      if (hosts.length || rules.length) item.proxy = { hosts, rules }; else delete item.proxy;
    }
    return item;
  }

  async save() {
    const byId = id => this.dom.byId(id);
    const id = byId('item-id').value; const revision = Number(byId('revision').value || 0);
    try {
      const result = await this.api.request(id ? `/v1/human/items/${encodeURIComponent(id)}` : '/v1/human/items', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(id ? { item: this.payload(), revision } : { item: this.payload() }) });
      byId('item-password').value = ''; this.state.selectedId = result.id; await this.navigator.loadItems(); this.navigator.showBrowser(); this.dom.message('Item saved.');
    } catch (error) { this.dom.message(error.message, true); }
  }

  async delete() {
    const byId = id => this.dom.byId(id);
    const id = byId('item-id').value; if (!id || !confirm('Delete this vault item?')) return;
    try {
      await this.api.request(`/v1/human/items/${encodeURIComponent(id)}?revision=${encodeURIComponent(byId('revision').value)}`, { method: 'DELETE' });
      this.state.selectedId = ''; await this.navigator.loadItems(); this.navigator.showBrowser(); byId('detail-content').hidden = true; byId('detail-empty').hidden = false; this.dom.message('Item deleted.');
    } catch (error) { this.dom.message(error.message, true); }
  }

  bind() {
    const byId = id => this.dom.byId(id);
    this.proxyRules.bind(); this.properties.bind(); this.customFields.bind();
    byId('item-type').onchange = () => { this.proxyRules.syncVisibility(); const integration = byId('item-type').value === 'integration'; byId('integration-fields').hidden = !integration; byId('item-secret-field').hidden = integration; if (integration && !byId('integration-properties').children.length) this.properties.render({}); };
    this.dom.all('input[name="policy-access"]').forEach(input => { input.onchange = () => this.syncPolicyEnabled(); });
    this.dom.all('[data-level]').forEach(button => button.onclick = () => this.setPolicyLevel(button.dataset.level));
    byId('item-form').onsubmit = async event => { event.preventDefault(); await this.save(); };
    byId('delete-item').onclick = async() => { await this.delete(); };
    byId('new-item').onclick = () => { void this.open(null).catch(error => this.dom.message(error.message, true)); };
  }
}
