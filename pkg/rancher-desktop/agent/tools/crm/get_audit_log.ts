import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail } from './_shared';
import type { AuditEntityType } from '../../services/CrmSchemaService';

const ENTITY_TYPES = new Set<string>([
  'record_type', 'field', 'relationship', 'view', 'dashboard', 'widget', 'record', 'link',
]);

export class CrmGetAuditLogWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const entityType = input?.entity_type;
      if (entityType && !ENTITY_TYPES.has(entityType)) {
        return fail(`entity_type must be one of: ${ [...ENTITY_TYPES].join('|') }.`);
      }
      const limit = typeof input?.limit === 'number' ? Math.min(100, input.limit) : 20;
      const rows = await CrmSchemaService.getAuditLog({
        entityId: input?.entity_id,
        entityType: entityType as AuditEntityType | undefined,
        limit,
      });
      if (!rows.length) {
        return { successBoolean: true, responseString: 'No audit entries found.' };
      }
      const lines = rows.map((r: any) => {
        const undone = r.undone ? ' [undone]' : '';
        return `  ${ r.created_at } | ${ r.op } | ${ r.entity_type }:${ r.entity_id ?? '—' }${ undone } | undo:${ r.undo_token }`;
      });
      return {
        successBoolean: true,
        responseString: `${ rows.length } audit entry/entries (newest first):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return fail(`crm/get_audit_log failed: ${ (err as Error).message }`);
    }
  }
}
