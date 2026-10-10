import { describe, expect, it, jest } from '@jest/globals';
import { createApp, defineComponent, nextTick, ref, type Ref } from 'vue';

import { ChatControllerKey, ModelSelectorKey } from '../../controller/useChatController';
import { useSelectionLabel } from '../useSelectionLabel';

function mount(agentId: Ref<string | null>, agents: Ref<{ slug: string; name: string }[]>, refreshAgents = jest.fn(() => Promise.resolve())) {
  const thread = ref({ agentId: agentId.value });
  const controller = { thread, model: ref({ id: 'claude-opus-5-5', name: 'Opus 5.5', tier: 'hosted', ctx: '' }) };
  const selector = { agentOptions: agents, refreshAgents };
  let result!: ReturnType<typeof useSelectionLabel>;
  const app = createApp(defineComponent({ setup() { result = useSelectionLabel(); return () => null } }));
  app.provide(ChatControllerKey, controller as any);
  app.provide(ModelSelectorKey, selector as any);
  app.mount(document.createElement('div'));
  return { result, thread, refreshAgents };
}

describe('useSelectionLabel', () => {
  it('shows the model when no agent is selected', () => {
    const { result } = mount(ref(null), ref([]));
    expect(result.label.value).toBe('Opus 5.5');
  });

  it('shows the selected agent instead of its model, and follows changes', async() => {
    const { result, thread } = mount(ref(null), ref([{ slug: 'coding-manager', name: 'Coding Manager' }]));
    thread.value = { agentId: 'coding-manager' };
    await nextTick();
    expect(result.label.value).toBe('Coding Manager');
    expect(result.title.value).toContain('Opus 5.5');

    thread.value = { agentId: null };
    await nextTick();
    expect(result.label.value).toBe('Opus 5.5');
  });

  it('loads agents when a restored chat names one that is not loaded yet', () => {
    const { result, refreshAgents } = mount(ref('analytics-worker'), ref([]));
    expect(refreshAgents).toHaveBeenCalledTimes(1);
    expect(result.label.value).toBe('analytics-worker');
  });
});
