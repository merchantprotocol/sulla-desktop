// SPDX-License-Identifier: GPL-2.0-or-later
import { randomUUID } from 'node:crypto';

import { ProviderCliBridgeFailurePolicy } from '../../vault-broker/providerCliBridge';
import { VaultBrokerError } from '../../vault-broker/VaultBrokerError';
import { agentDefinitionService } from './AgentDefinitionService';
import { getIntegrationService } from './IntegrationService';
import { claudeCredentialResolver } from '../languagemodels/credentials/ClaudeCredentialResolver';
import { withWorkerBindingWrite } from '../languagemodels/workerBindingAuthority';
import { candidateKey, cleanAgentModelTiers, exactTierRequest, formatModelCandidate, orderTierEntries, tiersFromCandidates, type AgentModelTiers } from '../languagemodels/agentModelTiers';
import { providerForModelId } from '../languagemodels/threadModelChoice';
import { modelRouter } from '../languagemodels/modelRouter';
import { InfrastructureFailure, redactLLMFailureMessage } from '../languagemodels/providerRecovery';
import { WorkerCatalogUnavailable, captureWorkerRoute, fileOwnedBinding, workerRouteCandidates, type WorkerModelBinding, type WorkerModelRoute } from '../languagemodels/workerModelBindings';
import { WorkerModelSelection } from './WorkerModelSelection';

import type { PoolClient } from 'pg';
import type { EditableRoutingState, RoutingProviderInfo } from '../languagemodels/modelRoutingTypes';
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

export type PublishedBindingOutcome =
  | { outcome: 'unchanged' }
  | { outcome: 'conflict'; message: string }
  | { outcome: 'written'; written: { editToken: string; revision: number } | null };

/** The exact stored representation a file wrote: flat legacy list vs tiers, and every policy. */
function sameStoredModels(binding: WorkerModelBinding, declared: { candidates: ModelCandidate[]; modelTiers?: AgentModelTiers }): boolean {
  return JSON.stringify(binding.candidates.map(candidateKey)) === JSON.stringify(declared.candidates.map(candidateKey)) &&
    JSON.stringify(binding.modelTiers ?? null) === JSON.stringify(declared.modelTiers ?? null);
}

