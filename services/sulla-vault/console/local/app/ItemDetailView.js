// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { Icons, VaultFormat } from './VaultFormat.js';

// The right-hand detail pane: revealed fields, access summary and recent activity.
export class ItemDetailView {
  static MASK = '••••••••••••';

  constructor(dom, api, state, list, auditFormatter, customFields) {
    this.dom = dom;
    this.api = api;
    this.state = state;
    this.list = list;
    this.auditFormatter = auditFormatter;
    this.customFields = customFields;
    this.onEdit = () => {};
  }

  invalidate(clearSelection = true) {
    const byId = id => this.dom.byId(id);
    this.state.detailGeneration += 1;
    this.state.editingItem = null;
    if (clearSelection) this.state.selectedId = '';
    byId('edit-item').onclick = null;
    byId('detail-fields').replaceChildren();
    byId('detail-activity').replaceChildren();
    byId('activity-count').textContent = '0';
    byId('detail-content').hidden = true;
    byId('detail-empty').hidden = false;
  }

  field(label, value, secret = false) {
    const row = this.dom.create('div'); row.className = 'detail-field';
    const key = this.dom.create('span'); key.className = 'k'; key.textContent = label;
    const output = this.dom.create('span'); output.className = 'v'; output.textContent = secret ? ItemDetailView.MASK : (value || '—');
    row.append(key, output);
    if (secret && value) {
      const reveal = this.dom.create('button'); reveal.type = 'button'; reveal.innerHTML = `<svg class="i sm" aria-hidden="true" viewBox="0 0 24 24">${Icons.eyePath}</svg>`; reveal.setAttribute('aria-label', 'Reveal'); reveal.title = 'Reveal'; let shown = false;
      reveal.onclick = () => { shown = !shown; output.textContent = shown ? value : ItemDetailView.MASK; reveal.setAttribute('aria-label', shown ? 'Hide' : 'Reveal'); reveal.title = shown ? 'Hide' : 'Reveal'; if (shown) setTimeout(() => { shown = false; output.textContent = ItemDetailView.MASK; reveal.setAttribute('aria-label', 'Reveal'); reveal.title = 'Reveal'; }, 30_000); };
      row.append(reveal);
    }
    return row;
  }

  customFieldDetail(field) {
    const CF = this.customFields;
    const secret = CF.isSecret(field);
    const row = this.field(field.label, field.type === 'boolean' ? (field.value === 'true' ? 'Yes' : 'No') : field.value, secret);
    row.classList.add('custom-field-detail'); row.dataset.customType = field.type;
    const output = row.querySelector('.v');
    if (field.type === 'multiline' && !secret) output.classList.add('multiline');
    if (field.type === 'url' && field.value && !CF.valueError('url', field.value)) {
      const link = this.dom.create('a'); link.href = field.value.trim(); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = field.value.trim();
      output.replaceChildren(link);
    }
    if (field.type === 'boolean') { output.classList.add('bool-value', field.value === 'true' ? 'yes' : 'no'); output.setAttribute('aria-label', `${field.label}: ${output.textContent}`); }
    if (field.value && field.type !== 'boolean') { const copy = this.dom.iconButton(Icons.copyPath, `Copy ${field.label}`); copy.onclick = () => { void this.dom.copyValue(field.value); }; row.append(copy); }
    return row;
  }

  async select(id) {
    const byId = elementId => this.dom.byId(elementId); const state = this.state;
    const generation = state.nextDetailGeneration();
    state.selectedId = id; this.list.render();
    state.editingItem = null;
    byId('detail-empty').hidden = true; byId('detail-content').hidden = false;
    try {
      const [revealed, activity] = await Promise.all([
        this.api.revealItem(id),
        this.api.request(`/v1/human/activity?item=${encodeURIComponent(id)}`),
      ]);
      if (generation !== state.detailGeneration || state.selectedId !== id) return;
      const item = { ...revealed.item, id: revealed.id, revision: revealed.revision };
      state.editingItem = JSON.parse(JSON.stringify(item));
      this.renderItem(id, item, activity);
      byId('edit-item').onclick = () => { void this.onEdit(item); };
    } catch (error) {
      if (generation !== state.detailGeneration || state.selectedId !== id) return;
      this.invalidate(false);
      this.dom.message(error.message, true);
    }
  }

  renderItem(id, item, activity) {
    const byId = elementId => this.dom.byId(elementId); const esc = VaultFormat.esc; const audit = this.auditFormatter;
    const itemPolicy = VaultFormat.policy(item);
    byId('detail-tile').textContent = VaultFormat.initials(item); byId('detail-tile').className = `tile xl${VaultFormat.tileTint(item)}`; byId('detail-name').textContent = item.name || 'Untitled';
    byId('detail-meta').textContent = `${VaultFormat.typeLabel(item.type)} · edited ${VaultFormat.dateText(this.state.itemById(id)?.updatedAt)}`;
    const fields = byId('detail-fields'); fields.replaceChildren();
    if (item.username) fields.append(this.field('Username', item.username));
    if (item.password) fields.append(this.field(item.type === 'apiKey' ? 'Secret' : 'Password', item.password, true));
    for (const [name, value] of Object.entries(item.integration?.properties || {})) fields.append(this.field(name, value, true));
    if (item.uris?.[0]?.uri) fields.append(this.field('Website', item.uris[0].uri));
    for (const field of Array.isArray(item.customFields) ? item.customFields : []) if (field && typeof field.label === 'string') fields.append(this.customFieldDetail({ ...field, value: typeof field.value === 'string' ? field.value : '' }));
    if (item.notes) fields.append(this.field('Notes', item.notes));
    if (item.proxy) { fields.append(this.field('Agent usage hosts', item.proxy.hosts.join(', '))); for (const rule of item.proxy.rules) fields.append(this.field(`Usage: ${rule.target} ${rule.name}`, `${rule.scheme} from ${rule.scheme === 'Basic' ? 'username:password' : rule.source}`)); }
    if (!fields.children.length) fields.append(this.field('Details', 'No additional fields'));
    const enabled = itemPolicy.mode === 'agents';
    byId('detail-access-title').textContent = enabled ? 'Agents can use this' : 'Only you can use this';
    byId('detail-access-copy').textContent = enabled ? (itemPolicy.level === 'autofill' ? 'Sulla can use it without revealing the secret.' : `Agents have ${itemPolicy.level} access.`) : 'Agents cannot use this item.';
    [...byId('detail-ladder').children].forEach((node, index) => node.classList.toggle('on', index === (enabled ? { metadata: 1, autofill: 2, full: 3 }[itemPolicy.level] : 0)));
    byId('detail-sites').textContent = itemPolicy.sites.length ? itemPolicy.sites.join(', ') : 'Any registered destination';
    byId('detail-expiry').textContent = VaultFormat.dateText(itemPolicy.expiresAt); byId('detail-ask').textContent = itemPolicy.askFirst ? 'Every use' : 'No';
    const events = activity.events || []; byId('activity-count').textContent = String(events.length);
    byId('detail-activity').innerHTML = events.length ? events.slice(0, 6).map(event => `<div class="activity-event"><b>${esc(audit.action(event))}</b><span>${esc(VaultFormat.dateText(event.created_at))}</span><span>${esc(audit.isAgent(event) ? event.metadata?.agentId || 'Agent' : 'You')}</span><span>${esc(audit.result(event))}</span></div>`).join('') : '<div class="honest-state">No recorded activity for this item.</div>';
  }
}
