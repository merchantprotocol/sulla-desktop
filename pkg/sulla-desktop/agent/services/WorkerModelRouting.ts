// SPDX-License-Identifier: GPL-2.0-or-later
import { randomUUID } from 'node:crypto';

import { ProviderCliBridgeFailurePolicy } from '../../vault-broker/providerCliBridge';
import { VaultBrokerError } from '../../vault-broker/VaultBrokerError';
import { agentDefinitionService } from './AgentDefinitionService';
import { getIntegrationService } from './IntegrationService';
import { claudeCredentialResolver } from '../languagemodels/credentials/ClaudeCredentialResolver';
import { withWorkerBindingWrite } from '../languagemodels/workerBindingAuthority';
import { modelRouter } from '../languagemodels/modelRouter';
import { InfrastructureFailure, redactLLMFailureMessage } from '../languagemodels/providerRecovery';
import { WorkerCatalogUnavailable, captureWorkerRoute, selectWorkerCandidate, workerRouteCandidates, type WorkerModelRoute } from '../languagemodels/workerModelBindings';
import { saveThreadState } from '../nodes/ThreadStateStore';

import type { ModelCandidate } from '../languagemodels/modelRouter';
import type { BaseThreadState } from '../nodes/Graph';

export interface WorkerCatalogWait { budgetMs: number; pollMs: number }

/**
 * Same rule modelRouter.addWorkerBindingIfAbsent enforces inside its serialized write: an unmarked
 * same-agent mapping is the owner's and is reused; a marked one is reused only for its own publication.
 */
function reusableForPublication(existing: { pendingPublication?: { fileId: string; versionId: string } }, requested?: { fileId: string; versionId: string }): boolean {
  const marker = existing.pendingPublication;
  return !marker || (!!requested && marker.fileId === requested.fileId && marker.versionId === requested.versionId);
}
const STALE_PUBLICATION_MAPPING = 'An unsettled package model mapping from another publication exists; it was preserved for the owner to resolve in AI Models.';
const DEFAULT_CATALOG_WAIT: WorkerCatalogWait = { budgetMs: 5 * 60_000, pollMs: 15_000 };

/** Same shape as throwIfAborted, so each caller's existing clean-Stop handling applies. */
function stopped(): DOMException { return new DOMException('Worker model route wait stopped', 'AbortError') }

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(stopped()); return }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve() };
    const abort = () => { clearTimeout(timer); reject(stopped()) };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** The account authority could not be read right now; the approved account is unknown, not changed. */
class AccountAuthorityUnavailable extends InfrastructureFailure {}

/** IntegrationService.getActiveAccountId removed the active account (container vault metadata). */
const MISSING_VAULT_ACCOUNT = /^No local vault account is configured for /;

/**
 * Account lookups always read the local vault broker (container vault authority). Use the bridge's
 * existing vault availability policy: retryable or unavailable VaultBrokerError, Node/Electron
 * transport failures and a vault still starting. A locked vault is also a wait: unlocking resumes it.
 */
function accountAuthorityOutage(error: unknown): boolean {
  if (error instanceof AccountAuthorityUnavailable) return true;
  if (error instanceof VaultBrokerError && (error.status === 423 || error.code === 'vault_locked')) return true;
  return ProviderCliBridgeFailurePolicy.classifyProviderBridgeFailure(error, 'account').transient;
}

/** Confirmed: the approved account is gone, or subscription policy refuses it (no API-key billing). */
function confirmedAccountRefusal(error: unknown): boolean {
  if (error instanceof InfrastructureFailure) return true;
  if (error instanceof VaultBrokerError) return error.status === 404;
  return error instanceof Error && MISSING_VAULT_ACCOUNT.test(error.message);
}

export class WorkerModelRoutingService {
  constructor(private readonly catalogWait: WorkerCatalogWait = DEFAULT_CATALOG_WAIT) {}

  /** Existing work waits a bounded time for a transient catalog outage instead of failing or substituting. */
  async resolveRoute(route: WorkerModelRoute, signal?: AbortSignal): Promise<ModelCandidate[]> {
    const deadline = Date.now() + this.catalogWait.budgetMs;
    for (;;) {
      try {
        return await this.resolveRouteOnce(route);
      } catch (error) {
        if (!(error instanceof WorkerCatalogUnavailable)) throw error;
        if (signal?.aborted) throw stopped();
        if (Date.now() >= deadline) throw error;
        await pause(Math.min(this.catalogWait.pollMs, Math.max(0, deadline - Date.now())), signal);
      }
    }
  }