/** The same models and policies, however they are represented; the editor's preset label is ignored. */
function sameEffectiveModels(binding: WorkerModelBinding, declared: { candidates: ModelCandidate[]; modelTiers?: AgentModelTiers }): boolean {
  const effective = (value: { candidates: ModelCandidate[]; modelTiers?: AgentModelTiers }) => {
    const { preset: _preset, ...tiers } = cleanAgentModelTiers(value.modelTiers ?? tiersFromCandidates(value.candidates));
    return JSON.stringify(tiers);
  };
  return effective(binding) === effective(declared);
}
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
export function isWorkerAccountTemporarilyUnavailable(error: unknown): boolean {
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

export class WorkerModelRoutingService extends WorkerModelSelection {
  constructor(private readonly catalogWait: WorkerCatalogWait = DEFAULT_CATALOG_WAIT) { super() }

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

  /** Single account/catalog check, shared by a live dispatch and its read-only preview. */
  async resolveRouteOnce(route: WorkerModelRoute, snapshot?: { providers: RoutingProviderInfo[]; settings: EditableRoutingState; account: (candidate: ModelCandidate) => Promise<Record<string, string>> }): Promise<ModelCandidate[]> {
    const [providers, settings] = snapshot ? [snapshot.providers, snapshot.settings] : await Promise.all([modelRouter.providerInfo(), modelRouter.getEditableState()]);
    const available = workerRouteCandidates(route, providers, settings.neverUse);
    const sameApprovedAccount: ModelCandidate[] = [];
    for (const candidate of available) {
      let current: Record<string, string>;
      try {
        current = await (snapshot ? snapshot.account(candidate) : this.subscriptionConnections([candidate]));
      } catch (error) {
        const outage = isWorkerAccountTemporarilyUnavailable(error);
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

  /** Validate visible pins (or a tier list's candidates, up to 10 x 10) before profile creation or a mapping write. */
  async validateSubscriptionCandidates(candidates: ModelCandidate[], max = 10): Promise<Record<string, string>> {
    if (!Array.isArray(candidates) || !candidates.length || candidates.length > max) throw new InfrastructureFailure(max === 10 ? 'Choose one to ten worker models.' : 'Choose one to ten tiers of one to ten models.');
    const providers = await modelRouter.providerInfo();
    for (const candidate of candidates) {
      if (!['codex', 'claude-code', 'grok'].includes(candidate.provider)) throw new InfrastructureFailure('Worker mappings support connected Claude Code, Codex, and Grok OAuth subscription models.');
      const provider = providers.find(row => row.id === candidate.provider);
      if (!provider?.connected) throw new InfrastructureFailure(`Connect ${ candidate.provider } before saving this worker model.`);
      const model = provider.models.find(row => row.id === candidate.model && !row.unverified);
      if (!model) throw new InfrastructureFailure(`Model ${ candidate.provider }/${ candidate.model } is not in the verified catalog. Choose an available version.`);
      if (candidate.effort !== undefined && !model.efforts?.some(level => level.id === candidate.effort)) throw new InfrastructureFailure(`Effort ${ candidate.effort } is not supported by ${ candidate.provider }/${ candidate.model }.`);
    }
    return this.subscriptionConnections(candidates);
  }

  /** Initialize one exact local definition mapping without replacing an existing owner's selection. */
  async initializeBindingForDefinition(slug: string, agentId: string, candidates: ModelCandidate[]): Promise<void> {
    const definition = await agentDefinitionService.findBySlug(slug);
    if (!definition || definition.id !== agentId || definition.source_kind !== 'local') throw new InfrastructureFailure('The local agent changed before its model could be activated.');
    await this.addBindingIfAbsent(slug, agentId, candidates, cleanAgentModelTiers(tiersFromCandidates(candidates)));
  }

  /** A new definition's creator needs the exact mapping receipt for conditional rollback. */
  async initializeNewBindingForDefinition(slug: string, agentId: string, candidates: ModelCandidate[], modelTiers?: AgentModelTiers): Promise<{ editToken: string; revision: number }> {
    const definition = await agentDefinitionService.findBySlug(slug);
    if (!definition || definition.id !== agentId || definition.source_kind !== 'local') throw new InfrastructureFailure('The local agent changed before its model could be activated.');
    const tiers = cleanAgentModelTiers(modelTiers ?? tiersFromCandidates(candidates));
    const written = await this.addBindingIfAbsent(slug, agentId, candidates, tiers);
    if (!written) throw new InfrastructureFailure('This agent already has a model mapping. Its existing mapping was preserved.');
    return written;
  }

  /** A local import can create a mapping or keep an existing exact match; it cannot replace an owner choice. */
  async registerImportedAgentBinding(
    slug: string,
    agentId: string,
    declared: { candidates: ModelCandidate[]; modelTiers?: AgentModelTiers },
    project?: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    const state = await modelRouter.getEditableState();
    const binding = state.workerBindings?.[slug];
    if (!project) {
      if (binding?.agentId === agentId && !binding.pendingPublication && sameEffectiveModels(binding, declared)) return;
      throw new InfrastructureFailure('The imported model settings differ from this agent’s saved selection. Use the agent’s Model settings to make that change, or import under another slug.');
    }
    if (binding) throw new InfrastructureFailure('An existing model mapping uses this slug. Choose a different slug to import.');
    const connections = await this.validateSubscriptionCandidates(declared.candidates, declared.modelTiers ? 100 : 10);
    await withWorkerBindingWrite(() => modelRouter.writeFilePublishedBinding(slug, agentId, null, {
      ...declared, editToken: randomUUID(), connections,
    }, { project, recheck: () => this.verifySubscriptionConnections(declared.candidates, connections) }));
  }

  private async verifySubscriptionConnections(candidates: ModelCandidate[], approved: Record<string, string>): Promise<void> {
    const current = await this.subscriptionConnections(candidates);
    if (Object.entries(approved).some(([provider, accountId]) => current[provider] !== accountId)) {
      throw new InfrastructureFailure('A subscription account changed while the model settings were checked. Retry after reviewing the connection.');
    }
  }

  /**
   * Reconcile an exact agent's mapping with one approved file publication (`declared` undefined: the
   * file uses shared routing). An unedited file-owned mapping follows the file; an owner edit,
   * including an explicit return to shared routing, wins and is reported as a conflict. The same
   * publication, or a file that matches, is a no-op. Writes compare-and-set the observed entry.
   */
  async reconcilePublishedPackageBinding(
    slug: string,
    agentId: string,
    declared: { candidates: ModelCandidate[]; modelTiers?: AgentModelTiers } | undefined,
    publication: { fileId: string; versionId: string },
    options: { pending?: boolean; verifyVersion?: () => Promise<void>; project?: (client: PoolClient) => Promise<void> } = {},
  ): Promise<PublishedBindingOutcome> {
    const state = await modelRouter.getEditableState();
    const existing = state.workerBindings?.[slug];
    if (existing && existing.agentId !== agentId) {
      if (!declared) return { outcome: 'unchanged' };
      throw new InfrastructureFailure('A different agent already owns this worker mapping; it was preserved.');
    }
    if (declared && existing && !reusableForPublication(existing, options.pending ? publication : undefined)) throw new InfrastructureFailure(STALE_PUBLICATION_MAPPING);
    const fileOwned = fileOwnedBinding(existing, agentId);
    if (!existing && !declared) return { outcome: 'unchanged' };
    const sameVersion = existing?.filePublication?.fileId === publication.fileId && existing.filePublication.versionId === publication.versionId;
    if (existing && declared && (fileOwned ? sameVersion && sameStoredModels(existing, declared) : sameEffectiveModels(existing, declared))) return { outcome: 'unchanged' };
    if (!fileOwned) {
      if (existing && !declared && !existing.filePublication) return { outcome: 'unchanged' };
      const owner = existing
        ? `the owner's model mapping (${ existing.candidates.map(formatModelCandidate).join(', ') }) was kept`
        : state.workerInheritance?.[slug]?.agentId === agentId ? 'the owner chose shared model routing, which was kept' : undefined;
      if (owner) {
        const file = declared ? declared.candidates.map(formatModelCandidate).join(', ') : 'shared model routing';
        return { outcome: 'conflict', message: `This file version declares ${ file }, but ${ owner }. Update the agent’s Model settings or the file to reconcile them.` };
      }
    }
    let next: Parameters<typeof modelRouter.writeFilePublishedBinding>[3] = null;
    if (declared) {
      // A revision that keeps the same representation only updates provenance; reuse its account approvals.
      const sameModels = existing && sameStoredModels(existing, declared) && existing.connections;
      const connections = sameModels || await this.validateSubscriptionCandidates(declared.candidates, declared.modelTiers ? 100 : 10);
      for (const [provider, accountId] of Object.entries(connections)) {
        const approved = existing?.connections?.[provider];
        if (approved && approved !== accountId) throw new InfrastructureFailure(`The approved ${ provider } subscription account changed. Review the mapping in AI Models before publishing again.`);
      }
      next = { editToken: randomUUID(), connections, candidates: declared.candidates, ...(declared.modelTiers ? { modelTiers: declared.modelTiers } : {}), filePublication: { ...publication }, ...(options.pending ? { pendingPublication: { ...publication } } : {}) };
    }
    const expected = existing ? { editToken: existing.editToken, revision: existing.revision } : null;
    try {
      const recheck = async() => {
        if (declared && next && !(existing && sameStoredModels(existing, declared) && existing.connections)) {
          await this.verifySubscriptionConnections(declared.candidates, next.connections);
        }
        await options.verifyVersion?.();
      };
      const written = await withWorkerBindingWrite(() => modelRouter.writeFilePublishedBinding(slug, agentId, expected, next, { recheck, project: options.project }));
      return { outcome: 'written', written };
    } catch (error) {
      throw new InfrastructureFailure(error instanceof Error ? error.message : 'Worker model mapping could not be saved safely.', error);
    }
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
  private async addBindingIfAbsent(slug: string, agentId: string, candidates: ModelCandidate[], modelTiers?: AgentModelTiers): Promise<{ editToken: string; revision: number } | undefined> {
    const current = await modelRouter.getEditableState();
    const existing = current.workerBindings?.[slug];
    if (existing) {
      if (existing.agentId !== agentId) throw new InfrastructureFailure('A different agent already owns this worker mapping; it was preserved.');
      if (!reusableForPublication(existing)) throw new InfrastructureFailure(STALE_PUBLICATION_MAPPING);
      return undefined;
    }
    const connections = await this.validateSubscriptionCandidates(candidates, modelTiers ? 100 : 10);
    const binding = { editToken: randomUUID(), agentId, revision: 1, connections, ...(modelTiers ? { modelTiers } : {}), candidates: candidates.map(row => ({ ...row })) };
    try {
      return await withWorkerBindingWrite(() => modelRouter.addWorkerBindingIfAbsent(slug, binding)) ? { editToken: binding.editToken, revision: binding.revision } : undefined;
    } catch (error) {
      throw new InfrastructureFailure(error instanceof Error ? error.message : 'Worker model mapping could not be saved safely.', error);
    }
  }

  /** Roll back only the mapping created for this exact definition. */
  async removeBindingForDefinition(slug: string, agentId: string, created?: { editToken: string; revision: number }): Promise<boolean> {
    return withWorkerBindingWrite(() => modelRouter.removeWorkerBindingIfOwned(slug, agentId, created));
  }

  /** Called only at a new job/new unpinned human turn, never during recovery. */
  async newRoute(slug: string, request?: Partial<ModelCandidate>): Promise<WorkerModelRoute | undefined> {
    if (!slug) return undefined;
    const [definition, settings] = await Promise.all([agentDefinitionService.findBySlug(slug), modelRouter.getEditableState()]);
    if (!definition) return undefined;
    // An unsettled pending-migration mapping is neither run nor bypassed for another model; the
    // next Use Cases scan settles it, or the owner resolves it in AI Models.
    const own = settings.workerBindings?.[definition.slug];
    if (own?.pendingPublication && own.agentId === definition.id) throw new InfrastructureFailure('This agent\'s model mapping is still being registered from Use Cases; it will not run on another model until it settles.');
    const route = captureWorkerRoute(definition.slug, definition.id, settings.workerBindings ?? {});
    return route && this.orderNewRoute(route, request);
  }

  async orderNewRoute(route: WorkerModelRoute, request?: Partial<ModelCandidate>, previewProviders?: RoutingProviderInfo[]): Promise<WorkerModelRoute> {
    const slug = route.slug;
    if (route.modelTiers) {
      const providers = previewProviders ?? await modelRouter.providerInfo();
      const backoff = new Set(providers.filter(row => row.status === 'cooling' || row.status === 'error').map(row => row.id));
      let entries = orderTierEntries(route.modelTiers, backoff);
      if (request && (request.provider || request.model || request.effort)) {
        if (!request.model) throw new Error(slug + ' requires an exact model for a launch request.');
        const matching = new Set(entries.filter(row => row.candidate.model === request.model).map(row => row.candidate.provider));
        if (!request.provider && matching.size > 1) throw new Error('Choose the provider for this model.');
        const provider = request.provider || [...matching][0] || providerForModelId(request.model);
        if (!provider || !route.connections?.[provider]) throw new Error(slug + ' has no approved subscription for the requested provider.');
        const exact = exactTierRequest(slug, route.modelTiers, entries, { provider, model: request.model, ...(request.effort ? { effort: request.effort } : {}) });
        entries = [exact];
        route.requestedModel = { ...exact.candidate };
      }
      route.candidates = entries.map(entry => entry.candidate);
      route.candidateTiers = entries.map(entry => entry.tier);
      if (route.requestedModel) await this.resolveRoute(route);
    } else {
      route.candidates = await modelRouter.workerLaunchCandidates(route.candidates, Boolean(previewProviders));
    }
    return route;
  }

  /** A delegated request cannot displace the owner's chat-specific first choice or use its fallbacks implicitly. */
  async applyWorkflowRequest(route: WorkerModelRoute, request: Partial<ModelCandidate>): Promise<WorkerModelRoute> {
    if (!request.provider && !request.model && !request.effort) return route;
    const first = route.candidates[route.selected];
    if (!first || request.model !== first.model || (request.provider && request.provider !== first.provider) ||
        (request.effort && request.effort !== first.effort)) {
      throw new Error('The task model request conflicts with this chat’s AI Team selection' + (first ? ': ' + formatModelCandidate(first) : '') + '.');
    }
    const exact = { ...route, candidates: [first], selected: 0, requestedModel: { ...first } };
    await this.resolveRoute(exact);
    return exact;
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
  for (const key of ['delegatedJobId', 'inheritedResumeModel', 'savedInheritedModel', 'delegatedGeneration', 'productOwnerWorkflowStep', 'workerModelTask', 'workerModelRoute', 'delegatedTaskIndex', 'managerAgentId', 'managerThreadId', 'workflowParentChannel', 'parentWsChannel', 'activityKeys']) delete meta[key];
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
