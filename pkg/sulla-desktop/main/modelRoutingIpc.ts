// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { randomUUID } from 'node:crypto';

import { withWorkerBindingWrite } from '../agent/languagemodels/workerBindingAuthority';
import { withConfirmedCliUpdate } from '../shared/providerCliUpdateAuthority';

import { MODEL_CLASSES, MODEL_ROUTING_IPC, type ModelClass, type ModelRoutingState } from '../agent/languagemodels/modelRoutingTypes';

import { agentWindowFromSender } from '../window/agentWindowTrust';
import type { WorkflowSaveInput } from '../shared/productOwnerWorkflow';

import type { IpcController, IpcMainRegistrar } from './ipc/IpcController';

/** The modelRouter surface this controller uses. */
export interface ModelRoutingRouter {
  getEditableState(): Promise<any>;
  providerInfo(): Promise<any>;
  catalogReport(): Promise<any>;
  set(patch: any): Promise<unknown>;
  replaceWorkerBinding(slug: string, agentId: string, expected: { token: string; revision: number; entry?: { agentId: string; editToken?: string; revision: number } | null }, next: { editToken: string; connections: Record<string, string>; candidates: any[] } | null): Promise<unknown>;
  reset(target: any): Promise<unknown>;
  refreshCatalog(): Promise<unknown>;
  onStatusChange(listener: () => void): unknown;
}

export interface ModelRoutingDependencies {
  router: ModelRoutingRouter;
  whenReady?(): Promise<void>;
  recommendedState(): any;
  /** All agent definitions (name, enabled flag, model choice); workers() keeps only enabled, non-archived ones. */
  listAgents(): Promise<{ id?: string; slug?: string; status?: string; run_location?: string; name: string; enabled: boolean; model_choice?: any }[]>;
  onIntegrationValueChange(listener: (value: { property: string }) => void): unknown;
  /** Push a status payload to every open window. */
  broadcast(channel: string, payload: unknown): void;
  /** Native main-process confirmation for one exact publisher release. */
  confirmCliUpdate?(provider: string, version: string): Promise<boolean>;
}

/** Preferences → AI models → Routing. */
export class ModelRoutingIpcController implements IpcController {
  constructor(private readonly ipc: IpcMainRegistrar, private readonly deps: ModelRoutingDependencies) {}

  /** Enabled agents whose model choice is a class, by class, so the page can say who uses each role. */
  async classUsers(): Promise<Partial<Record<ModelClass, string[]>>> {
    const out: Partial<Record<ModelClass, string[]>> = {};
    try {
      const bindings = (await this.deps.router.getEditableState()).workerBindings ?? {};
      for (const agent of await this.deps.listAgents()) {
        if (agent.slug && bindings[agent.slug]?.agentId === agent.id) continue;
        const choice = agent.model_choice;
        if (!agent.enabled || choice?.mode !== 'class' || !MODEL_CLASSES.includes(choice.class)) continue;
        (out[choice.class as ModelClass] ??= []).push(agent.name);
      }
    } catch { /* the page still works without the names */ }

    return out;
  }

  async workers() {
    return (await this.deps.listAgents()).filter(agent => agent.enabled && agent.status !== 'archive').map(agent => ({
      id: agent.id!, slug: agent.slug!, name: agent.name, class: agent.model_choice?.mode === 'class' ? agent.model_choice.class : 'standard', runLocation: agent.run_location,
    }));
  }

  async state(): Promise<ModelRoutingState> {
    await this.deps.whenReady?.();
    const router = this.deps.router;
    const [editable, providers, catalog, users] = await Promise.all([router.getEditableState(), router.providerInfo(), router.catalogReport(), this.classUsers()]);

    return { ...editable, providers, recommended: this.deps.recommendedState(), catalog, classUsers: users, workers: await this.workers() };
  }

