import { SkillDefinitionModel } from '../../database/models/SkillDefinitionModel';
import { skillsRegistry } from '../../database/registry/SkillsRegistry';
import { BaseTool, ToolResponse } from '../base';

export class SkillDisableWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const slug = String(input.slug ?? '').trim();
    const action = String(input.action ?? 'disable').trim().toLowerCase();
    if (!slug) return { successBoolean: false, responseString: 'Missing required field: slug.' };
    if (!['disable', 'enable', 'delete'].includes(action)) {
      return { successBoolean: false, responseString: `Invalid action "${ action }". Use disable, enable, or delete.` };
    }

    const row = await SkillDefinitionModel.findBySlug(slug);
    if (!row) return { successBoolean: false, responseString: `Skill not found: ${ slug }` };

    const patch = action === 'delete' ? { deleted: true } : action === 'enable' ? { enabled: true, deleted: false } : { enabled: false };
    await SkillDefinitionModel.update(row.id, patch);
    await skillsRegistry.invalidate();

    const done = action === 'delete' ? 'soft-deleted (restore with skill_save)' : action === 'enable' ? 'enabled' : 'disabled';
    return { successBoolean: true, responseString: `Skill ${ slug } ${ done }.` };
  }
}
