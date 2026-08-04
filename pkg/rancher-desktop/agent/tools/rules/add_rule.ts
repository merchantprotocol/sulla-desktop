import { RulesModel } from '../../database/models/RulesModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Add Rule Tool
 *
 * Inserts or updates a user-created rule in the `sulla_rules` table — the
 * rules the human wants the Security Conscience to enforce ("always confirm
 * before touching prod", "never deploy on Fridays"). If an id is provided
 * that exact row is updated in place; otherwise de-duplication updates a
 * substantially similar active rule rather than creating a near-duplicate.
 *
 * Rules are never hard-deleted — use archive_rule to retire one.
 */
export class AddRuleWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { id, title, content, category, severity, scope, source } = input;
    const enabled = input.enabled === undefined ? undefined : Boolean(input.enabled);
    const existingId = typeof id === 'string' ? id.trim() : '';

    if (!existingId && (!content || typeof content !== 'string' || !content.trim())) {
      return { successBoolean: false, responseString: 'content is required to add a new rule.' };
    }

    try {
      await RulesModel.ensureTable();

      if (existingId) {
        const updated = await RulesModel.update(existingId, { title, content, category, severity, scope, source, enabled });
        if (!updated) {
          return { successBoolean: false, responseString: `No rule found with id: ${ existingId }` };
        }
        return {
          successBoolean: true,
          responseString: `Rule updated: "${ updated.title }" (id: ${ updated.id }, severity: ${ updated.severity }, category: ${ updated.category })`,
        };
      }

      // De-dupe against existing active rules before inserting.
      const duplicate = await RulesModel.findDuplicate(title || '', content);
      if (duplicate) {
        const updated = await RulesModel.update(duplicate.id, { title, content, category, severity, scope, source, enabled });
        return {
          successBoolean: true,
          responseString: `Rule updated (matched existing): "${ (updated ?? duplicate).title }" (id: ${ duplicate.id })`,
        };
      }

      const record = await RulesModel.insert({
        title:    title || content.slice(0, 60),
        content,
        category,
        severity,
        scope,
        enabled,
        source:   source || 'user',
      });
      return {
        successBoolean: true,
        responseString: `Rule added: "${ record.title }" (id: ${ record.id }, severity: ${ record.severity }, category: ${ record.category })`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Failed to save rule: ${ err?.message }`,
      };
    }
  }
}
