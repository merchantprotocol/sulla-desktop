import { ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import type { OpResult, FieldInput, DataType } from '../../services/CrmSchemaService';

/**
 * Shared helpers for the `crm/` tool category. Plain functions only — this
 * module intentionally exports NO worker class, so the registry's loader
 * resolver never mistakes it for a tool.
 */

export function ok(responseString: string): ToolResponse {
  return { successBoolean: true, responseString };
}

export function fail(responseString: string): ToolResponse {
  return { successBoolean: false, responseString };
}

/** OpResult → ToolResponse, surfacing the new id and any undo token. */
export function fromOp(r: OpResult, success: string): ToolResponse {
  if (!r.ok) return fail(r.error || 'operation failed');
  const id = r.id ? ` (id:${ r.id })` : '';
  const undo = r.undoToken ? ` [undo:${ r.undoToken }]` : '';
  return ok(`${ success }${ id }${ undo }`);
}

/**
 * Accept a record-type key ("contact") OR a raw id; return the id.
 * Lets the AI pass the human-friendly key without a lookup round-trip;
 * falls back to treating the input as an id if no key matches.
 */
export async function resolveRecordTypeId(keyOrId: string): Promise<string> {
  const byKey = await CrmSchemaService.getRecordTypeByKey(keyOrId);
  return byKey?.id ?? keyOrId;
}

/** Map a snake_case field spec from tool input to the service FieldInput. */
export function toFieldInput(f: any): FieldInput {
  return {
    key:        String(f.key),
    label:      String(f.label ?? f.key),
    dataType:   (f.data_type ?? f.dataType ?? 'text') as DataType,
    config:     f.config,
    isRequired: f.is_required ?? f.isRequired,
    isUnique:   f.is_unique ?? f.isUnique,
    isTitle:    f.is_title ?? f.isTitle,
    position:   f.position,
  };
}
