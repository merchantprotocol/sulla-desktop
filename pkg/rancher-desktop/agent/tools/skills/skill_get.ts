import { SkillDefinitionModel } from '../../database/models/SkillDefinitionModel';
import { materializeSkill, renderSkillMarkdown } from '../../services/SkillDefinitionService';
import { BaseTool, ToolResponse } from '../base';

export class SkillGetWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const slug = String(input.slug ?? '').trim();
    if (!slug) return { successBoolean: false, responseString: 'Missing required field: slug.' };

    const row = await SkillDefinitionModel.findBySlug(slug);
    if (!row) return { successBoolean: false, responseString: `Skill not found: ${ slug }. Use skill_list to see what exists.` };

    const state = row.deleted_at ? 'deleted' : row.enabled ? 'enabled' : 'disabled';
    const parts = [`skill ${ row.slug } (${ row.source_kind }, ${ state }, updated ${ row.updated_at })`];

    if (input.materialize === true) {
      if (row.deleted_at) return { successBoolean: false, responseString: `Skill ${ slug } is deleted. Restore it with skill_save first.` };
      parts.push(`Materialized to: ${ materializeSkill(row) }`);
    }

    const fileNames = Object.keys(row.files).sort();
    parts.push(fileNames.length ? `Files: ${ fileNames.join(', ') }` : 'Files: none');
    parts.push('', renderSkillMarkdown(row));

    if (input.include_files === true) {
      for (const name of fileNames) {
        const file = row.files[name];
        parts.push('', `--- file: ${ name } ---`, typeof file === 'string' ? file : `(binary, ${ Math.floor(String(file.content).length * 3 / 4) } bytes; use materialize:true to get it on disk)`);
      }
    }

    return { successBoolean: true, responseString: parts.join('\n') };
  }
}