  private async resolveRouteOnce(route: WorkerModelRoute): Promise<ModelCandidate[]> {
    const [providers, settings] = await Promise.all([modelRouter.providerInfo(), modelRouter.getEditableState()]);
    const available = workerRouteCandidates(route, providers, settings.neverUse);
    const sameApprovedAccount: ModelCandidate[] = [];
    for (const candidate of available) {
      let current: Record<string, string>;
      try {
        current = await this.subscriptionConnections([candidate]);
      } catch (error) {
        const outage = accountAuthorityOutage(error);
        const refused = !outage && confirmedAccountRefusal(error);
        if (sameApprovedAccount.length) {
          // An earlier approved candidate already serves this resolution: omit only this fallback.
          if (!refused) console.warn(`[WorkerModelRouting] Omitting fallback ${ candidate.provider }/${ candidate.model } from this resolution: ${ redactLLMFailureMessage(error) }`);
          continue;
        }
        // An unreadable account is not a different account: wait in the existing bounded route wait.
        if (outage) throw new WorkerCatalogUnavailable('The worker\'s approved subscription account is temporarily unreadable. Waiting to read it again.', error);
        if (refused) continue;
        throw error;
      }
      if (route.connections?.[candidate.provider] === current[candidate.provider]) sameApprovedAccount.push(candidate);
    }
    if (!sameApprovedAccount.length) throw new InfrastructureFailure('No configured worker subscription still matches its approved account. Update this mapping in AI Models.');
    return sameApprovedAccount;
  }

  async subscriptionConnections(candidates: ModelCandidate[]): Promise<Record<string, string>> {
    const connections: Record<string, string> = {};
    for (const provider of new Set(candidates.map(row => row.provider))) {
      if (provider === 'claude-code') {
        const credential = await claudeCredentialResolver.resolve({ strictMetadata: true });
        if (credential.kind === 'none' && credential.unavailable) throw new AccountAuthorityUnavailable('The Claude credential authority is temporarily unavailable.');
        if (credential.kind !== 'oauth-capability' || !credential.accountId) throw new InfrastructureFailure('This worker requires an existing Claude subscription connection.');
        connections[provider] = credential.accountId;
      } else if (provider === 'codex') connections[provider] = await getIntegrationService().getActiveAccountId('codex', { strict: true });
      else if (provider === 'grok') {
        const service = getIntegrationService();
        // Strict: an unreadable account list must reach the availability policy, not read as a billing refusal.
        const [accountId, accounts] = await Promise.all([service.getActiveAccountId('grok', { strict: true }), service.getAccounts('grok', { strict: true })]);
        if (accountId !== 'oauth' || !accounts.some(account => account.account_id === accountId && account.connected)) {
          throw new InfrastructureFailure('This worker requires the existing connected Grok OAuth subscription; API-key billing is not supported for worker mappings.');
        }
        connections[provider] = accountId;
      } else throw new InfrastructureFailure('Worker mappings support existing Claude Code, Codex, and Grok OAuth subscriptions.');
    }
    return connections;
  }

  /** Validate visible pins before profile creation or a mapping write. */
  async validateSubscriptionCandidates(candidates: ModelCandidate[]): Promise<Record<string, string>> {
    if (!Array.isArray(candidates) || !candidates.length || candidates.length > 10) throw new InfrastructureFailure('Choose one to ten worker models.');
    const providers = await modelRouter.providerInfo();
    for (const candidate of candidates) {
      if (!['codex', 'claude-code', 'grok'].includes(candidate.provider)) throw new InfrastructureFailure('Worker mappings support connected Claude Code, Codex, and Grok OAuth subscription models.');
      const provider = providers.find(row => row.id === candidate.provider);
      if (!provider?.connected) throw new InfrastructureFailure(`Connect ${ candidate.provider } before saving this worker model.`);
      const model = provider.models.find(row => row.id === candidate.model && !row.unverified);
      if (!model) throw new InfrastructureFailure(`Model ${ candidate.provider }/${ candidate.model } is not in the verified live catalog. Refresh models and choose an available version.`);
      if (candidate.effort !== undefined && !model.efforts?.some(level => level.id === candidate.effort)) throw new InfrastructureFailure(`Effort ${ candidate.effort } is not supported by ${ candidate.provider }/${ candidate.model }.`);
    }
    return this.subscriptionConnections(candidates);
  }

