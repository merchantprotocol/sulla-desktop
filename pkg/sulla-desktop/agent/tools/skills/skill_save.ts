// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { parseSkillMarkdown } from '../../services/SkillDefinitionService';
import { FilesTool, writeUseCaseDraft } from '../files/common';
import { draftResponse } from '../useCaseDraft';
import type { ToolResponse } from '../base';

export class SkillSaveWorker extends FilesTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const markdown = String(input.markdown ?? '');
    if (!markdown.trim()) return { successBoolean: false, responseString: 'Missing required field: markdown (the full SKILL.md text).' };
    const parsed = parseSkillMarkdown(markdown, typeof input.slug === 'string' ? input.slug.trim() : '');
    if (!parsed) return { successBoolean: false, responseString: 'Invalid SKILL.md: expected valid YAML frontmatter with a skill slug.' };
    if (input.slug && String(input.slug).trim() !== parsed.slug) return { successBoolean: false, responseString: `slug must match SKILL.md frontmatter (${ parsed.slug }).` };

    const files: Record<string, string> = { 'SKILL.md': markdown };
    if (input.files !== undefined) {
      if (!input.files || typeof input.files !== 'object' || Array.isArray(input.files)) return { successBoolean: false, responseString: 'files must be an object of relative path -> text content.' };
      for (const [rel, content] of Object.entries(input.files)) {
        const safe = String(rel).replace(/\\/g, '/');
        if (!safe || safe.startsWith('/') || safe.split('/').some(part => part === '..' || part === '') || safe === 'SKILL.md') return { successBoolean: false, responseString: `Invalid file path: ${ rel }` };
        files[safe] = String(content ?? '');
      }
    }
    try {
      const written = await writeUseCaseDraft(this, input, 'skills', parsed.slug, files);
      return draftResponse('skills', parsed.slug, files, written);
    } catch (error) {
      return { successBoolean: false, responseString: `Could not save skill draft: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
