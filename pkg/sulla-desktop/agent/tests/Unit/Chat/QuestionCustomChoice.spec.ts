// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';

import ToolQuestion from '@pkg/pages/chat/components/tool/ToolQuestion.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(() => Promise.resolve([])), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
const cards: ReturnType<typeof mount>[] = [];
afterEach(() => { cards.splice(0).forEach(card => card.unmount()) });
function fixture(multiSelect = false) {
  const answerQuestion = vi.fn();
  const controller = { messages: computed(() => []), isRunning: computed(() => false), thread: ref({ id: 'qa' }), send: vi.fn(), answerQuestion };
  const card = mount(ToolQuestion, {
    props:  { msg: { id: 'custom-choice-qa', kind: 'tool_question', status: 'pending', questions: [{ question: 'Which environment?', multiSelect, options: [{ label: 'Staging' }, { label: 'Production' }] }] } as any },
    global: { provide: { [ChatControllerKey as symbol]: controller } },
  });
  cards.push(card);
  return { card, answerQuestion };
}
describe('a written answer is its own selectable choice', () => {
  it('offers an accessible radio choice and never blends it with the listed option', async() => {
    const { card, answerQuestion } = fixture();
    await card.find('button[role=radio]').trigger('click');
    await card.find('.qc-other').trigger('focus');
    await card.find('.qc-other').setValue('Sandbox');
    expect(card.get<HTMLInputElement>('input[type=radio]').element.checked).toBe(true);
    expect(card.find('button[role=radio]').attributes('aria-checked')).toBe('false');
    await card.find('.qc-submit').trigger('click');
    expect(answerQuestion).toHaveBeenCalledWith('custom-choice-qa', [{ question: 'Which environment?', selected: ['Sandbox'] }]);
  });
  it('keeps the draft but submits only the listed choice when switching back', async() => {
    const { card, answerQuestion } = fixture();
    await card.find('.qc-other').setValue('Sandbox');
    await card.find('button[role=radio]').trigger('click');
    expect(card.get<HTMLInputElement>('input[type=radio]').element.checked).toBe(false);
    expect(card.get<HTMLTextAreaElement>('.qc-other').element.value).toBe('Sandbox');
    await card.find('.qc-submit').trigger('click');
    expect(answerQuestion.mock.calls[0][1][0].selected).toEqual(['Staging']);
  });
  it('requires text when the custom radio is selected', async() => {
    const { card } = fixture();
    await card.find('button[role=radio]').trigger('click');
    await card.find('input[type=radio]').setValue(true);
    expect(card.find('.qc-submit').attributes('disabled')).toBeDefined();
  });
  it('uses a checkbox when several answers are permitted', async() => {
    const { card, answerQuestion } = fixture(true);
    await card.find('button[role=checkbox]').trigger('click');
    await card.find('.qc-other').setValue('Sandbox');
    expect(card.get<HTMLInputElement>('input[type=checkbox]').element.checked).toBe(true);
    expect(card.find('button[role=checkbox]').attributes('aria-checked')).toBe('true');
    await card.find('.qc-submit').trigger('click');
    expect(answerQuestion.mock.calls[0][1][0].selected).toEqual(['Staging', 'Sandbox']);
  });
});
