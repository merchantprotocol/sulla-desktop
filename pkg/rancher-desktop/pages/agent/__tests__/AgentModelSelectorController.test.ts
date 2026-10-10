import { describe, expect, it, jest } from '@jest/globals';
import { ref } from 'vue';

import type { ModelDescriptor } from '@pkg/pages/chat/models';

const invoke = jest.fn();

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    invoke,
    on:             jest.fn(),
    removeListener: jest.fn(),
  },
}));

const { AgentModelSelectorController } = await import('../AgentModelSelectorController');

describe('AgentModelSelectorController', () => {
  it('changes only the supplied chat selection and never writes global defaults', () => {
    const firstSelection = ref<ModelDescriptor>({ id: 'default-one', name: 'Default one', tier: 'hosted', ctx: '' });
    const secondSelection = ref<ModelDescriptor>({ id: 'default-two', name: 'Default two', tier: 'hosted', ctx: '' });
    const controller = new AgentModelSelectorController({
      systemReady: ref(true),
      loading:     ref(false),
      isRunning:   ref(false),
      modelName:   ref(''),
      modelMode:   ref<'remote'>('remote'),
      selection:   firstSelection,
      select:      selection => { firstSelection.value = selection },
    });

    controller.selectModel({
      providerId:       'codex',
      providerName:     'Codex',
      modelId:          'gpt-6-sol',
      modelLabel:       'GPT-6 Sol',
      isActiveProvider: false,
      isActiveModel:    false,
    });

    expect(firstSelection.value).toMatchObject({ providerId: 'codex', modelId: 'gpt-6-sol' });
    expect(secondSelection.value.id).toBe('default-two');
    expect(invoke).not.toHaveBeenCalledWith('model-provider:select-model', expect.anything(), expect.anything());
  });
});
