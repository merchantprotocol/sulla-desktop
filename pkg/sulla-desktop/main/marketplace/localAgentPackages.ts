// SPDX-License-Identifier: GPL-2.0-or-later
import { randomUUID } from 'node:crypto';

import { agentDefinitionService, type AgentMarketplaceManifest } from '@pkg/agent/services/AgentDefinitionService';
import { modelRouter } from '@pkg/agent/languagemodels/modelRouter';
import { workerModelRouting } from '@pkg/agent/services/WorkerModelRouting';
import { RedisUseCaseChangePublisherFactory } from '@pkg/agent/useCases/RedisUseCaseChangePublisherFactory';

import { agentPackageModels, withAgentPackageModels } from './agentPackageManifest';

const MAX_AGENT_IMPORT_BYTES = 1024 * 1024;

export class LocalAgentPackageService {
  static async exportLocalAgentPackage(slug: string): Promise<AgentMarketplaceManifest> {
    const agent = await agentDefinitionService.findBySlug(slug);
    if (!agent) throw new Error(`Agent not found: ${ slug }`);
    const manifest = agentDefinitionService.toManifest(agent);
    const binding = (await modelRouter.getEditableState()).workerBindings?.[agent.slug];
    if (binding?.agentId !== agent.id || binding.pendingPublication) return manifest;
    return withAgentPackageModels(manifest, binding) as AgentMarketplaceManifest;
  }

  static async importLocalAgentPackage(manifest: AgentMarketplaceManifest) {
    if (!manifest || Buffer.byteLength(JSON.stringify(manifest)) > MAX_AGENT_IMPORT_BYTES) throw new Error('Choose an agent package of 1 MiB or less.');
    if (manifest.apiVersion !== 'sulla/v3' || manifest.kind !== 'Agent' || manifest.manifestVersion !== 1 ||
        typeof manifest.metadata?.slug !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(manifest.metadata.slug) ||
        typeof manifest.metadata.title !== 'string' || !manifest.metadata.title.trim() || typeof manifest.spec?.prompt !== 'string') {
      throw new Error('Choose a valid sulla/v3 Agent manifest with a slug, title and prompt.');
    }
    const { slug } = manifest.metadata;
    const spec = manifest.spec;
    // An older profile-only export may carry a single provider or model hint.
    const hasProvider = typeof spec.provider === 'string' && !!spec.provider.trim();
    const hasModel = typeof spec.model === 'string' && !!spec.model.trim();
    const hasLegacyHint = spec.models === undefined && spec.modelChoice?.mode !== 'pin' && hasProvider !== hasModel;
    const declared = hasLegacyHint ? undefined : agentPackageModels(manifest);
    const existing = await agentDefinitionService.findBySlug(slug);
    if (existing && existing.slug !== slug) throw new Error(`This slug is a compatibility alias for "${ existing.slug }". Use the current slug or choose a new one.`);
    if (existing?.status === 'archive') throw new Error('An archived agent already has this slug. Choose another slug to import.');
    if (!declared) return agentDefinitionService.importManifest(manifest, { existing });
    // The compatibility pin is an export field. The explicit worker binding owns model execution.
    const category = spec.config?.modelChoice as AgentMarketplaceManifest['spec']['modelChoice'];
    const profile = category?.mode === 'class' ? { ...manifest, spec: { ...spec, modelChoice: category } } : manifest;
    if (existing) {
      await workerModelRouting.registerImportedAgentBinding(slug, existing.id, declared);
      return agentDefinitionService.importManifest(profile, { existing });
    }

    const id = `agent-${ randomUUID() }`;
    let imported: Awaited<ReturnType<typeof agentDefinitionService.importManifest>> | undefined;
    await workerModelRouting.registerImportedAgentBinding(slug, id, declared, async client => {
      imported = await agentDefinitionService.importManifest(profile, { existing: null, transaction: { client, id } });
    });
    if (!imported) throw new Error('The agent package could not be imported.');
    new RedisUseCaseChangePublisherFactory().create().announce({ type: 'agent', slug, change: 'updated' });
    return imported;
  }
}

export const exportLocalAgentPackage = LocalAgentPackageService.exportLocalAgentPackage;
export const importLocalAgentPackage = LocalAgentPackageService.importLocalAgentPackage;
