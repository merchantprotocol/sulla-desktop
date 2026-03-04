import { BaseTool, ToolResponse } from '../base';
import { skillsRegistry } from '../../database/registry/SkillsRegistry';

/**
 * Load Skill Tool - Load the full detailed instructions for a skill.
 * Resolves from native (built-in), database, or filesystem sources.
 */
export class LoadSkillWorker extends BaseTool {
  name: string = '';
  description: string = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { skill_name } = input;
    const result = await skillsRegistry.loadSkill(skill_name);
    return {
      successBoolean: true,
      responseString: result,
    };
  }
}
