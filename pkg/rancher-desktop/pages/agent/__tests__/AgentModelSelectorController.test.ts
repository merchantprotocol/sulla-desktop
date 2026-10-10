import { describe, expect, it, jest } from '@jest/globals';
import { ref } from 'vue';

const invoke = jest.fn();
jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    invoke,
    on:             jest.fn(),
    removeListener: jest.fn(),
  },
}));

const { AgentModelSelectorController } = await import('../AgentModelSelectorController');

describe('AgentModelSelectorController chat scoping', () => {
  it('selects a model and an agent without mutating global model settings', () => {
    const selections: any[] = [];
    const controller = new AgentModelSelectorController({
      systemReady:     ref(true),
      loading:         ref(false),
      isRunning:       ref(false),
      modelName:       ref(''),
      modelMode:       ref('remote'),
      onSelectForChat: selection => selections.push(selection),
    });
    controller.selectModel({
      providerId:       'codex',
      providerName:     'Codex',
      modelId:          'gpt-6.1-sol',
      modelLabel:       'Sol',
      isActiveProvider: false,
      isActiveModel:    false,
    });
    controller.selectAgent({
      id:          'agent-reviewer',
      slug:        'reviewer',
      name:        'Reviewer',
      description: '',
      provider:    'anthropic',
      model:       'claude-opus-5-5',
      status:      'production',
      enabled:     true,
    });
    expect(selections).toEqual([
      { providerId: 'codex', modelId: 'gpt-6.1-sol', agentId: null, label: 'Sol' },
      { providerId: 'anthropic', modelId: 'claude-opus-5-5', agentId: 'reviewer', label: 'Reviewer' },
    ]);
    expect(invoke).not.toHaveBeenCalledWith('model-provider:select-model', expect.anything(), expect.anything());
  });
});

describe('AgentModelSelectorController agent list', () => {
  it('lists only enabled production agents for the chat picker', async() => {
    invoke.mockImplementation((channel: any) => Promise.resolve(channel === 'agent-definitions:list'
      ? [
        { id: '1', slug: 'live', name: 'Live', status: 'production', enabled: true },
        { id: '2', slug: 'off', name: 'Off', status: 'production', enabled: false },
        { id: '3', slug: 'draft', name: 'Draft', status: 'draft', enabled: true },
      ]
      : []));
    const controller = new AgentModelSelectorController({
      systemReady: ref(true),
      loading:     ref(false),
      isRunning:   ref(false),
      modelName:   ref(''),
      modelMode:   ref('remote'),
    });
    await controller.refreshAgents();
    expect(controller.agentOptionsValue.map(a => a.slug)).toEqual(['live']);
  });
});
