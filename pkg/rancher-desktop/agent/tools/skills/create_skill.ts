import { BaseTool, ToolResponse } from '../base';
import { skillsRegistry } from '../../database/registry/SkillsRegistry';

/**
 * Create Skill Tool - Create or update a skill folder + SKILL.md.
 */
export class CreateSkillWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { skill_name, content } = input;
    const result = await skillsRegistry.createSkill(skill_name, content);
    return {
      successBoolean: !result.startsWith('Failed'),
      responseString: result,
    };
  }
}
