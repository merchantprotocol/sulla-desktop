import { computed, inject, watch, type ComputedRef } from 'vue';

import { ModelSelectorKey, useChatController } from '../controller/useChatController';

/**
 * What the agent/model picker should read as. A chat with a selected agent
 * shows the agent's name; otherwise it shows the model. The model stays in
 * `controller.model` either way — that's what the backend actually runs.
 */
export function useSelectionLabel(): { label: ComputedRef<string>; title: ComputedRef<string> } {
  const controller = useChatController();
  const selector = inject(ModelSelectorKey, null);
  const agentId = computed(() => controller.thread.value.agentId ?? null);
  const agentName = computed(() => {
    if (!agentId.value) return '';
    return selector?.agentOptions.value.find(agent => agent.slug === agentId.value)?.name ?? agentId.value;
  });

  // A restored chat can name an agent before the agent list has loaded.
  watch(agentId, (id) => {
    if (id && selector && !selector.agentOptions.value.some(agent => agent.slug === id)) {
      selector.refreshAgents().catch(() => undefined);
    }
  }, { immediate: true });

  const label = computed(() => agentName.value || controller.model.value.name);
  const title = computed(() => agentName.value
    ? `Agent: ${ agentName.value } · ${ controller.model.value.name } — switch agent or model`
    : 'Switch agent or model');

  return { label, title };
}
