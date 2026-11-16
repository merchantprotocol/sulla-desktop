// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Integration credential properties (name → secret) in the item editor.
export class IntegrationPropertiesEditor {
  constructor(dom) {
    this.dom = dom;
  }

  render(properties) {
    const root = this.dom.byId('integration-properties'); root.replaceChildren();
    const values = Object.entries(properties || {}); if (!values.length) values.push(['api_key', '']);
    for (const [name, value] of values.slice(0, 20)) this.addRow(name, value);
  }

  addRow(name = '', value = '') {
    const create = tag => this.dom.create(tag);
    const root = this.dom.byId('integration-properties'); const row = create('div'); row.className = 'property-row';
    const key = create('input'); key.className = 'integration-property-name'; key.placeholder = 'Property name'; key.value = name; key.autocomplete = 'off';
    const secret = create('input'); secret.className = 'integration-property-value'; secret.type = 'password'; secret.placeholder = 'Secret value'; secret.value = value; secret.autocomplete = 'new-password';
    const remove = create('button'); remove.type = 'button'; remove.className = 'btn sm'; remove.textContent = 'Remove'; remove.onclick = () => row.remove();
    row.append(key, secret, remove); root.append(row); return key;
  }

  read() {
    const rows = [...this.dom.all('.property-row')]; if (!rows.length || rows.length > 20) throw new Error('Integration credentials require 1–20 properties');
    const properties = {};
    for (const row of rows) { const name = row.querySelector('.integration-property-name').value.trim(); const value = row.querySelector('.integration-property-value').value; if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error('Property names may use letters, numbers, dot, dash, and underscore'); if (Object.hasOwn(properties, name)) throw new Error(`Duplicate integration property: ${name}`); properties[name] = value; }
    return properties;
  }

  bind() {
    this.dom.byId('add-integration-property').onclick = () => { if (this.dom.byId('integration-properties').children.length >= 20) return this.dom.message('Integration properties are limited to 20.', true); this.addRow().focus(); };
  }
}

// Agent usage rules (how a credential is injected into outbound requests).
export class ProxyRulesEditor {
  constructor(dom) {
    this.dom = dom;
  }

  render(rules) {
    const container = this.dom.byId('proxy-rules'); container.replaceChildren();
    for (const rule of rules || []) {
      const row = this.dom.create('div'); row.className = 'proxy-rule form-grid';
      row.innerHTML = '<label>Source<input class="proxy-source" placeholder="password, username, custom:Label"></label><label>Target<select class="proxy-target"><option value="header">Header</option><option value="query">Query</option></select></label><label>Name<input class="proxy-name" maxlength="64"></label><label>Scheme<select class="proxy-scheme"><option>raw</option><option>Bearer</option><option>Token</option><option>Basic</option></select></label><button type="button" class="btn sm">Remove rule</button>';
      row.querySelector('.proxy-source').value = rule.source || 'password'; row.querySelector('.proxy-target').value = rule.target || 'header'; row.querySelector('.proxy-name').value = rule.name || ''; row.querySelector('.proxy-scheme').value = rule.scheme || 'raw';
      row.querySelector('button').onclick = () => row.remove(); container.append(row);
    }
  }

  read() { return [...this.dom.byId('proxy-rules').children].map(row => ({ source: row.querySelector('.proxy-source').value.trim(), target: row.querySelector('.proxy-target').value, name: row.querySelector('.proxy-name').value.trim(), scheme: row.querySelector('.proxy-scheme').value })); }

  syncVisibility() { this.dom.byId('proxy-fields').hidden = !['apiKey', 'login'].includes(this.dom.byId('item-type').value); }

  static presetRules(preset) {
    const rule = (name, scheme = 'raw', source = 'password', target = 'header') => ({ source, target, name, scheme });
    const presets = { bearer: [rule('Authorization', 'Bearer')], key: [rule('X-API-Key')], cloudflare: [rule('Authorization', 'Bearer')], global: [rule('X-Auth-Key'), rule('X-Auth-Email', 'raw', 'username')], basic: [rule('Authorization', 'Basic')], query: [rule('api_key', 'raw', 'password', 'query')] };
    return presets[preset];
  }

  bind() {
    const byId = id => this.dom.byId(id);
    byId('add-proxy-rule').onclick = () => { const rules = this.read(); if (rules.length >= 5) return this.dom.message('At most five usage rules.', true); this.render([...rules, { source: 'password', target: 'header', name: 'X-API-Key', scheme: 'raw' }]); };
    byId('proxy-presets').onclick = event => {
      const preset = event.target.closest('[data-proxy]')?.dataset.proxy; if (!preset) return;
      if (['cloudflare', 'global'].includes(preset)) byId('proxy-hosts').value = 'api.cloudflare.com';
      byId('proxy-hint').textContent = preset === 'global' ? 'put your Cloudflare login email in Username' : '';
      this.render(ProxyRulesEditor.presetRules(preset));
    };
  }
}