  /** Initialize one exact local definition mapping without replacing an existing owner's selection. */
  async initializeBindingForDefinition(slug: string, agentId: string, candidates: ModelCandidate[]): Promise<void> {
    const definition = await agentDefinitionService.findBySlug(slug);
    if (!definition || definition.id !== agentId || definition.source_kind !== 'local') throw new InfrastructureFailure('The local agent changed before its model could be activated.');
    await this.addBindingIfAbsent(slug, agentId, candidates);
  }

  /** Exact identity of a mapping written by an activation; its compensating rollback removes only this entry. */
  async initializeBindingForPublishedPackage(slug: string, agentId: string, candidates: ModelCandidate[], pendingPublication?: { fileId: string; versionId: string }): Promise<{ created: boolean; binding?: { editToken: string; revision: number } }> {
    const existing = (await modelRouter.getEditableState()).workerBindings?.[slug];
    if (existing) {
      if (existing.agentId !== agentId) throw new InfrastructureFailure('A different agent already owns this worker mapping; it was preserved.');
      if (!reusableForPublication(existing, pendingPublication)) throw new InfrastructureFailure(STALE_PUBLICATION_MAPPING);
      // The owner's saved mapping is authoritative: a package pin never replaces or re-validates it.
      return { created: false };
    }
    const connections = await this.validateSubscriptionCandidates(candidates);
    const written = await this.addBindingIfAbsent(slug, agentId, candidates, connections, pendingPublication);
    return written ? { created: true, binding: written } : { created: false };
  }

  /** Before any pending registration, with or without a package pin: never register over another publication's marked mapping. */
  async assertReusablePublicationMapping(slug: string, agentId: string, pendingPublication: { fileId: string; versionId: string }): Promise<void> {
    const existing = (await modelRouter.getEditableState()).workerBindings?.[slug];
    if (existing && existing.agentId === agentId && !reusableForPublication(existing, pendingPublication)) throw new InfrastructureFailure(STALE_PUBLICATION_MAPPING);
  }

  /** Package mappings whose pending-migration registration has not been settled yet. */
  async pendingPublicationBindings(): Promise<{ slug: string; agentId: string; editToken: string; revision: number; fileId: string; versionId: string }[]> {
    const bindings = (await modelRouter.getEditableState()).workerBindings ?? {};
    return Object.entries(bindings).filter(([, binding]) => binding.pendingPublication && binding.editToken)
      .map(([slug, binding]) => ({ slug, agentId: binding.agentId, editToken: binding.editToken!, revision: binding.revision, ...binding.pendingPublication! }));
  }

  /** The registration committed: keep the mapping, drop only its marker (exact entry only). */
  async clearPendingPublication(slug: string, agentId: string, created: { editToken: string; revision: number }): Promise<void> {
    await withWorkerBindingWrite(() => modelRouter.clearPendingPublication(slug, agentId, created));
  }

  /** Returns the written entry's identity, or undefined when the same agent already had a mapping. */
  private async addBindingIfAbsent(slug: string, agentId: string, candidates: ModelCandidate[], validatedConnections?: Record<string, string>, pendingPublication?: { fileId: string; versionId: string }): Promise<{ editToken: string; revision: number } | undefined> {
    const current = await modelRouter.getEditableState();
    const existing = current.workerBindings?.[slug];
    if (existing) {
      if (existing.agentId !== agentId) throw new InfrastructureFailure('A different agent already owns this worker mapping; it was preserved.');
      if (!reusableForPublication(existing, pendingPublication)) throw new InfrastructureFailure(STALE_PUBLICATION_MAPPING);
      return undefined;
    }
    const connections = validatedConnections ?? await this.validateSubscriptionCandidates(candidates);
    // A pending-migration marker is part of the same single settings write as the mapping itself.
    const binding = { editToken: randomUUID(), agentId, revision: 1, connections, candidates: candidates.map(row => ({ ...row })), ...(pendingPublication ? { pendingPublication: { ...pendingPublication } } : {}) };
    try {
      return await withWorkerBindingWrite(() => modelRouter.addWorkerBindingIfAbsent(slug, binding)) ? { editToken: binding.editToken, revision: binding.revision } : undefined;
    } catch (error) {
      throw new InfrastructureFailure(error instanceof Error ? error.message : 'Worker model mapping could not be saved safely.', error);
    }
  }

