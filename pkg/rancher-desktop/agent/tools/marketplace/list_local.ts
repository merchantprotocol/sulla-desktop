import * as fs from 'fs';
import * as path from 'path';

import {
  FunctionDefinitionModel,
  IntegrationDefinitionModel,
  RecipeDefinitionModel,
} from '../../database/models/MarketplaceArtifactModel';
import { WorkflowModel } from '../../database/models/WorkflowModel';
import { BaseTool, ToolResponse } from '../base';
import { ARTIFACT_KINDS, ArtifactKind, isArtifactKind, KIND_LAYOUTS, normalizeKind } from './types';

/**
 * Enumerate locally-installed artifacts. Filterable by kind.
 */
export class MarketplaceListLocalWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kindRaw = typeof input.kind === 'string' && input.kind.trim() ? (normalizeKind(input.kind) ?? input.kind.trim().toLowerCase()) : '';
    const kinds: readonly ArtifactKind[] = kindRaw
      ? (isArtifactKind(kindRaw) ? [kindRaw] : [])
      : ARTIFACT_KINDS;

    if (kinds.length === 0) {
      return { successBoolean: false, responseString: `Invalid kind "${ kindRaw }". Must be one of: ${ ARTIFACT_KINDS.join(', ') }.` };
    }

    const blocks: string[] = [];
    let total = 0;

    for (const kind of kinds) {
      if (kind === 'agent') {
        const { agentDefinitionService } = await import('../../services/AgentDefinitionService');
        const agents = (await agentDefinitionService.list()).filter(agent => agent.status !== 'archive');
        total += agents.length;
        blocks.push(agents.length === 0
          ? '### agent (0)\n  Database — empty'
          : `### agent (${ agents.length })\n  Database\n${ agents.map(agent => `  - ${ agent.slug } (${ agent.source_kind })`).join('\n') }`);
        continue;
      }
      if (kind === 'skill') {
        const { SkillDefinitionModel } = await import('../../database/models/SkillDefinitionModel');
        const skills = await SkillDefinitionModel.list({ includeDisabled: true });
        total += skills.length;
        blocks.push(skills.length === 0
          ? '### skill (0)\n  Database — empty'
          : `### skill (${ skills.length })\n  Database\n${ skills.map(skill => `  - ${ skill.slug } (${ skill.source_kind }${ skill.enabled ? '' : ', disabled' })`).join('\n') }`);
        continue;
      }
      const databaseSlugs = new Set<string>();
      if (kind === 'function') {
        for (const artifact of await FunctionDefinitionModel.list()) databaseSlugs.add(artifact.slug);
      } else if (kind === 'integration') {
        for (const artifact of await IntegrationDefinitionModel.list()) databaseSlugs.add(artifact.slug);
      } else if (kind === 'recipe') {
        for (const artifact of await RecipeDefinitionModel.list()) databaseSlugs.add(artifact.slug);
      } else if (kind === 'workflow') {
        for (const workflow of await WorkflowModel.listAll()) databaseSlugs.add(workflow.id);
      }

      const layout = KIND_LAYOUTS[kind];
      const root = layout.rootDir();
      const items: { slug: string; manifestExists: boolean }[] = [];

      try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const manifestExists = fs.existsSync(path.join(root, entry.name, layout.manifest));
          if (!databaseSlugs.has(entry.name)) items.push({ slug: entry.name, manifestExists });
        }
      } catch {
        // Dir doesn't exist or unreadable — show as empty.
      }

      total += databaseSlugs.size + items.length;
      if (databaseSlugs.size === 0 && items.length === 0) {
        blocks.push(`### ${ kind } (0)\n  Database and ${ root } — empty`);
      } else {
        const lines = [
          ...[...databaseSlugs].sort().map(slug => `  - ${ slug } (database)`),
          ...items.map(i => `  - ${ i.slug } (legacy file)${ i.manifestExists ? '' : ' ⚠️ (missing manifest)' }`),
        ];
        blocks.push(`### ${ kind } (${ lines.length })\n${ lines.join('\n') }`);
      }
    }

    return {
      successBoolean: true,
      responseString: `Locally installed artifacts (${ total } total):\n\n${ blocks.join('\n\n') }`,
    };
  }
}
