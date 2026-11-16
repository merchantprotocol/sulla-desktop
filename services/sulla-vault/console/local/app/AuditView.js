// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { Icons, VaultFormat } from './VaultFormat.js';

// The audit log screen: filters, paging and the event detail pane.
export class AuditView {
  constructor(dom, api, formatter) {
    this.dom = dom;
    this.api = api;
    this.formatter = formatter;
    this.byId = id => dom.byId(id);
    this.generation = 0;
    this.events = [];
    this.offset = 0;
    this.actor = 'all';
    this.hasMore = false;
  }

  // Drops any in-flight audit response (used when leaving the audit view).
  cancelPending() { this.generation += 1; }

  invalidate() {
    const byId = this.byId;
    this.generation += 1;
    this.events = [];
    this.hasMore = false;
    byId('audit-rows').replaceChildren();
    byId('audit-detail').replaceChildren();
    byId('audit-total').textContent = byId('audit-agent-count').textContent = byId('audit-blocked-count').textContent = '0';
    byId('audit-prev').disabled = byId('audit-next').disabled = true;
  }

  renderDetail(index) {
    const byId = this.byId; const esc = VaultFormat.esc; const format = this.formatter;
    const event = this.events[index];
    if (!event) { byId('audit-detail').innerHTML = '<div class="empty-state"><b>Select an event</b><span>Authorized metadata will appear here.</span></div>'; return; }
    this.dom.all('[data-audit-event]').forEach((row, rowIndex) => row.classList.toggle('selected', rowIndex === index));
    const agent = format.isAgent(event);
    byId('audit-detail').innerHTML = `<span class="audit-result ${event.blocked ? 'blocked' : ''}">${esc(format.result(event))}</span><h2>${esc(format.action(event))}</h2>${event.blocked ? `<div class="reason">${esc(event.reason || 'The action was denied before a secret was released.')}</div>` : ''}<div class="kv"><span>Who</span><b>${esc(agent ? event.metadata?.agentId || 'Agent' : 'You')}</b></div><div class="kv"><span>Item</span><b>${esc(format.item(event))}</b></div><div class="kv"><span>Where</span><b>${esc(format.where(event))}</b></div><div class="kv"><span>Pod</span><b>${esc(event.pod_id || '—')}</b></div><div class="kv"><span>When</span><b>${esc(VaultFormat.dateText(event.created_at))}</b></div><p class="security-note">This event contains authorized audit metadata only. No secret value is returned.</p>`;
  }

  render() {
    const byId = this.byId; const esc = VaultFormat.esc; const format = this.formatter;
    byId('audit-total').textContent = String(this.events.length);
    byId('audit-agent-count').textContent = String(this.events.filter(event => format.isAgent(event)).length);
    byId('audit-blocked-count').textContent = String(this.events.filter(event => event.blocked).length);
    byId('audit-page').textContent = `Page ${Math.floor(this.offset / 25) + 1}`;
    byId('audit-prev').disabled = this.offset === 0; byId('audit-next').disabled = !this.hasMore;
    byId('audit-rows').innerHTML = this.events.length ? this.events.map((event, index) => { const agent = format.isAgent(event); const who = agent ? event.metadata?.agentId || 'Agent' : 'You'; return `<tr data-audit-event="${index}"><td>${esc(VaultFormat.dateText(event.created_at))}</td><td><span class="actor-cell"><span class="avatar ${agent ? 'agent' : ''}">${agent ? Icons.agent : esc(who)}</span>${esc(who)}</span></td><td>${esc(format.action(event))}</td><td>${esc(format.item(event))}</td><td>${esc(format.where(event))}</td><td><span class="audit-result ${event.blocked ? 'blocked' : ''}">${esc(format.result(event))}</span></td></tr>`; }).join('') : '<tr><td colspan="6" class="muted">No recorded events match these filters.</td></tr>';
    this.dom.all('[data-audit-event]').forEach(row => row.onclick = () => this.renderDetail(Number(row.dataset.auditEvent)));
    this.renderDetail(this.events.length ? 0 : -1);
  }

  async load() {
    const byId = this.byId;
    const generation = ++this.generation;
    byId('audit-rows').innerHTML = '<tr><td colspan="6" class="muted">Loading authorized audit events…</td></tr>';
    const params = new URLSearchParams({ limit: '25', offset: String(this.offset) });
    if (this.actor === 'human' || this.actor === 'agent') params.set('actor', this.actor);
    if (this.actor === 'blocked') params.set('blocked', 'true');
    const range = byId('audit-time').value;
    if (range !== 'all') params.set('from', new Date(Date.now() - ({ '24h': 1, '7d': 7, '30d': 30 }[range] || 7) * 86_400_000).toISOString());
    const search = byId('audit-search').value.trim(); if (search) params.set('query', search);
    try {
      const result = await this.api.request(`/v1/human/activity?${params}`);
      if (generation !== this.generation || byId('audit-view').hidden) return;
      this.events = result.events || []; this.hasMore = Boolean(result.hasMore); this.render();
    } catch (error) {
      const esc = VaultFormat.esc;
      if (generation !== this.generation || byId('audit-view').hidden) return;
      this.events = []; this.hasMore = false; byId('audit-total').textContent = byId('audit-agent-count').textContent = byId('audit-blocked-count').textContent = '—';
      byId('audit-rows').innerHTML = `<tr class="audit-error"><td colspan="6">${esc(error.message)}</td></tr>`; byId('audit-prev').disabled = byId('audit-next').disabled = true;
      byId('audit-detail').innerHTML = '<div class="empty-state"><b>Audit events unavailable</b><span>The request failed; this is not an empty audit log.</span></div>';
    }
  }

  // Shows the audit screen and loads page one (the caller hides the other views first).
  show() {
    const byId = this.byId;
    this.offset = 0; byId('audit-view').hidden = false;
    this.dom.all('[data-category]').forEach(button => button.classList.remove('on')); byId('nav-audit').classList.add('on'); void this.load();
  }

  bind() {
    const byId = this.byId;
    this.dom.all('[data-audit-actor]').forEach(button => button.onclick = () => { this.actor = button.dataset.auditActor; this.offset = 0; this.dom.all('[data-audit-actor]').forEach(value => value.classList.toggle('on', value === button)); void this.load(); });
    byId('audit-time').onchange = () => { this.offset = 0; void this.load(); };
    byId('audit-search').onchange = () => { this.offset = 0; void this.load(); };
    byId('audit-prev').onclick = () => { this.offset = Math.max(0, this.offset - 25); void this.load(); };
    byId('audit-next').onclick = () => { if (this.hasMore) { this.offset += 25; void this.load(); } };
  }
}
