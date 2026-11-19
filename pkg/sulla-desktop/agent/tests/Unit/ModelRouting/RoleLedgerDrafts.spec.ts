// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom
/// <reference path="../../../../typings/shims-vue.d.ts" />

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import RoleLedger from '@pkg/components/settings/sections/modelRouting/RoleLedger.vue';
import { LedgerDrafts } from '@pkg/components/settings/sections/modelRouting/ledgerDraft';

function state(): any {
  const codexModels = [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' }, { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: [{ id: 'low' }, { id: 'high' }] }];
  const none = { frontier: [], standard: [], fast: [], coding: [], local: [] };
  return {
    agentsList:          [{ provider: 'codex', class: 'coding', enabled: true }],
    subconsciousList:    [],
    classes:             { ...none, coding: [{ provider: 'codex', model: 'gpt-6-luna', chosen: true }] },
    followProviderOrder: { frontier: true, standard: true, fast: true, coding: false, local: true },
    neverUse:            [],
    providers:           [{ id: 'codex', name: 'codex', connected: true, local: false, subscription: true, status: 'ready', coolingUntil: null, lastError: null, models: codexModels }],
    recommended:         { agentsList: [], subconsciousList: [], classes: none, followProviderOrder: {}, neverUse: [] },
    catalog:             { checkedAt: null, added: [], removed: [], moved: [] },
    classUsers:          {},
  };
}
const mountLedger = (s = state()) => mount(RoleLedger, { props: { state: s, now: Date.now(), refreshing: false }, attachTo: document.body });
const bar = () => document.body.querySelector('.ld-bar');

afterEach(() => { document.body.innerHTML = ''; LedgerDrafts.shared.clear() });

describe('unsaved model choices are visible and survive leaving the page', () => {
  // risk: a change made without a visible Save is silently lost
  it('shows the save bar as soon as a model or effort changes', async() => {
    const w = mountLedger();
    expect(bar()).toBeNull();
    await w.find('.ld-seg button[aria-checked="false"]').trigger('click');
    expect(bar()?.textContent).toContain('1 unsaved change');
    w.unmount();
  });

  // risk: switching to another settings page dropped the edit (the bug the user hit)
  it('keeps an unsaved edit when the page is left and opened again', async() => {
    const s = state();
    const first = mountLedger(s);
    await first.find('.ld-seg button[aria-checked="false"]').trigger('click');
    first.unmount();

    const again = mountLedger(s);
    await nextTick();
    expect(bar()?.textContent).toContain('unsaved');
    again.unmount();
  });

  it('shows refreshed saved routing without creating an unsaved draft', async() => {
    const w = mountLedger();
    const refreshed = state();
    refreshed.classes.coding[0].model = 'gpt-6-sol';

    await w.setProps({ state: refreshed });

    expect(w.find('.ld-model').text()).toBe('GPT-6 Sol');
    expect(bar()).toBeNull();
    expect(w.emitted('save')).toBeUndefined();

    await w.find('.ld-seg button[aria-checked="false"]').trigger('click');
    expect(bar()?.textContent).toContain('1 unsaved change');
    expect(refreshed.classes.coding[0].effort).toBeUndefined();
    w.unmount();
  });

  it('preserves an edited role while adopting refreshed settings for untouched roles', async() => {
    const initial = state();
    initial.classes.frontier = [{ provider: 'codex', model: 'gpt-6-luna', chosen: true }];
    const w = mountLedger(initial);
    await w.find('[aria-label$="effort for Coding"] button[aria-checked="false"]').trigger('click');

    const refreshed = state();
    refreshed.classes.frontier = [{ provider: 'codex', model: 'gpt-6-sol', chosen: true }];
    await w.setProps({ state: refreshed });

    expect(w.find('[aria-label*="model for Frontier"]').text()).toBe('GPT-6 Sol');
    expect(bar()?.textContent).toContain('1 unsaved change');
    expect(bar()?.textContent).toContain('Coding');
    expect(w.emitted('save')).toBeUndefined();
    w.unmount();
  });

  it('drops the kept edit once the saved settings changed underneath it', async() => {
    const first = mountLedger();
    await first.find('.ld-seg button[aria-checked="false"]').trigger('click');
    first.unmount();

    const changed = state(); changed.classes.coding[0].model = 'gpt-6-sol';
    const again = mountLedger(changed);
    await nextTick();
    expect(bar()).toBeNull();
    again.unmount();
  });
});
