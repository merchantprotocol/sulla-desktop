// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VaultFormat } from './VaultFormat.js';

// The guided "Connect <integration>" screen Desktop opens for a new account, and
// the integration/account hint that decides between it and the item editor.
export class ConnectView {
  constructor(dom, api, state, launch, editor, location) {
    this.dom = dom;
    this.api = api;
    this.state = state;
    this.launch = launch;
    this.editor = editor;
    this.location = location;
    // Set by VaultConsoleApp: { loadItems(), showBrowser() }.
    this.navigator = null;
  }

  async openIntegrationHint() {
    const { integrationHint, accountHint, connectSpec } = this.launch;
    if (!integrationHint) return;
    if (accountHint) for (const item of this.state.items.slice(0, 200)) { const revealed = await this.api.revealItem(item.id); if (revealed.item?.integration?.integrationId === integrationHint && revealed.item?.integration?.accountId === accountHint) { await this.editor.open({ ...revealed.item, id: revealed.id, revision: revealed.revision }); return; } }
    if (!accountHint && connectSpec) { this.open(); return; }
    await this.editor.open({ type: 'apiKey', name: integrationHint, integration: { integrationId: integrationHint, accountId: accountHint || 'default', properties: {} } });
  }

  show(visible) { const byId = id => this.dom.byId(id); byId('connect-view').hidden = !visible; if (visible) { byId('browser-view').hidden = true; byId('editor-view').hidden = true; byId('audit-view').hidden = true; } }

  open() {
    const byId = id => this.dom.byId(id); const text = VaultFormat.text; const spec = this.launch.connectSpec;
    const name = text(spec.name, 120) || this.launch.integrationHint;
    byId('connect-form').reset();
    byId('connect-title').textContent = `Connect ${name}`; byId('connect-crumb').textContent = `Connect ${name}`;
    byId('connect-description').textContent = text(spec.description, 400); byId('connect-tile').textContent = VaultFormat.initials({ name });
    const formGuide = text(spec.formGuide); byId('connect-form-guide').hidden = !formGuide;
    byId('connect-form-guide').replaceChildren(Object.assign(this.dom.create('b'), { textContent: 'Where to find this information: ' }), formGuide);
    const fields = byId('connect-fields'); fields.replaceChildren();
    for (const field of spec.fields.slice(0, 20)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(field?.key || '')) continue;
      fields.append(this.fieldLabel(field));
    }
    const guide = spec.guide || {}; const steps = Array.isArray(guide.steps) ? guide.steps.slice(0, 20) : []; const notes = Array.isArray(guide.notes) ? guide.notes.slice(0, 20) : [];
    byId('connect-guide').hidden = !steps.length && !notes.length && !guide.title;
    byId('connect-guide-title').textContent = text(guide.title, 200); byId('connect-guide-description').textContent = text(guide.description, 1_000);
    byId('connect-guide-steps').replaceChildren(...steps.map(step => { const li = this.dom.create('li'); li.append(Object.assign(this.dom.create('b'), { textContent: text(step?.title, 200) }), Object.assign(this.dom.create('span'), { textContent: text(step?.content) })); return li; }));
    byId('connect-guide-notes').hidden = !notes.length;
    byId('connect-guide-notes-list').replaceChildren(...notes.map(note => Object.assign(this.dom.create('li'), { textContent: text(note, 1_000) })));
    this.show(true); byId('connect-label').focus();
  }

  fieldLabel(field) {
    const text = VaultFormat.text; const create = tag => this.dom.create(tag);
    const label = create('label'); label.className = 'wide';
    label.append(text(field.title, 120) || field.key);
    if (field.required) label.append(Object.assign(create('span'), { className: 'error', textContent: ' *' }));
    const options = Array.isArray(field.options) ? field.options.filter(option => option && typeof option.value === 'string').slice(0, 500) : [];
    const input = create(field.type === 'select' && options.length ? 'select' : 'input'); input.dataset.connectKey = field.key;
    if (input.tagName === 'SELECT') {
      input.append(Object.assign(create('option'), { value: '', textContent: text(field.placeholder, 200) || 'Auto' }));
      for (const option of options) input.append(Object.assign(create('option'), { value: option.value, textContent: text(option.label, 200) || option.value }));
    } else {
      input.autocomplete = field.type === 'password' ? 'new-password' : 'off';
      input.type = field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'; input.placeholder = text(field.placeholder, 200);
    }
    input.required = Boolean(field.required);
    label.append(input);
    if (field.hint) label.append(Object.assign(create('span'), { className: 'field-help', textContent: text(field.hint, 400) }));
    if (field.type === 'select' && !options.length) label.append(Object.assign(create('span'), { className: 'field-help', textContent: 'Model choices are unavailable right now. Leave this blank to use Auto, or enter a model name.' }));
    return label;
  }

  async save() {
    const byId = id => this.dom.byId(id); const integrationHint = this.launch.integrationHint;
    const label = byId('connect-label').value.trim();
    const accountId = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
    if (!accountId) throw new Error('Give this account a label with at least one letter or number');
    if (this.state.items.some(item => item.integration?.integrationId === integrationHint && item.integration?.accountId === accountId)) throw new Error(`An account labelled "${label}" already exists for this integration`);
    const properties = { account_label: label, connection_status: 'connected', connected_at: new Date().toISOString() };
    for (const input of byId('connect-fields').querySelectorAll('[data-connect-key]')) if (input.value) properties[input.dataset.connectKey] = input.value;
    const agents = byId('connect-agents').checked;
    const item = { type: 'apiKey', name: `${VaultFormat.text(this.launch.connectSpec.name, 120) || integrationHint} — ${label}`, username: accountId, password: '', notes: '', uris: [], favorite: false,
      agentPolicy: { ...VaultFormat.defaultPolicy(), mode: agents ? 'agents' : 'only_me', level: agents ? 'autofill' : 'metadata' },
      integration: { integrationId: integrationHint, accountId, properties } };
    await this.api.request('/v1/human/items', { method: 'POST', body: JSON.stringify({ item }) });
    byId('connect-form').reset(); await this.navigator.loadItems();
    // Desktop intercepts this path, confirms the account reads back as connected,
    // then reopens the vault on the full edit screen for it. Nothing is served here.
    this.location.href = `/vault/desktop/connected?integration=${encodeURIComponent(integrationHint)}&account=${encodeURIComponent(accountId)}`;
  }

  bind() {
    for (const id of ['connect-cancel', 'connect-back']) this.dom.byId(id).onclick = () => { this.dom.byId('connect-form').reset(); this.show(false); this.navigator.showBrowser(); };
    this.dom.byId('connect-form').onsubmit = async event => { event.preventDefault(); try { await this.save(); } catch (error) { this.dom.message(error.message, true); } };
  }
}
