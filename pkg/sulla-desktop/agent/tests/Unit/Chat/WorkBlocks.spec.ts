// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';

import PatchBlock from '@pkg/pages/chat/components/patch/PatchBlock.vue';
import ErrorCard from '@pkg/pages/chat/components/transcript/ErrorCard.vue';
import { ChatControllerKey, ModelSelectorKey } from '@pkg/pages/chat/controller/useChatController';
import { LineTimeKey } from '@pkg/pages/chat/messages/lineTime';

const controller = { applyPatch: vi.fn(), rejectPatch: vi.fn(), revertPatch: vi.fn(), openArtifact: vi.fn() };
const global = {
  provide: {
    [ChatControllerKey as symbol]: controller,
    [ModelSelectorKey as symbol]:  { agentOptions: ref([{ slug: 'product-owner', name: 'Product Owner' }]) },
  },
};
const by = { agent: 'product-owner', model: 'opus-5.5' };
const patchMsg = { id: 'p9', kind: 'patch', createdAt: 0, state: 'applied', path: '/a/b/c.md', stat: { added: 1, removed: 0 }, hunks: [{ lines: [{ n: 1, op: 'add', text: 'x' }] }] } as any;

afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks() });

describe('patch', () => {
  const lines = Array.from({ length: 31 }, (_, i) => ({ n: i + 1, op: 'add', text: `line ${ i + 1 }` }));
  const patch = (state: string) => ({
    id:         'p1',
    kind:       'patch',
    createdAt:  0,
    by,
    state,
    path:       '/mnt/sulla-files/Memory/claude-code/overnight-qbo-qa-mandate-2026-11-15.md',
    stat:       { added: 31, removed: 0 },
    hunks:      [{ lines }],
    revertMeta: { op: 'write', path: 'x', oldContent: '' },
  }) as any;

  // risk: one 31-line memory file took a full screen of green diff
  it('collapses to the file, folder and line counts', () => {
    const block = mount(PatchBlock, { props: { msg: patch('applied') }, global });

    expect(block.find('.wb-title').text()).toBe('Applied · overnight-qbo-qa-mandate-2026-11-15.md · Memory / claude-code');
    expect(block.find('.wb-meta').text()).toBe('+31 −0');
    expect(block.find('.pb-diff').exists()).toBe(false);
  });

  it('expands to the full path, a 6-line preview and the rest on demand', async() => {
    const block = mount(PatchBlock, { props: { msg: patch('applied') }, global });
    await block.find('.wb-head').trigger('click');

    expect(block.find('.pb-path').text()).toContain('new file · 31 lines');
    expect(block.findAll('.pb-l')).toHaveLength(6);
    await block.find('.pb-more').trigger('click');
    expect(block.findAll('.pb-l')).toHaveLength(31);
    expect(block.findAll('.pb-btn').map(b => b.text())).toEqual(['Open file', 'Copy patch', 'Revert']);
  });

  it('keeps Apply and Reject visible for a proposed patch without expanding', async() => {
    const block = mount(PatchBlock, { props: { msg: patch('proposed') }, global });

    await block.findAll('.pb-decide .pb-btn').find(b => b.text() === 'Apply')!.trigger('click');
    expect(controller.applyPatch).toHaveBeenCalledWith('p1');
  });
});

describe('error', () => {
  it('shows the error as the title, details folded, and its action visible', async() => {
    const block = mount(ErrorCard, { props: { msg: { id: 'e1', kind: 'error', createdAt: 0, by, text: 'Merge failed', detail: 'github 405: branch protection', action: { label: 'Retry', kind: 'retry' } } as any }, global });

    expect(block.find('.wb-title').text()).toBe('Merge failed');
    expect(block.find('.ec-detail').exists()).toBe(false);
    await block.find('.ec-btn').trigger('click');
    expect(block.emitted('action')).toEqual([['retry']]);
  });
});

describe('who produced a block', () => {
  it('stamps live work blocks with the agent and model, and leaves history alone', async() => {
    const { ChatController } = await import('@pkg/pages/chat/controller/ChatController');
    const chat = new ChatController();
    chat.thread.value = { ...chat.thread.value, agentId: 'product-owner' };
    chat.model.value = { ...chat.model.value, id: 'claude-opus-5-5', name: 'opus-5.5' };
    chat.appendMessage({ id: 'live', kind: 'patch', createdAt: Date.now() } as any);
    chat.appendMessage({ id: 'old', kind: 'patch', createdAt: Date.now() - 60 * 60_000 } as any);
    chat.appendMessage({ id: 'reply', kind: 'sulla', createdAt: Date.now() } as any);
    const find = (id: string) => chat.thread.value.messages.find((m: any) => m.id === id) as any;

    expect(find('live').by).toEqual({ agent: 'product-owner', model: 'opus-5.5' });
    expect(find('old').by).toBeUndefined();
    expect(find('reply').by).toBeUndefined();
  });

  // risk: the chip read "Default", the picker's label, instead of a model
  it('uses the agent\'s configured model when the picker says Default', async() => {
    const { ChatController } = await import('@pkg/pages/chat/controller/ChatController');
    const chat = new ChatController();
    chat.thread.value = { ...chat.thread.value, agentId: 'product-owner' };
    chat.model.value = { id: '', name: 'Default', tier: 'hosted', ctx: '' };
    chat.appendMessage({ id: 'a', kind: 'patch', createdAt: Date.now() } as any);
    chat.agentModelOf = () => 'claude-opus-5-5';
    chat.appendMessage({ id: 'b', kind: 'patch', createdAt: Date.now() } as any);
    const find = (id: string) => chat.thread.value.messages.find((m: any) => m.id === id) as any;

    expect(find('a').by).toEqual({ agent: 'product-owner', model: undefined });
    expect(find('b').by).toEqual({ agent: 'product-owner', model: 'claude-opus-5-5' });
  });

  it('never shows a picker label as the model on older blocks', () => {
    const block = mount(PatchBlock, { props: { msg: { ...patchMsg, by: { agent: 'product-owner', model: 'Default' } } }, global });
    expect(block.find('.wb-by').text()).toBe('PProduct Owner');
  });

  it('shows when the block happened, from the transcript', () => {
    const block = mount(PatchBlock, {
      props:  { msg: patchMsg },
      global: { provide: { ...global.provide, [LineTimeKey as symbol]: (id: string) => (id === 'p9' ? { label: '2:28 PM', full: 'Sunday 2:28 PM' } : undefined) } },
    });
    expect(block.find('.wb-meta').text()).toBe('2:28 PM · +1 −0');
    expect(block.find('.wb-time').attributes('title')).toBe('Sunday 2:28 PM');
  });
});