  /** Roll back only the mapping created for this exact definition. */
  async removeBindingForDefinition(slug: string, agentId: string, created?: { editToken: string; revision: number }): Promise<void> {
    await withWorkerBindingWrite(() => modelRouter.removeWorkerBindingIfOwned(slug, agentId, created));
  }

  /** Called only at a new job/new unpinned human turn, never during recovery. */
  async newRoute(slug: string): Promise<WorkerModelRoute | undefined> {
    if (!slug) return undefined;
    const [definition, settings] = await Promise.all([agentDefinitionService.findBySlug(slug), modelRouter.getEditableState()]);
    if (!definition) return undefined;
    // An unsettled pending-migration mapping is neither run nor bypassed for another model; the
    // next Use Cases scan settles it, or the owner resolves it in AI Models.
    const own = settings.workerBindings?.[slug];
    if (own?.pendingPublication && own.agentId === definition.id) throw new InfrastructureFailure('This agent\'s model mapping is still being registered from Use Cases; it will not run on another model until it settles.');
    const route = captureWorkerRoute(slug, definition.id, settings.workerBindings ?? {});
    if (route) route.candidates = await modelRouter.workerLaunchCandidates(route.candidates);
    return route;
  }

  /** Persist before provider invocation, including the transition to a fallback. */
  async persistSelection(state: BaseThreadState, candidate: ModelCandidate): Promise<void> {
    const meta = state.metadata as any;
    const route = meta.workerModelRoute as WorkerModelRoute | undefined;
    if (!route || meta.workerModelChatOverride) return;
    const next = selectWorkerCandidate(route, candidate);
    try {
      if (meta.workerModelTask) {
        const { agentJobProvider } = await import('../app/Providers/AgentJobServiceProvider');
        const { jobId, taskIndex } = meta.workerModelTask;
        const persisted = await agentJobProvider.states.mutateJob(jobId, job => {
          const task = job.tasks[taskIndex];
          if (!['running', 'parked'].includes(job.status) || !task || !['queued', 'running', 'parked'].includes(task.status)) throw new InfrastructureFailure('Worker job is no longer active; refusing model invocation.');
          if (task.threadId !== meta.threadId || (task.generation ?? 1) !== meta.workerModelTask.generation || (task.workerModelRoute?.editToken ?? '') !== (next.editToken ?? '') || task.workerModelRoute?.revision !== next.revision || task.workerModelRoute?.agentId !== next.agentId || task.workerModelRoute.selected > next.selected) throw new InfrastructureFailure('Worker execution ownership changed; refusing stale model selection.');
          return { ...job, tasks: job.tasks.map((item, index) => index === taskIndex ? { ...item, workerModelRoute: next } : item) };
        }, undefined, false);
        if (!persisted) throw new InfrastructureFailure('Worker job is unavailable; refusing model invocation.');
      }
      meta.workerModelRoute = next;
      await saveThreadState(state);
    } catch (error) { throw new InfrastructureFailure('Worker model selection could not be saved safely.', error) }
  }
}

export const workerModelRouting = new WorkerModelRoutingService();

export function installWorkerRoute(state: BaseThreadState, route: WorkerModelRoute | undefined, task?: { jobId: string; taskIndex: number; generation?: number }): void {
  const meta = state.metadata as any;
  if (route) meta.workerModelRoute = JSON.parse(JSON.stringify(route));
  else delete meta.workerModelRoute;
  if (route && task) meta.workerModelTask = { ...task, generation: task.generation ?? 1 };
  else delete meta.workerModelTask;
}

/** Clear delegation bookkeeping for an independent human follow-up, never mutate the job. */
export function detachTerminalWorkerChat(state: BaseThreadState): void {
  const meta = state.metadata as any;
  for (const key of ['delegatedJobId', 'productOwnerWorkflowStep', 'workerModelTask', 'workerModelRoute', 'delegatedTaskIndex', 'managerAgentId', 'managerThreadId', 'workflowParentChannel', 'parentWsChannel', 'activityKeys']) delete meta[key];
  if (!meta.workerModelChatOverride && meta.agent) {
    delete meta.agent.provider;
    delete meta.agent.model;
    delete meta.agent.effort;
  }
}

/** Automatic workflow/scheduler messages use the chat envelope too. */
export function isWorkerMappingHumanTurn(type: string, channel: string, metadata?: Record<string, any>): boolean {
  return type === 'user_message' && metadata?.inputSource !== 'system' && !metadata?.origin && !channel.toLowerCase().includes('heartbeat');
}
