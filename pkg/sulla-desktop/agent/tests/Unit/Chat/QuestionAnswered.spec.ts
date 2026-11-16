// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';

import ToolQuestion from '@pkg/pages/chat/components/tool/ToolQuestion.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(() => Promise.resolve([])), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));

const question = { question: 'Rate backfill?', header: 'Rate backfill', options: [{ label: 'A. Forward-only' }, { label: 'B. Backfill' }] };
const controller = { messages: computed(() => []), isRunning: computed(() => false), thread: ref({ id: 'c' }), send: vi.fn(), answerQuestion: vi.fn() };
const mountCard = (msg: Record<string, unknown>) => mount(ToolQuestion, {
  props:  { msg: { id: 'm', kind: 'tool_question', createdAt: 0, questionId: 'q', questions: [question], ...msg } as any },
  global: { provide: { [ChatControllerKey as symbol]: controller } },
});

describe('an answered question card', () => {
  // risk: the card showed the question and the chosen option twice
  it('shows your answer once when the picked option is on the card', async() => {
    const card = mountCard({ status: 'pending' });
    await card.find('.qc-option').trigger('click');
    await card.setProps({ msg: { ...card.props('msg'), status: 'answered', answers: [{ question: 'Rate backfill?', selected: ['A. Forward-only'] }] } });
    expect(card.find('.qc-answers').exists()).toBe(false);
    expect(card.text()).toContain('A. Forward-only');
  });

  it('still lists the answers when the picks are not known (after a restart, or typed in Other)', () => {
    const card = mountCard({ status: 'answered', answers: [{ question: 'Rate backfill?', selected: ['Only for new time'] }] });
    expect(card.find('.qc-answers').text()).toContain('Only for new time');
  });
});
