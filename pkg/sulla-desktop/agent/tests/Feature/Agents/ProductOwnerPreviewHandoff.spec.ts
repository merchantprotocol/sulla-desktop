// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkflowPanel from '@pkg/pages/chat/components/sidedock/WorkflowPanel.vue';
import { productOwnerWorkflow } from '../../../services/ProductOwnerWorkflow';
import { modelRouter, ModelRouter, recommendedState } from '../../../languagemodels/modelRouter';
import { workerModelRouting } from '../../../services/WorkerModelRouting';
import { ModelRoutingIpcController } from '../../../../main/modelRoutingIpc';
import type { ChatModelPickerSelection } from '../../../../shared/productOwnerWorkflow';
import { ThreadModelOverridePolicy } from '../../../services/ThreadModelOverridePolicy';
import { effectiveModelChoice } from '../../../languagemodels/threadModelChoice';

const f = vi.hoisted(() => ({
  data: new Map<string, unknown>(), invoke: vi.fn(), defs: [] as any[], meta: { agentId: 'account-manager', routedAgentId: 'account-manager' } as any,
}));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: f.invoke } }));
vi.mock('../../../../window/agentWindowTrust', () => ({ agentWindowFromSender: () => true }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: {
  ready: true, get: async(key: string, fallback: unknown) => f.data.get(key) ?? fallback,
  set: async(key: string, value: unknown) => { f.data.set(key, JSON.parse(JSON.stringify(value))) },
} }));
vi.mock('../../../services/AgentDefinitionService', () => ({ agentDefinitionService: {
  list: () => f.defs, findBySlug: (slug: string) => f.defs.find(x => x.slug === slug),
} }));
vi.mock('../../../services/GraphRegistry', () => ({ GraphRegistry: { get: () => ({ state: { metadata: f.meta } }) } }));
vi.mock('../../../app/Providers/AgentJobServiceProvider', () => ({ agentJobProvider: { jobs: { findByTaskThread: async() => undefined } } }));

afterEach(() => { vi.restoreAllMocks(); f.data.clear() });

