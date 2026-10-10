import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import yaml from 'yaml';

import {
  AgentDefinitionModel,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentDefinitionPatch,
  type AgentDefinitionStatus,
} from '../database/models/AgentDefinitionModel';
import { resolveAllAgentsDirs } from '../utils/sullaPaths';

export const AGENT_MANIFEST_API_VERSION = 'sulla/v3';

export interface AgentMarketplaceManifest {
  apiVersion:      'sulla/v3';
  kind:            'Agent';
  manifestVersion: 1;
  metadata:        { slug: string; title: string; description: string; version: string; author?: string; marketplaceTemplateId?: string };
  spec: {
    provider?:   string;
    model?:      string;
    prompt:      string;
    soul?:       string;
    goals?:      string;
    tools:       string[];
    skills:      string[];
    config:      Record<string, unknown>;
    promptFiles: Record<string, string>;
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

/** Runtime-facing facade for database-backed agent definitions. */
export class AgentDefinitionService {
  get(id: string): Promise<AgentDefinition | null> { return AgentDefinitionModel.get(id) }
  findBySlug(slug: string): Promise<AgentDefinition | null> { return AgentDefinitionModel.findBySlug(slug) }
  list(status?: AgentDefinitionStatus): Promise<AgentDefinition[]> { return AgentDefinitionModel.list(status) }
  create(input: AgentDefinitionInput): Promise<AgentDefinition> { return AgentDefinitionModel.create(input) }
  async update(id: string, patch: AgentDefinitionPatch): Promise<AgentDefinition | null> {
    const current = await this.get(id);
    if (!current) return null;
    const promptFiles = patch.promptContent !== undefined && patch.promptFiles === undefined
      ? { ...current.prompt_files, 'prompt.md': patch.promptContent }
      : patch.promptFiles;
    // A user edit detaches a filesystem import so startup refresh never overwrites it.
    const sourceKind = patch.sourceKind ?? (current.source_kind === 'filesystem-import' ? 'local' : undefined);
    return AgentDefinitionModel.update(id, { ...patch, ...(promptFiles ? { promptFiles } : {}), ...(sourceKind ? { sourceKind } : {}) });
  }

  setStatus(id: string, status: AgentDefinitionStatus): Promise<AgentDefinition | null> { return AgentDefinitionModel.setStatus(id, status) }
  delete(id: string): Promise<boolean> { return AgentDefinitionModel.delete(id) }

  /**
   * Import legacy directories. Unedited filesystem imports refresh when their
   * files change (so shipped agent updates land); every other DB row wins.
   */
  async importLegacyDirectories(roots = resolveAllAgentsDirs()): Promise<{ imported: number; refreshed: number; skipped: number; errors: string[] }> {
    let imported = 0;
    let refreshed = 0;
    let skipped = 0;
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        seen.add(entry.name);
        const dir = path.join(root, entry.name);
        const configPath = path.join(dir, 'config.yaml');
        if (!fs.existsSync(configPath)) continue;
        try {
          const configText = fs.readFileSync(configPath, 'utf8');
          const config = yaml.parse(configText) ?? {};
          const promptFiles: Record<string, string> = {};
          for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
            if (file.isFile() && file.name.endsWith('.md') && file.name !== 'environment.md') {
              promptFiles[file.name] = fs.readFileSync(path.join(dir, file.name), 'utf8');
            }
          }
          const contentHash = createHash('sha256')
            .update(JSON.stringify([configText, Object.keys(promptFiles).sort().map(name => [name, promptFiles[name]])]))
            .digest('hex');
          const content = {
            name:          String(config.name || entry.name),
            description:   String(config.description || ''),
            systemPrompt:  promptFiles['prompt.md'] ?? '',
            promptContent: promptFiles['prompt.md'] ?? '',
            soulContent:   promptFiles['soul.md'] ?? '',
            goalsContent:  promptFiles['goals.md'] ?? '',
            promptFiles,
            allowedTools:  stringArray(config.tools),
            skillRefs:     stringArray(config.skills),
            routineRefs:   stringArray(config.routines),
            provider:      typeof config.provider === 'string' ? config.provider : null,
            model:         typeof config.model === 'string' ? config.model : null,
            config,
            contentHash,
          };
          const existing = await this.findBySlug(entry.name);
          if (!existing) {
            await AgentDefinitionModel.importIfMissing({ slug: entry.name, ...content, status: 'production', sourceKind: 'filesystem-import' });
            imported++;
          } else if (existing.source_kind === 'filesystem-import' && existing.content_hash !== contentHash) {
            await AgentDefinitionModel.update(existing.id, content);
            refreshed++;
          } else {
            skipped++;
          }
        } catch (error) {
          errors.push(`${ entry.name }: ${ error instanceof Error ? error.message : String(error) }`);
        }
      }
    }
    return { imported, refreshed, skipped, errors };
  }

  toManifest(agent: AgentDefinition): AgentMarketplaceManifest {
    return {
      apiVersion:      AGENT_MANIFEST_API_VERSION,
      kind:            'Agent',
      manifestVersion: 1,
      metadata:        {
        slug:        agent.slug,
        title:       agent.name,
        description: agent.description,
        version:     agent.marketplace_version ?? agent.version ?? '1.0.0',
        ...(agent.marketplace_author ? { author: agent.marketplace_author } : {}),
        ...(agent.marketplace_template_id ? { marketplaceTemplateId: agent.marketplace_template_id } : {}),
      },
      spec: {
        ...(agent.provider ? { provider: agent.provider } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        prompt:      agent.prompt_content,
        soul:        agent.soul_content,
        goals:       agent.goals_content,
        tools:       agent.allowed_tools,
        skills:      agent.skill_refs,
        config:      agent.config,
        promptFiles: agent.prompt_files,
      },
    };
  }

  async exportManifest(slug: string): Promise<AgentMarketplaceManifest> {
    const agent = await this.findBySlug(slug);
    if (!agent) throw new Error(`Agent not found: ${ slug }`);
    return this.toManifest(agent);
  }

  async importManifest(manifest: AgentMarketplaceManifest): Promise<AgentDefinition> {
    if (manifest.apiVersion !== AGENT_MANIFEST_API_VERSION || manifest.kind !== 'Agent' || manifest.manifestVersion !== 1) {
      throw new Error('Unsupported agent manifest. Expected sulla/v3 Agent manifestVersion 1.');
    }
    const { metadata, spec } = manifest;
    if (!metadata?.slug || !metadata?.title || !spec || typeof spec.prompt !== 'string') {
      throw new Error('Invalid agent manifest: metadata.slug, metadata.title, and spec.prompt are required.');
    }
    const existing = await this.findBySlug(metadata.slug);
    const input: AgentDefinitionInput = {
      slug:                  metadata.slug,
      name:                  metadata.title,
      description:           metadata.description ?? '',
      systemPrompt:          spec.prompt,
      promptContent:         spec.prompt,
      soulContent:           spec.soul ?? '',
      goalsContent:          spec.goals ?? '',
      promptFiles:           spec.promptFiles ?? {},
      allowedTools:          spec.tools ?? [],
      skillRefs:             spec.skills ?? [],
      provider:              spec.provider ?? null,
      model:                 spec.model ?? null,
      config:                spec.config ?? {},
      version:               metadata.version,
      status:                'production',
      sourceKind:            'marketplace',
      marketplaceTemplateId: metadata.marketplaceTemplateId ?? null,
      marketplaceSlug:       metadata.slug,
      marketplaceVersion:    metadata.version,
      marketplaceAuthor:     metadata.author ?? null,
    };
    if (!existing) return this.create(input);
    return (await this.update(existing.id, input))!;
  }
}

export const agentDefinitionService = new AgentDefinitionService();
