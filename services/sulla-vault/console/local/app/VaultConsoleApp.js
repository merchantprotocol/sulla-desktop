// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AuditEventFormatter } from './AuditEventFormatter.js';
import { AuditView } from './AuditView.js';
import { ConnectView } from './ConnectView.js';
import { CustomFieldEditor } from './CustomFieldEditor.js';
import { IntegrationPropertiesEditor, ProxyRulesEditor } from './ItemEditorSections.js';
import { ItemDetailView } from './ItemDetailView.js';
import { ItemEditorView } from './ItemEditorView.js';
import { ItemListView } from './ItemListView.js';
import { LaunchContext } from './LaunchContext.js';
import { SessionController } from './SessionController.js';
import { UtilityPanels } from './UtilityPanels.js';
import { VaultApi } from './VaultApi.js';
import { VaultDom } from './VaultDom.js';
import { VaultState } from './VaultState.js';

// Composition root for the local vault page: builds every view once, wires the
// navigation between them and binds the page-level controls.
export class VaultConsoleApp {
  constructor(window, customFieldRules) {
    this.window = window;
    this.launch = new LaunchContext(window.location.href);
    this.dom = new VaultDom(window.document);
    this.api = new VaultApi();
    this.state = new VaultState();
    const auditFormatter = new AuditEventFormatter(this.state);
    const customFields = new CustomFieldEditor(this.dom, this.state, customFieldRules);
    this.list = new ItemListView(this.dom, this.state);
    this.detail = new ItemDetailView(this.dom, this.api, this.state, this.list, auditFormatter, customFieldRules);
    this.editor = new ItemEditorView(this.dom, this.api, this.state, customFields, new IntegrationPropertiesEditor(this.dom), new ProxyRulesEditor(this.dom));
    this.connect = new ConnectView(this.dom, this.api, this.state, this.launch, this.editor, window.location);
    this.audit = new AuditView(this.dom, this.api, auditFormatter);
    this.session = new SessionController(this.dom, this.api, this.state, this.launch, window);
    this.utilities = new UtilityPanels(this.dom, this.api);
    this.list.onSelect = id => this.detail.select(id);
    this.detail.onEdit = item => this.editor.open(item);
    const navigator = {
      loadItems: () => this.loadItems(),
      showBrowser: () => this.showBrowser(),
      openIntegrationHint: () => this.connect.openIntegrationHint(),
    };
    for (const view of [this.editor, this.connect, this.session, this.utilities]) view.navigator = navigator;
  }

  async loadItems() {
    const state = this.state;
    const result = await this.api.request('/v1/human/items'); state.items = result.items || [];
    if (state.selectedId && !state.items.some(item => item.id === state.selectedId)) state.selectedId = '';
    this.list.render();
    if (state.selectedId) await this.detail.select(state.selectedId);
  }

  showBrowser() {
    const byId = id => this.dom.byId(id);
    this.audit.cancelPending(); byId('connect-view').hidden = true; byId('editor-view').hidden = true; byId('audit-view').hidden = true; byId('browser-view').hidden = false; byId('nav-audit').classList.remove('on');
    this.dom.all('[data-category]').forEach(button => button.classList.toggle('on', button.dataset.category === this.state.category));
  }

  showAudit() {
    const byId = id => this.dom.byId(id);
    this.detail.invalidate(); byId('connect-view').hidden = true; byId('editor-view').hidden = true; byId('browser-view').hidden = true;
    this.audit.show();
  }

  bind() {
    const byId = id => this.dom.byId(id); const state = this.state;
    this.session.bind(); this.editor.bind(); this.audit.bind(); this.connect.bind(); this.utilities.bind();
    byId('nav-audit').onclick = () => this.showAudit();
    // Desktop intercepts this path and opens its Integrations tab; nothing is served here.
    byId('nav-integrations').onclick = () => { this.window.location.href = '/vault/desktop/integrations'; };
    byId('audit-back').onclick = () => this.showBrowser();
    for (const id of ['cancel', 'editor-back']) byId(id).onclick = () => this.showBrowser();
    byId('search').oninput = event => { state.query = event.target.value.trim().toLowerCase(); this.list.render(); };
    this.window.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); byId('search').focus(); } });
    this.dom.all('[data-category]').forEach(button => button.onclick = () => { this.showBrowser(); state.category = button.dataset.category; this.dom.all('[data-category]').forEach(value => value.classList.toggle('on', value === button)); this.list.render(); });
    this.dom.all('[data-access]').forEach(button => button.onclick = () => { state.accessFilter = button.dataset.access; this.dom.all('[data-access]').forEach(value => value.classList.toggle('on', value === button)); this.list.render(); });
    this.window.addEventListener('pagehide', () => { this.detail.invalidate(); this.audit.invalidate(); this.api.clear(); state.items = []; });
  }

  run() {
    this.bind();
    return this.session.start().catch(error => this.session.showUnavailable(error));
  }
}
