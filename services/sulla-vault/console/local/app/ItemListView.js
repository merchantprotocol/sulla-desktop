// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { Icons, VaultFormat } from './VaultFormat.js';

// The item list in the browser view: category/access/search filters and counts.
export class ItemListView {
  constructor(dom, state) {
    this.dom = dom;
    this.state = state;
    this.onSelect = () => {};
  }

  visibleItems() {
    const { category, accessFilter, query } = this.state;
    return this.state.items.filter(item => {
      if (category === 'favorite' && !item.favorite) return false;
      if (!['all', 'favorite'].includes(category) && item.type !== category) return false;
      if (accessFilter !== 'all' && VaultFormat.policy(item).mode !== accessFilter) return false;
      const haystack = [item.name, item.username, item.uris?.[0]?.uri, item.integration?.integrationId, item.integration?.accountId].filter(Boolean).join(' ').toLowerCase();
      return !query || haystack.includes(query);
    });
  }

  updateCounts() {
    const items = this.state.items; const byId = id => this.dom.byId(id);
    const count = name => items.filter(item => name === 'all' || (name === 'favorite' ? item.favorite : item.type === name)).length;
    for (const name of ['all', 'favorite', 'login', 'apiKey', 'card', 'note']) byId(`count-${name}`).textContent = String(count(name));
    byId('filter-all').textContent = String(items.length);
    byId('filter-only').textContent = String(items.filter(item => VaultFormat.policy(item).mode === 'only_me').length);
    byId('filter-agents').textContent = String(items.filter(item => VaultFormat.policy(item).mode === 'agents').length);
    byId('search').placeholder = `Search ${items.length} item${items.length === 1 ? '' : 's'}`;
  }

  render() {
    this.updateCounts();
    const items = this.state.items;
    const root = this.dom.byId('items');
    root.replaceChildren();
    const visible = this.visibleItems();
    if (!visible.length) {
      const empty = this.dom.create('div'); empty.className = 'empty-state';
      empty.innerHTML = `<b>${items.length ? 'No items match this view' : 'No vault items yet'}</b><span>${items.length ? 'Try another category or search.' : 'Create an item to store your first credential.'}</span>`;
      root.append(empty); return;
    }
    for (const item of visible) root.append(this.row(item));
  }

  row(item) {
    const create = tag => this.dom.create(tag);
    const itemPolicy = VaultFormat.policy(item);
    const row = create('button'); row.type = 'button'; row.className = `item-row${this.state.selectedId === item.id ? ' selected' : ''}`;
    const tile = create('span'); tile.className = `tile${VaultFormat.tileTint(item)}`; tile.textContent = VaultFormat.initials(item);
    const meta = create('span'); meta.className = 'meta';
    const name = create('span'); name.className = 'name'; name.textContent = item.name || 'Untitled';
    const sub = create('span'); sub.className = 'sub'; sub.textContent = [item.username, item.uris?.[0]?.uri, VaultFormat.typeLabel(item.type)].filter(Boolean).join(' · ');
    meta.append(name, sub);
    const summary = create('span'); summary.className = 'policy-summary';
    const level = create('span'); level.className = `lvl ${itemPolicy.level === 'full' ? 'l3' : itemPolicy.level === 'autofill' ? 'l2' : itemPolicy.mode === 'agents' ? 'l1' : ''}`; level.innerHTML = Icons.levelBars; level.append(itemPolicy.mode === 'agents' ? String(itemPolicy.level).toUpperCase() : 'NONE');
    const who = create('span'); who.className = `who ${itemPolicy.mode === 'agents' ? 'agents' : 'personal'}`; who.innerHTML = `${itemPolicy.mode === 'agents' ? Icons.agent : Icons.lock}${itemPolicy.mode === 'agents' ? 'Agents can use' : 'Only me'}`;
    summary.append(level, who); row.append(tile, meta, summary);
    row.onclick = () => { void this.onSelect(item.id); };
    return row;
  }
}
