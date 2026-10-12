import { skillsRegistry } from '../../database/registry/SkillsRegistry';
import { saveSkillFromMarkdown } from '../../services/SkillDefinitionService';
import { BaseTool, ToolResponse } from '../base';

import type { SkillFile } from '../../database/models/SkillDefinitionModel';

export class SkillSaveWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const markdown = String(input.markdown ?? '');
    if (!markdown.trim()) return { successBoolean: false, responseString: 'Missing required field: markdown (the full SKILL.md text).' };

    let files: Record<string, SkillFile> | undefined;
    if (input.files !== undefined) {
      if (!input.files || typeof input.files !== 'object' || Array.isArray(input.files)) {
        return { successBoolean: false, responseString: 'files must be an object of relative path -> text content.' };
      }
      files = {};
      for (const [rel, content] of Object.entries(input.files)) {
        const safe = String(rel).replace(/\\/g, '/');
        if (!safe || safe.startsWith('/') || safe.split('/').some(part => part === '..' || part === '') || safe === 'SKILL.md') {
          return { successBoolean: false, responseString: `Invalid file path: ${ rel }` };
        }
        files[safe] = String(content ?? '');
      }
    }

    try {
      const slug = typeof input.slug === 'string' && input.slug.trim() ? input.slug.trim() : undefined;
      const { skill, created } = await saveSkillFromMarkdown({ markdown, slug, files });
      await skillsRegistry.invalidate();
      return { successBoolean: true, responseString: `${ created ? 'Created' : 'Updated' } skill ${ skill.slug } (${ skill.source_kind }) in the database.` };
    } catch (error) {
      return { successBoolean: false, responseString: `Could not save skill: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