describe('Product Owner next launch from AI Team', () => {
  it('opens seven steps, saves an override through IPC and agrees with the next delegated route before and after a fallback', async() => {
    const a = { provider: 'codex', model: 'sol-test', effort: 'medium' };
    const b = { provider: 'grok', model: 'grok-test' };
    f.defs = ['account-manager','coding-manager','designer','ui-test-manager','builder','custom-builder'].map(slug => ({
      id: slug + '-id', slug, name: ({
        designer: 'Designer', builder: 'Builder', 'custom-builder': 'Builder',
      } as Record<string, string>)[slug] ?? slug, is_builtin: slug !== 'custom-builder', status: 'production', enabled: true, can_call: ['*'],
      model_choice: { mode: 'class', class: 'coding' },
    }));
    const settings = recommendedState();
    settings.classes.coding = [a,b];
    f.data.set('modelRouting',settings);
    const router = new ModelRouter(() => ({
      getAvailableProviders: async() => [{ id:'codex',connected:true },{ id:'grok',connected:true }],
      getModelsForProvider: async(id: string) => id === 'codex' ? [{ id:a.model,label:a.model,efforts:[{ id:'medium', label:'Medium' }] }] : [{ id:b.model,label:b.model }],
    }));
    vi.spyOn(modelRouter,'getEditableState').mockImplementation(router.getEditableState.bind(router));
    vi.spyOn(modelRouter,'providerInfo').mockImplementation(router.providerInfo.bind(router));
    vi.spyOn(modelRouter,'resolve').mockImplementation(router.resolve.bind(router));
    vi.spyOn(workerModelRouting,'subscriptionConnections').mockResolvedValue({ codex:'test-codex',grok:'test-grok' });
    const handlers = new Map<string, Function>();
    const ipc = { handle: (key: string, fn: Function) => handlers.set(key,fn), removeHandler: (key: string) => handlers.delete(key), on: vi.fn() };
    new ModelRoutingIpcController(ipc, { router, recommendedState, listAgents: async() => f.defs, onIntegrationValueChange: vi.fn(), broadcast: vi.fn() }).register();
    const frame = {};
    const event = { sender: { mainFrame:frame,getURL:() => 'app://./agent.html' }, senderFrame:frame };
    f.invoke.mockImplementation(async(channel: string,...args: unknown[]) => handlers.get(channel)!(event,...args));
    const thread='preview-qa';
    const modelPicker = ref<ChatModelPickerSelection>();
    const panel=mount(WorkflowPanel,{ props:{view:'team'},global:{provide:{ 'chat:activity-context':{ backendThreadId:ref(thread), modelPicker } }} });
    try {
      await flushPromises();
      const steps = panel.findAll('.wf-tree button');
      expect(steps).toHaveLength(7);
      expect(steps[1].text()).toContain('Designer');
      expect(steps[1].text()).not.toContain('Mockup Designer');
      expect(steps[0].text()).toContain('sol-test');
      expect(steps[3].text()).toContain('At handoff');
      expect(steps[6].text()).toContain('sol-test');
      await steps[2].trigger('click');
      expect(panel.get('[aria-label="Next launch"]').text()).toContain('Inherits the coding class');
      await panel.get('button.wf-primary').trigger('click');
      const add = () => panel.findAll('form button').find(btn => /Choose a model|Add fallback/.test(btn.text()))!.trigger('click');
      await add();
      await panel.get('#workflow-model-0').setValue('codex/sol-test');
      await panel.get('[aria-label="Effort for model 1"]').setValue('medium');
      await add();
      await panel.get('#workflow-model-1').setValue('grok/grok-test');
      await panel.get('form').trigger('submit');
      await flushPromises();
      expect(panel.get('[aria-label="Next launch"]').text()).toContain('saved for this step');
      expect(panel.get('[aria-label="Next launch"]').text()).toContain('Fallback 1');
      const scope = { lead:true, caller:'account-manager',root:thread };
      const initial = await productOwnerWorkflow.productOwnerDelegation(scope,'coding-manager','build');
      const next = await productOwnerWorkflow.getProductOwnerWorkflow(thread);
      expect(await workerModelRouting.resolveRoute(initial!.route!)).toEqual(next.steps.build!.preview!.candidates);
      expect(next.steps.build!.preview!.candidates).toEqual([a,b]);
      settings.neverUse=[{ ...a, effort:'any' }];
      const changed = await productOwnerWorkflow.getProductOwnerWorkflow(thread);
      const after = await productOwnerWorkflow.productOwnerDelegation(scope,'coding-manager','build');
      expect(changed.steps.build!.preview!.candidates).toEqual([b]);
      expect(await workerModelRouting.resolveRoute(after!.route!)).toEqual([b]);
      expect(changed.steps.build!.preview!.launchRequestPolicy).toContain('Omit an explicit model request');
      await expect(workerModelRouting.applyWorkflowRequest(after!.route!, b)).rejects.toThrow('conflicts');
      expect(initial!.route!.candidates).toEqual([a,b]);
      f.meta.workerModelChatOverride=true;
      f.meta.agent={ provider:'grok',model:b.model };
      const pinned = await productOwnerWorkflow.getProductOwnerWorkflow(thread);
      expect(pinned.steps.lead!.preview).toMatchObject({ status:'ready', candidates:[b],reason:expect.stringContaining('chat model picker') });

      // Seed a saved Workflow override and a different last-dispatched picker selection.
      await productOwnerWorkflow.saveProductOwnerWorkflow({ threadId: thread, step: 'lead', expectedRevision: '', choice: { candidates: [b] } });
      const defaultsKey = 'modelDefaults';
      f.data.set(defaultsKey, { chat: { kind: 'agent', agentId: 'account-manager' }, heartbeat: { kind: 'agent', agentId: 'sulla' } });
      const beforePicker = structuredClone([...f.data]);
      const preservedMetadata = structuredClone(f.meta);
      await steps[0].trigger('click');
      modelPicker.value = { modelSelection: 'explicit', providerId: a.provider, modelId: a.model };
      await flushPromises();
      const policy = new ThreadModelOverridePolicy();
      const dispatchChoice = effectiveModelChoice(policy.apply(f.meta.agent, policy.parse(modelPicker.value)) ?? {});
      expect(await modelRouter.resolve('agents', dispatchChoice)).toEqual([{ provider: a.provider, model: a.model }]);
      expect(panel.get('[aria-label="Next launch"]').text()).toContain(a.model);
      expect(panel.get('[aria-label="Next launch"]').text()).toContain('chat model picker');
      expect(panel.get('[aria-label="Next launch"]').text()).not.toContain(b.model);

      modelPicker.value = { modelSelection: 'default' };
      await flushPromises();
      const leadRoute = await productOwnerWorkflow.productOwnerLeadRoute(thread);
      expect(await workerModelRouting.resolveRoute(leadRoute!)).toEqual([b]);
      await vi.waitFor(() => {
        expect(panel.get('[aria-label="Next launch"]').text()).toContain(b.model);
        expect(panel.get('[aria-label="Next launch"]').text()).toContain('saved for this step');
      });
      expect(f.meta).toEqual(preservedMetadata);
      expect([...f.data]).toEqual(beforePicker);

      f.data.delete(defaultsKey);
      modelPicker.value = { modelSelection: 'default', agentId: 'account-manager' };
      await flushPromises();
      expect(panel.get('[aria-label="Next launch"]').text()).toContain(b.model);
      modelPicker.value = { modelSelection: 'default' };
      await flushPromises();
      await vi.waitFor(() => expect(panel.get('[aria-label="Next launch"]').text()).toContain('routes the next message to Sulla'));
      expect(f.data.has(defaultsKey)).toBe(false);

      settings.neverUse = [];
      await steps[2].trigger('click');
      await panel.get('button.wf-primary').trigger('click');
      const agentSelect = panel.get('#workflow-agent');
      expect(agentSelect.text()).toContain('Builder · builder');
      expect(agentSelect.text()).toContain('Builder · custom-builder');
      await agentSelect.setValue('builder');
      await panel.get('form').trigger('submit');
      await flushPromises();
      const renamed = await productOwnerWorkflow.productOwnerDelegation(scope, 'coding-manager', 'build');
      expect(renamed?.slug).toBe('builder');
      expect(renamed?.route?.agentId).toBe('builder-id');
      expect(renamed?.route?.selected).toBe(0);
      expect(await workerModelRouting.resolveRoute(renamed!.route!)).toEqual([a, b]);

      await panel.get('button.wf-primary').trigger('click');
      await panel.get('#workflow-agent').setValue('custom-builder');
      await panel.get('form').trigger('submit');
      await flushPromises();
      const custom = await productOwnerWorkflow.productOwnerDelegation(scope, 'coding-manager', 'build');
      expect(custom?.route).toMatchObject({ slug: 'custom-builder', agentId: 'custom-builder-id', selected: 0, candidates: [a, b] });
      expect(renamed?.route).toMatchObject({ slug: 'builder', agentId: 'builder-id', selected: 0 });

    } finally { panel.unmount(); delete f.meta.workerModelChatOverride; delete f.meta.agent }
  });
});