  register(): void {
    // Restricted to the local app main frame, including its registered tab hosts.
    const requireWorkflowOwner = (event: Electron.IpcMainInvokeEvent) => {
      if (!event?.sender || event.sender.mainFrame !== event.senderFrame || !agentWindowFromSender(event.sender)) throw new Error('Untrusted Workflow caller.');
      const url = new URL(event.sender.getURL());
      if (url.protocol !== 'app:' || url.host !== '.' || url.pathname !== '/agent.html') throw new Error('Untrusted Workflow caller.');
    };
    this.ipc.removeHandler('chat-workflow:get');
    this.ipc.removeHandler('chat-workflow:save');
    this.ipc.removeHandler('chat-workflow:execution');
    this.ipc.removeHandler('chat-workflow:history');
    this.ipc.handle('chat-workflow:history', async(event, threadId: string) => {
      requireWorkflowOwner(event);
      return (await import('../agent/services/ProductOwnerWorkflow')).readWorkflowHistory(threadId);
    });
    this.ipc.handle('chat-workflow:get', async(event, threadId: string) => {
      requireWorkflowOwner(event);
      return (await import('../agent/services/ProductOwnerWorkflow')).getProductOwnerWorkflow(threadId);
    });
    this.ipc.handle('chat-workflow:save', async(event, input: WorkflowSaveInput) => {
      requireWorkflowOwner(event);
      return (await import('../agent/services/ProductOwnerWorkflow')).saveProductOwnerWorkflow(input);
    });
    this.ipc.handle('chat-workflow:execution', async(event, threadId: string, reference: unknown) => {
      requireWorkflowOwner(event);
      return (await import('../agent/services/ProductOwnerWorkflow')).readWorkflowExecution(threadId, reference);
    });
    const { router } = this.deps;
    this.ipc.removeHandler(MODEL_ROUTING_IPC.get);
    this.ipc.removeHandler(MODEL_ROUTING_IPC.set);
    this.ipc.removeHandler(MODEL_ROUTING_IPC.reset);
    this.ipc.removeHandler(MODEL_ROUTING_IPC.refresh);
    this.ipc.handle(MODEL_ROUTING_IPC.get, () => this.state());
    this.ipc.handle(MODEL_ROUTING_IPC.set, async(_event, patch) => {
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'workerBindings')) throw new Error('Save an individual worker mapping through its dedicated control.');
      await this.deps.whenReady?.();
      await router.set(patch || {});

      return this.state();
    });
    this.ipc.handle(MODEL_ROUTING_IPC.reset, async(_event, target) => {
      if (!target || !['agents', 'subconscious', 'classes'].includes(target.section)) throw new Error('Invalid model routing reset target');
      await this.deps.whenReady?.();
      await router.reset(target);

      return this.state();
    });
  this.ipc.removeHandler(MODEL_ROUTING_IPC.workerSet);
  let workerWrite = Promise.resolve();
  this.ipc.handle(MODEL_ROUTING_IPC.workerSet, async(_event, input) => {
    const operation = workerWrite.then(async() => {
      await this.deps.whenReady?.();
      // Record the stored same-slug entry before any async check, so a slug deleted and reused by
      // another agent meanwhile is never overwritten or removed by this stale save.
      const observed = (await router.getEditableState()).workerBindings?.[input?.slug];
      const entry = observed ? { agentId: observed.agentId, editToken: observed.editToken, revision: observed.revision } : null;
      // The owner may configure an exact saved, non-archived definition while it is disabled. This
      // only edits its mapping; the runnable workers list and launch gates stay enabled-only.
      const definitions = await this.deps.listAgents();
      const agent = definitions.find(item => item.status !== 'archive' && item.slug === input?.slug && item.id === input?.agentId) as { id: string; slug: string } | undefined;
      if (!agent) throw new Error('This agent changed or is unavailable. Reload the agent page.');
      const expected = { token: typeof input?.expectedToken === 'string' ? input.expectedToken : '', revision: input?.expectedRevision, entry };
      let next: { editToken: string; connections: Record<string, string>; candidates: any[] } | null = null;
      if (input.candidates !== null) {
        const providers = await router.providerInfo();
        if (!Array.isArray(input.candidates) || !input.candidates.length || input.candidates.length > 10) throw new Error('Choose one to ten worker models.');
        for (const candidate of input.candidates) {
          const provider = providers.find((item: any) => item.id === candidate.provider);
          if (!provider?.connected || !['codex', 'claude-code', 'grok'].includes(candidate.provider)) throw new Error('Choose an existing connected Claude Code, Codex, or Grok OAuth subscription. Grok API-key billing is not supported for worker mappings.');
          const model = provider.models.find((item: any) => item.id === candidate.model);
          if (!model || model.unverified) throw new Error('Model is not in the verified live catalog. Refresh models and choose an available version.');
          if (candidate.effort !== undefined && !model.efforts?.some((level: any) => level.id === candidate.effort)) throw new Error('Choose an effort supported by this model.');
        }
        const { workerModelRouting } = await import('../agent/services/WorkerModelRouting');
        const connections = await workerModelRouting.subscriptionConnections(input.candidates);
        next = { editToken: randomUUID(), connections, candidates: input.candidates.map((row: any) => ({ provider: row.provider, model: row.model, ...(row.effort !== undefined ? { effort: row.effort } : {}) })) };
      }
      // Compare-and-set inside the router's write serializer; validation above may take seconds.
      await withWorkerBindingWrite(() => router.replaceWorkerBinding(agent.slug, agent.id, expected, next));
      return this.state();
    });
    workerWrite = operation.then(() => undefined, () => undefined);
    return operation;
  });
    this.ipc.handle(MODEL_ROUTING_IPC.refresh, async() => {
      await this.deps.whenReady?.();
      await router.refreshCatalog();

      return this.state();
    });
    this.ipc.removeHandler(MODEL_ROUTING_IPC.cliCheck);
    this.ipc.handle(MODEL_ROUTING_IPC.cliCheck, async() => {
      await this.deps.whenReady?.();
      const { checkProviderCliVersions } = await import('../backend/providerCliUpdates');
      const providers = await router.providerInfo();
      return checkProviderCliVersions(providers.filter((provider: any) => provider.connected).map((provider: any) => provider.id));
    });
    this.ipc.removeHandler(MODEL_ROUTING_IPC.cliUpdate);
    this.ipc.handle(MODEL_ROUTING_IPC.cliUpdate, async(_event, input) => {
      const provider = typeof input?.provider === 'string' ? input.provider : '';
      const version = typeof input?.version === 'string' ? input.version : '';
      if (!provider || !version) throw new Error('Choose one provider and exact version to update.');
      if (!this.deps.confirmCliUpdate) throw new Error('Native confirmation is unavailable; no CLI was updated.');
      await this.deps.whenReady?.();
      const connected = (await router.providerInfo()).some((row: any) => row.id === provider && row.connected);
      if (!connected) throw new Error('This provider is no longer connected. Refresh AI Models before updating.');
      const { checkProviderCliVersions, installConfirmedProviderCli } = await import('../backend/providerCliUpdates');
      const current = await checkProviderCliVersions([provider]);
      const offered = current.find(row => row.provider === provider);
      if (!offered?.updateAvailable || offered.latest !== version) throw new Error('That release is no longer the confirmed available version. Refresh AI Models and review it again.');
      if (!await this.deps.confirmCliUpdate(provider, version)) return current;
      await withConfirmedCliUpdate(() => installConfirmedProviderCli(provider, version));
      return checkProviderCliVersions([provider]);
    });
    const pushStatus = async() => {
      await this.deps.whenReady?.();
      this.deps.broadcast(MODEL_ROUTING_IPC.status, await router.providerInfo());
    };
    router.onStatusChange(pushStatus);
    this.deps.onIntegrationValueChange((value) => {
      if (value.property === 'connection_status' || value.property === 'model') void pushStatus();
    });
  }
}
