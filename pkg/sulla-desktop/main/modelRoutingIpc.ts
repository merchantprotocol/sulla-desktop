// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MODEL_CLASSES, MODEL_ROUTING_IPC, type ModelClass, type ModelRoutingState } from '../agent/languagemodels/modelRoutingTypes';

import type { IpcController, IpcMainRegistrar } from './ipc/IpcController';

/** The modelRouter surface this controller uses. */
export interface ModelRoutingRouter {
  getEditableState(): Promise<any>;
  providerInfo(): Promise<any>;
  catalogReport(): Promise<any>;
  set(patch: any): Promise<unknown>;
  reset(target: any): Promise<unknown>;
  refreshCatalog(): Promise<unknown>;
  onStatusChange(listener: () => void): unknown;
}

export interface ModelRoutingDependencies {
  router: ModelRoutingRouter;
  recommendedState(): any;
  /** Enabled agent definitions (name, enabled flag, model choice). */
  listAgents(): Promise<{ name: string; enabled: boolean; model_choice?: any }[]>;
  onIntegrationValueChange(listener: (value: { property: string }) => void): unknown;
  /** Push a status payload to every open window. */
  broadcast(channel: string, payload: unknown): void;
}

/** Preferences → AI models → Routing. */
export class ModelRoutingIpcController implements IpcController {
  constructor(private readonly ipc: IpcMainRegistrar, private readonly deps: ModelRoutingDependencies) {}

  /** Enabled agents whose model choice is a class, by class, so the page can say who uses each role. */
  async classUsers(): Promise<Partial<Record<ModelClass, string[]>>> {
    const out: Partial<Record<ModelClass, string[]>> = {};
    try {
      for (const agent of await this.deps.listAgents()) {
        const choice = agent.model_choice;
        if (!agent.enabled || choice?.mode !== 'class' || !MODEL_CLASSES.includes(choice.class)) continue;
        (out[choice.class as ModelClass] ??= []).push(agent.name);
      }
    } catch { /* the page still works without the names */ }

    return out;
  }

  async state(): Promise<ModelRoutingState> {
    const router = this.deps.router;
    const [editable, providers, catalog, users] = await Promise.all([router.getEditableState(), router.providerInfo(), router.catalogReport(), this.classUsers()]);

    return { ...editable, providers, recommended: this.deps.recommendedState(), catalog, classUsers: users };
  }

  register(): void {
    const { router } = this.deps;
    this.ipc.removeHandler(MODEL_ROUTING_IPC.get);
    this.ipc.removeHandler(MODEL_ROUTING_IPC.set);
    this.ipc.removeHandler(MODEL_ROUTING_IPC.reset);
    this.ipc.removeHandler(MODEL_ROUTING_IPC.refresh);
    this.ipc.handle(MODEL_ROUTING_IPC.get, () => this.state());
    this.ipc.handle(MODEL_ROUTING_IPC.set, async(_event, patch) => {
      await router.set(patch || {});

      return this.state();
    });
    this.ipc.handle(MODEL_ROUTING_IPC.reset, async(_event, target) => {
      if (!target || !['agents', 'subconscious', 'classes'].includes(target.section)) throw new Error('Invalid model routing reset target');
      await router.reset(target);

      return this.state();
    });
    this.ipc.handle(MODEL_ROUTING_IPC.refresh, async() => {
      await router.refreshCatalog();

      return this.state();
    });
    const pushStatus = () => void router.providerInfo().then(providers => this.deps.broadcast(MODEL_ROUTING_IPC.status, providers));
    router.onStatusChange(pushStatus);
    this.deps.onIntegrationValueChange((value) => {
      if (value.property === 'connection_status' || value.property === 'model') pushStatus();
    });
  }
}
