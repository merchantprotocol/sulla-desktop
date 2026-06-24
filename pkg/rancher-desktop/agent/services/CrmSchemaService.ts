/**
 * CrmSchemaService — the guarded Schema API for the dynamic CRM.
 *
 * This is the keystone of the dynamic-CRM vision: the AI/Heartbeat reshapes
 * the CRM by calling these validated, tenant-scoped operations — it NEVER
 * emits DDL or raw SQL. "New tables" are new `crm_record_types` rows; "new
 * columns" are `crm_fields` rows; the generic, metadata-driven UI renders
 * whatever exists. Backed by migrations 0029–0035.
 *
 * Two op families:
 *   • Schema ops  — mutate the definition (types/fields/relationships/views/
 *                   dashboards/widgets/menu). Higher blast radius → stronger
 *                   guards (is_system protection, slug validation, confirm
 *                   flag on destructive ops).
 *   • Data ops    — mutate records (create/update/link). High frequency,
 *                   lightweight. Value coercion routes each value to the
 *                   typed `value_*` column for its field's data_type.
 *
 * Design: projects/sulla-crm-dynamic-architecture/02-SCHEMA-API.md
 *
 * NOTE (audit/undo): doc 02 assumed a generic `audit_history` table exists
 * from migration 0027 — it does NOT (0027 created applescript_audit /
 * notifications / function_runs only). Audit + undo therefore need their own
 * table in a follow-up migration; this service leaves clearly-marked hooks
 * (recordAudit) rather than logging against a non-existent table.
 */

import * as crypto from 'crypto';

import { postgresClient } from '../database/PostgresClient';

import type { PoolClient } from 'pg';

// ── Constants & types ──────────────────────────────────────────────────

/** Single-user desktop tenant. Maps to a Sulla workspace under Cloud. */
export const DEFAULT_TENANT_ID = 'default';

export const DATA_TYPES = [
  'text', 'long_text', 'number', 'currency', 'date', 'datetime', 'bool',
  'select', 'multi_select', 'relation', 'email', 'phone', 'url', 'json', 'computed',
] as const;
export type DataType = typeof DATA_TYPES[number];

export const CARDINALITIES = ['one_to_one', 'one_to_many', 'many_to_many'] as const;
export type Cardinality = typeof CARDINALITIES[number];

export const VIEW_KINDS = ['table', 'kanban', 'calendar', 'list', 'gallery'] as const;
export type ViewKind = typeof VIEW_KINDS[number];

export const WIDGET_KINDS = ['stat', 'line', 'bar', 'funnel', 'list', 'table'] as const;
export type WidgetKind = typeof WIDGET_KINDS[number];

/** Static core columns on crm_records that filter/sort may reference directly. */
const CORE_COLUMNS = new Set(['id', 'title', 'created_at', 'updated_at']);

export type FilterOp = 'eq' | 'ne' | 'in' | 'notIn' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isSet';
/** A scalar is shorthand for equality; an object is one or more operators. */
export type FilterCond = string | number | boolean | null | Partial<Record<FilterOp, unknown>>;
export type Filter = Record<string, FilterCond>;
export interface SortSpec { field: string; dir?: 'asc' | 'desc' }

export interface OpResult {
  ok:    boolean;
  id?:   string;
  error?: string;
  /** Token to pass to undo() to revert this op. Present on successful mutations. */
  undoToken?: string;
}

export type AuditEntityType =
  'record_type' | 'field' | 'relationship' | 'view' | 'dashboard' | 'widget' | 'record' | 'link';

/** entity_type → its backing table. Used by undo() to revert generically. */
const ENTITY_TABLE: Record<AuditEntityType, string> = {
  record_type:  'crm_record_types',
  field:        'crm_fields',
  relationship: 'crm_relationships',
  view:         'crm_views',
  dashboard:    'crm_dashboards',
  widget:       'crm_widgets',
  record:       'crm_records',
  link:         'crm_record_links',
};

/** Minimal executor both a PoolClient (in a tx) and postgresClient satisfy. */
interface SqlExecutor {
  query: (text: string, params?: any[]) => Promise<any>;
}

export interface FieldInput {
  key:        string;
  label:      string;
  dataType:   DataType;
  config?:    Record<string, unknown>;
  isRequired?: boolean;
  isUnique?:  boolean;
  isTitle?:   boolean;
  isSystem?:  boolean;
  position?:  number;
}

export interface CreateRecordTypeInput {
  key:          string;
  label:        string;
  labelPlural:  string;
  icon?:        string;
  color?:       string;
  description?: string;
  isSystem?:    boolean;
  fields?:      FieldInput[];
  /** auto-create a default table View (default true) */
  seedDefaultView?: boolean;
  /** auto-create a left-nav entry (default true) */
  addMenuItem?: boolean;
}

export interface DefineRelationshipInput {
  key:         string;
  fromTypeId:  string;
  toTypeId:    string;
  cardinality: Cardinality;
  fromLabel?:  string;
  toLabel?:    string;
  isSystem?:   boolean;
}

interface FieldRow {
  id: string; key: string; data_type: DataType; is_title: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const VALID_KEY = /^[a-z][a-z0-9_]*$/;

function newId(): string {
  return crypto.randomUUID();
}

function validateKey(key: string): string | null {
  if (!key || !VALID_KEY.test(key)) {
    return `Invalid key "${ key }": must be lower_snake_case, starting with a letter`;
  }
  return null;
}

/** Map a field's data_type to the crm_field_values column that holds its value. */
function valueColumnFor(dataType: DataType): 'value_text' | 'value_number' | 'value_bool' | 'value_datetime' | 'value_json' | null {
  switch (dataType) {
  case 'text': case 'long_text': case 'email': case 'phone': case 'url': case 'select':
    return 'value_text';
  case 'number': case 'currency':
    return 'value_number';
  case 'bool':
    return 'value_bool';
  case 'date': case 'datetime':
    return 'value_datetime';
  case 'multi_select': case 'json':
    return 'value_json';
  case 'relation':            // relations are stored as crm_record_links, not field values
  case 'computed':            // computed/formula fields are derived at read time, not stored
    return null;
  default:
    return null;
  }
}

// ── Service ────────────────────────────────────────────────────────────────

export class CrmSchemaService {
  // ════════════════════════════════════════════════
  //  SCHEMA OPS
  // ════════════════════════════════════════════════

  /**
   * Create a new record type, optionally with initial fields, a default
   * table view, and a left-nav menu item — all in one transaction.
   */
  static async createRecordType(input: CreateRecordTypeInput, tenantId = DEFAULT_TENANT_ID): Promise<OpResult> {
    const keyErr = validateKey(input.key);
    if (keyErr) return { ok: false, error: keyErr };

    for (const f of input.fields ?? []) {
      const fkErr = validateKey(f.key);
      if (fkErr) return { ok: false, error: `field "${ f.label }": ${ fkErr }` };
      if (!DATA_TYPES.includes(f.dataType)) {
        return { ok: false, error: `field "${ f.key }": unknown dataType "${ f.dataType }"` };
      }
    }

    try {
      const result = await postgresClient.transaction(async (tx) => {
        const typeId = newId();
        await tx.query(
          `INSERT INTO crm_record_types
             (id, tenant_id, key, label, label_plural, icon, color, description, is_system)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [typeId, tenantId, input.key, input.label, input.labelPlural,
            input.icon ?? null, input.color ?? null, input.description ?? null, input.isSystem ?? false],
        );

        let position = 0;
        for (const f of input.fields ?? []) {
          await CrmSchemaService.insertField(tx, tenantId, typeId, f, position++);
        }

        if (input.seedDefaultView !== false) {
          await tx.query(
            `INSERT INTO crm_views (id, tenant_id, record_type_id, name, kind, config, is_system)
             VALUES ($1,$2,$3,$4,'table','{}'::jsonb,$5)`,
            [newId(), tenantId, typeId, `All ${ input.labelPlural }`, input.isSystem ?? false],
          );
        }

        if (input.addMenuItem !== false) {
          await tx.query(
            `INSERT INTO crm_menu_items
               (id, tenant_id, label, icon, target_type, target_id, auto_created, is_system)
             VALUES ($1,$2,$3,$4,'record_type',$5,true,$6)`,
            [newId(), tenantId, input.labelPlural, input.icon ?? null, typeId, input.isSystem ?? false],
          );
        }

        const undoToken = await CrmSchemaService.writeAudit(tx, {
          op: 'createRecordType', entityType: 'record_type', entityId: typeId,
          after: { key: input.key, label: input.label }, tenantId,
        });
        return { typeId, undoToken };
      });

      return { ok: true, id: result.typeId, undoToken: result.undoToken };
    } catch (err: any) {
      if (err?.code === '23505') return { ok: false, error: `record type key "${ input.key }" already exists` };
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Add a single field to an existing record type. */
  static async addField(recordTypeId: string, input: FieldInput, tenantId = DEFAULT_TENANT_ID): Promise<OpResult> {
    const keyErr = validateKey(input.key);
    if (keyErr) return { ok: false, error: keyErr };
    if (!DATA_TYPES.includes(input.dataType)) {
      return { ok: false, error: `unknown dataType "${ input.dataType }"` };
    }
    try {
      const result = await postgresClient.transaction(async (tx) => {
        const posRows = await tx.query(
          `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM crm_fields WHERE record_type_id = $1`,
          [recordTypeId],
        );
        const position = input.position ?? posRows.rows[0]?.next ?? 0;
        const fieldId = await CrmSchemaService.insertField(tx, tenantId, recordTypeId, input, position);
        const undoToken = await CrmSchemaService.writeAudit(tx, {
          op: 'addField', entityType: 'field', entityId: fieldId,
          after: { key: input.key, recordTypeId, dataType: input.dataType }, tenantId,
        });
        return { fieldId, undoToken };
      });
      return { ok: true, id: result.fieldId, undoToken: result.undoToken };
    } catch (err: any) {
      if (err?.code === '23505') return { ok: false, error: `field key "${ input.key }" already exists on this type` };
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Define a typed relationship between two record types. */
  static async defineRelationship(input: DefineRelationshipInput, tenantId = DEFAULT_TENANT_ID): Promise<OpResult> {
    const keyErr = validateKey(input.key);
    if (keyErr) return { ok: false, error: keyErr };
    if (!CARDINALITIES.includes(input.cardinality)) {
      return { ok: false, error: `unknown cardinality "${ input.cardinality }"` };
    }
    try {
      const id = newId();
      await postgresClient.query(
        `INSERT INTO crm_relationships
           (id, tenant_id, from_type_id, to_type_id, cardinality, from_label, to_label, key, is_system)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, tenantId, input.fromTypeId, input.toTypeId, input.cardinality,
          input.fromLabel ?? null, input.toLabel ?? null, input.key, input.isSystem ?? false],
      );
      const undoToken = await CrmSchemaService.writeAudit(postgresClient, {
        op: 'defineRelationship', entityType: 'relationship', entityId: id,
        after: { key: input.key, cardinality: input.cardinality }, tenantId,
      });
      return { ok: true, id, undoToken };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Archive (soft-delete) a record type. Refuses on is_system unless forced. */
  static async archiveRecordType(id: string, opts: { confirm: boolean } = { confirm: false }): Promise<OpResult> {
    if (!opts.confirm) return { ok: false, error: 'archiveRecordType requires { confirm: true }' };
    const rows = await postgresClient.query(`SELECT is_system FROM crm_record_types WHERE id = $1`, [id]);
    if (!rows[0]) return { ok: false, error: 'record type not found' };
    if (rows[0].is_system) return { ok: false, error: 'cannot archive a system record type' };
    await postgresClient.query(
      `UPDATE crm_record_types SET archived = true, updated_at = now() WHERE id = $1`, [id]);
    const undoToken = await CrmSchemaService.writeAudit(postgresClient, {
      op: 'archiveRecordType', entityType: 'record_type', entityId: id,
      before: { archived: false }, tenantId: DEFAULT_TENANT_ID,
    });
    return { ok: true, id, undoToken };
  }

  // ── view / dashboard / widget / menu helpers ─────────────────────────────

  static async createView(
    recordTypeId: string,
    input: { name: string; kind: ViewKind; config?: Record<string, unknown>; isSystem?: boolean },
    tenantId = DEFAULT_TENANT_ID,
  ): Promise<OpResult> {
    if (!VIEW_KINDS.includes(input.kind)) return { ok: false, error: `unknown view kind "${ input.kind }"` };
    const id = newId();
    await postgresClient.query(
      `INSERT INTO crm_views (id, tenant_id, record_type_id, name, kind, config, is_system)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [id, tenantId, recordTypeId, input.name, input.kind, JSON.stringify(input.config ?? {}), input.isSystem ?? false],
    );
    const undoToken = await CrmSchemaService.writeAudit(postgresClient, {
      op: 'createView', entityType: 'view', entityId: id,
      after: { name: input.name, kind: input.kind, recordTypeId }, tenantId,
    });
    return { ok: true, id, undoToken };
  }

  static async createDashboard(
    input: { key: string; name: string; icon?: string; layout?: Record<string, unknown>; isSystem?: boolean },
    tenantId = DEFAULT_TENANT_ID,
  ): Promise<OpResult> {
    const keyErr = validateKey(input.key);
    if (keyErr) return { ok: false, error: keyErr };
    try {
      const result = await postgresClient.transaction(async (tx) => {
        const dashId = newId();
        await tx.query(
          `INSERT INTO crm_dashboards (id, tenant_id, key, name, icon, layout, is_system)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [dashId, tenantId, input.key, input.name, input.icon ?? null, JSON.stringify(input.layout ?? {}), input.isSystem ?? false],
        );
        await tx.query(
          `INSERT INTO crm_menu_items (id, tenant_id, label, icon, target_type, target_id, auto_created, is_system)
           VALUES ($1,$2,$3,$4,'dashboard',$5,true,$6)`,
          [newId(), tenantId, input.name, input.icon ?? null, dashId, input.isSystem ?? false],
        );
        const undoToken = await CrmSchemaService.writeAudit(tx, {
          op: 'createDashboard', entityType: 'dashboard', entityId: dashId,
          after: { key: input.key, name: input.name }, tenantId,
        });
        return { dashId, undoToken };
      });
      return { ok: true, id: result.dashId, undoToken: result.undoToken };
    } catch (err: any) {
      if (err?.code === '23505') return { ok: false, error: `dashboard key "${ input.key }" already exists` };
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  static async createWidget(
    dashboardId: string,
    input: { recordTypeId: string; name: string; kind: WidgetKind; config?: Record<string, unknown> },
    tenantId = DEFAULT_TENANT_ID,
  ): Promise<OpResult> {
    if (!WIDGET_KINDS.includes(input.kind)) return { ok: false, error: `unknown widget kind "${ input.kind }"` };
    const id = newId();
    await postgresClient.query(
      `INSERT INTO crm_widgets (id, tenant_id, dashboard_id, record_type_id, name, kind, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [id, tenantId, dashboardId, input.recordTypeId, input.name, input.kind, JSON.stringify(input.config ?? {})],
    );
    const undoToken = await CrmSchemaService.writeAudit(postgresClient, {
      op: 'createWidget', entityType: 'widget', entityId: id,
      after: { name: input.name, kind: input.kind, dashboardId }, tenantId,
    });
    return { ok: true, id, undoToken };
  }

  // ════════════════════════════════════════════════
  //  DATA OPS
  // ════════════════════════════════════════════════

  /**
   * Create a record of a given type. `values` is keyed by field KEY; each
   * value is coerced into the typed column matching its field's data_type.
   * Recomputes the denormalized title (from the is_title field) and
   * search_text (concatenated text values). One transaction.
   */
  static async createRecord(
    recordTypeId: string,
    values: Record<string, unknown>,
    tenantId = DEFAULT_TENANT_ID,
    createdBy?: string,
  ): Promise<OpResult> {
    try {
      const result = await postgresClient.transaction(async (tx) => {
        const fields = await CrmSchemaService.loadFields(tx, recordTypeId);
        const byKey = new Map(fields.map(f => [f.key, f]));
        const recordId = newId();

        const { title, searchText } = CrmSchemaService.computeDenormalized(fields, values);

        await tx.query(
          `INSERT INTO crm_records (id, tenant_id, record_type_id, title, search_text, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [recordId, tenantId, recordTypeId, title, searchText, createdBy ?? null],
        );

        for (const [key, raw] of Object.entries(values)) {
          const field = byKey.get(key);
          if (!field) continue;                 // ignore unknown keys
          const col = valueColumnFor(field.data_type);
          if (!col || raw === null || raw === undefined) continue;
          await CrmSchemaService.upsertFieldValue(tx, tenantId, recordId, field.id, col, raw);
        }

        const undoToken = await CrmSchemaService.writeAudit(tx, {
          op: 'createRecord', entityType: 'record', entityId: recordId,
          after: { recordTypeId, title }, tenantId, createdBy,
        });
        return { recordId, undoToken };
      });
      return { ok: true, id: result.recordId, undoToken: result.undoToken };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Patch field values on an existing record. Recomputes title/search_text. */
  static async updateRecord(
    recordId: string,
    values: Record<string, unknown>,
    tenantId = DEFAULT_TENANT_ID,
  ): Promise<OpResult> {
    try {
      const undoToken = await postgresClient.transaction(async (tx) => {
        const typeRows = await tx.query(`SELECT record_type_id FROM crm_records WHERE id = $1`, [recordId]);
        if (!typeRows.rows[0]) throw new Error('record not found');
        const recordTypeId = typeRows.rows[0].record_type_id;
        const fields = await CrmSchemaService.loadFields(tx, recordTypeId);
        const byKey = new Map(fields.map(f => [f.key, f]));

        // Snapshot the prior values of just the keys being changed, for undo.
        const priorAll = await CrmSchemaService.loadRecordValues(tx, recordId, fields);
        const before: Record<string, unknown> = {};
        for (const key of Object.keys(values)) {
          if (byKey.has(key)) before[key] = priorAll[key] ?? null;
        }

        for (const [key, raw] of Object.entries(values)) {
          const field = byKey.get(key);
          if (!field) continue;
          const col = valueColumnFor(field.data_type);
          if (!col) continue;
          await CrmSchemaService.upsertFieldValue(tx, tenantId, recordId, field.id, col, raw);
        }

        // Recompute denormalized core from the merged value set.
        const merged = await CrmSchemaService.loadRecordValues(tx, recordId, fields);
        Object.assign(merged, values);
        const { title, searchText } = CrmSchemaService.computeDenormalized(fields, merged);
        await tx.query(
          `UPDATE crm_records SET title = $2, search_text = $3, updated_at = now() WHERE id = $1`,
          [recordId, title, searchText],
        );

        return CrmSchemaService.writeAudit(tx, {
          op: 'updateRecord', entityType: 'record', entityId: recordId,
          before, after: values, tenantId,
        });
      });
      return { ok: true, id: recordId, undoToken };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** Soft-delete a record. No confirm — data ops are lightweight. */
  static async archiveRecord(recordId: string, tenantId = DEFAULT_TENANT_ID): Promise<OpResult> {
    await postgresClient.query(
      `UPDATE crm_records SET archived = true, updated_at = now() WHERE id = $1`, [recordId]);
    const undoToken = await CrmSchemaService.writeAudit(postgresClient, {
      op: 'archiveRecord', entityType: 'record', entityId: recordId, before: { archived: false }, tenantId,
    });
    return { ok: true, id: recordId, undoToken };
  }

  /** Link two records via a relationship instance (idempotent). */
  static async link(relationshipId: string, fromRecordId: string, toRecordId: string, tenantId = DEFAULT_TENANT_ID): Promise<OpResult> {
    try {
      const id = newId();
      const res = await postgresClient.queryWithResult(
        `INSERT INTO crm_record_links (id, tenant_id, relationship_id, from_record_id, to_record_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (relationship_id, from_record_id, to_record_id) DO NOTHING`,
        [id, tenantId, relationshipId, fromRecordId, toRecordId],
      );
      // Only audit when a row was actually inserted (not a dedup no-op).
      if ((res.rowCount ?? 0) > 0) {
        const undoToken = await CrmSchemaService.writeAudit(postgresClient, {
          op: 'link', entityType: 'link', entityId: id,
          after: { relationshipId, fromRecordId, toRecordId }, tenantId,
        });
        return { ok: true, id, undoToken };
      }
      return { ok: true, id };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  static async unlink(relationshipId: string, fromRecordId: string, toRecordId: string, tenantId = DEFAULT_TENANT_ID): Promise<OpResult> {
    const res = await postgresClient.queryWithResult(
      `DELETE FROM crm_record_links
       WHERE relationship_id = $1 AND from_record_id = $2 AND to_record_id = $3`,
      [relationshipId, fromRecordId, toRecordId],
    );
    if ((res.rowCount ?? 0) > 0) {
      const undoToken = await CrmSchemaService.writeAudit(postgresClient, {
        op: 'unlink', entityType: 'link', entityId: null,
        before: { relationship_id: relationshipId, from_record_id: fromRecordId, to_record_id: toRecordId }, tenantId,
      });
      return { ok: true, undoToken };
    }
    return { ok: true };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  static async listRecordTypes(tenantId = DEFAULT_TENANT_ID): Promise<any[]> {
    return postgresClient.query(
      `SELECT * FROM crm_record_types
       WHERE tenant_id = $1 AND archived = false
       ORDER BY position ASC, created_at ASC`,
      [tenantId],
    );
  }

  static async getRecordTypeByKey(key: string, tenantId = DEFAULT_TENANT_ID): Promise<any | null> {
    const rows = await postgresClient.query(
      `SELECT * FROM crm_record_types WHERE tenant_id = $1 AND key = $2 AND archived = false LIMIT 1`,
      [tenantId, key],
    );
    return rows[0] ?? null;
  }

  /**
   * Fetch records of a type, compiling an optional filter + sort over the
   * EAV field values, and pivot each result into a flat object keyed by field
   * key. This is the query path the view renderers (table/kanban/calendar/
   * list) and widget aggregations ride on.
   *
   * `filter` is keyed by field key (or a core column: id/title/created_at/
   * updated_at). Each condition is either a scalar (equality) or an operator
   * object: { eq|ne|in|notIn|gt|gte|lt|lte|contains|isSet }. Field conditions
   * compile to EXISTS subqueries against crm_field_values on the field's typed
   * column; `sort` entries compile to LEFT JOINs so missing values sort last.
   */
  static async queryRecords(
    recordTypeId: string,
    opts: { filter?: Filter; sort?: SortSpec[]; limit?: number; tenantId?: string } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
    const limit = opts.limit ?? 100;

    // field key → { id, data_type } for mapping filter/sort keys to columns.
    const fieldRows = await postgresClient.query(
      `SELECT id, key, data_type FROM crm_fields WHERE record_type_id = $1 AND archived = false`,
      [recordTypeId],
    );
    const byKey = new Map<string, { id: string; data_type: DataType }>(
      fieldRows.map((f: any) => [f.key, { id: f.id, data_type: f.data_type }]),
    );

    const params: any[] = [tenantId, recordTypeId];
    const where: string[] = ['r.tenant_id = $1', 'r.record_type_id = $2', 'r.archived = false'];
    const joins: string[] = [];
    const push = (v: any): string => { params.push(v); return `$${ params.length }`; };

    for (const [key, cond] of Object.entries(opts.filter ?? {})) {
      const frag = CrmSchemaService.compileFilterCond(key, cond, byKey, push);
      if (frag) where.push(frag);
    }

    let orderBy = 'r.created_at DESC';
    if (opts.sort && opts.sort.length) {
      const parts: string[] = [];
      opts.sort.forEach((s, i) => {
        const dir = s.dir === 'asc' ? 'ASC' : 'DESC';
        if (CORE_COLUMNS.has(s.field)) {
          parts.push(`r.${ s.field } ${ dir }`);
        } else {
          const field = byKey.get(s.field);
          if (!field) return;
          const col = valueColumnFor(field.data_type);
          if (!col) return;
          const alias = `sj${ i }`;
          joins.push(`LEFT JOIN crm_field_values ${ alias } ON ${ alias }.record_id = r.id AND ${ alias }.field_id = ${ push(field.id) }`);
          parts.push(`${ alias }.${ col } ${ dir } NULLS LAST`);
        }
      });
      if (parts.length) orderBy = parts.join(', ');
    }

    const limitPlaceholder = push(limit);
    const records = await postgresClient.query(
      `SELECT r.id, r.title, r.created_at FROM crm_records r
       ${ joins.join('\n       ') }
       WHERE ${ where.join(' AND ') }
       ORDER BY ${ orderBy } LIMIT ${ limitPlaceholder }`,
      params,
    );
    if (records.length === 0) return [];

    const ids = records.map((r: any) => r.id);
    const values = await postgresClient.query(
      `SELECT fv.record_id, f.key, f.data_type,
              fv.value_text, fv.value_number, fv.value_bool, fv.value_datetime, fv.value_json
       FROM crm_field_values fv
       JOIN crm_fields f ON f.id = fv.field_id
       WHERE fv.record_id = ANY($1)`,
      [ids],
    );

    const byRecord = new Map<string, Record<string, unknown>>();
    for (const r of records) byRecord.set(r.id, { id: r.id, title: r.title, created_at: r.created_at });
    for (const v of values) {
      const target = byRecord.get(v.record_id);
      if (!target) continue;
      const col = valueColumnFor(v.data_type);
      target[v.key] = col ? (v as any)[col] : null;
    }
    // Preserve the SQL ordering (Map iteration follows insertion order = record order).
    return records.map((r: any) => byRecord.get(r.id)!);
  }

  /**
   * Compile one filter condition into a SQL WHERE fragment (params pushed via
   * `push`). Core columns compare directly on `r`; field keys compile to an
   * EXISTS (or NOT EXISTS) over crm_field_values on the field's typed column.
   * Unknown keys are skipped (return null).
   */
  private static compileFilterCond(
    key: string,
    cond: FilterCond,
    byKey: Map<string, { id: string; data_type: DataType }>,
    push: (v: any) => string,
  ): string | null {
    const isCore = CORE_COLUMNS.has(key);
    const field = byKey.get(key);
    if (!isCore && !field) return null;
    const col = isCore ? null : valueColumnFor(field!.data_type);
    if (!isCore && !col) return null;

    // Build a comparison on a column expression `lhs`.
    const cmp = (lhs: string, op: string, val: unknown): string => {
      switch (op) {
      case 'eq':       return `${ lhs } = ${ push(val) }`;
      case 'ne':       return `${ lhs } <> ${ push(val) }`;
      case 'gt':       return `${ lhs } > ${ push(val) }`;
      case 'gte':      return `${ lhs } >= ${ push(val) }`;
      case 'lt':       return `${ lhs } < ${ push(val) }`;
      case 'lte':      return `${ lhs } <= ${ push(val) }`;
      case 'in':       return `${ lhs } = ANY(${ push(val) })`;
      case 'contains': return `${ lhs } ILIKE '%' || ${ push(val) } || '%'`;
      default:         return `${ lhs } = ${ push(val) }`;
      }
    };

    const exists = (inner: string): string =>
      `EXISTS (SELECT 1 FROM crm_field_values fv WHERE fv.record_id = r.id AND fv.field_id = ${ push(field!.id) } AND ${ inner })`;
    const notExists = (inner: string): string =>
      `NOT EXISTS (SELECT 1 FROM crm_field_values fv WHERE fv.record_id = r.id AND fv.field_id = ${ push(field!.id) } AND ${ inner })`;

    // Operator object vs. scalar (= equality).
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const o = cond as Record<string, unknown>;
      const frags: string[] = [];
      for (const [op, val] of Object.entries(o)) {
        if (op === 'isSet') {
          if (isCore) { frags.push(val ? `r.${ key } IS NOT NULL` : `r.${ key } IS NULL`); }
          else { frags.push(val ? exists(`fv.${ col } IS NOT NULL`) : notExists(`fv.${ col } IS NOT NULL`)); }
        } else if (op === 'ne') {
          frags.push(isCore ? `r.${ key } <> ${ push(val) }` : notExists(cmp(`fv.${ col }`, 'eq', val)));
        } else if (op === 'notIn') {
          frags.push(isCore ? `NOT (r.${ key } = ANY(${ push(val) }))` : notExists(cmp(`fv.${ col }`, 'in', val)));
        } else {
          frags.push(isCore ? cmp(`r.${ key }`, op, val) : exists(cmp(`fv.${ col }`, op, val)));
        }
      }
      return frags.length ? frags.join(' AND ') : null;
    }

    // Scalar → equality.
    return isCore ? cmp(`r.${ key }`, 'eq', cond) : exists(cmp(`fv.${ col }`, 'eq', cond));
  }

  // ════════════════════════════════════════════════
  //  PRIVATE
  // ════════════════════════════════════════════════

  private static async insertField(
    tx: PoolClient, tenantId: string, recordTypeId: string, f: FieldInput, position: number,
  ): Promise<string> {
    const fieldId = newId();
    await tx.query(
      `INSERT INTO crm_fields
         (id, tenant_id, record_type_id, key, label, data_type, config,
          is_required, is_unique, is_title, is_system, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
      [fieldId, tenantId, recordTypeId, f.key, f.label, f.dataType,
        JSON.stringify(f.config ?? {}), f.isRequired ?? false, f.isUnique ?? false,
        f.isTitle ?? false, f.isSystem ?? false, position],
    );
    return fieldId;
  }

  private static async loadFields(tx: PoolClient, recordTypeId: string): Promise<FieldRow[]> {
    const res = await tx.query(
      `SELECT id, key, data_type, is_title FROM crm_fields
       WHERE record_type_id = $1 AND archived = false ORDER BY position ASC`,
      [recordTypeId],
    );
    return res.rows as FieldRow[];
  }

  private static async loadRecordValues(tx: PoolClient, recordId: string, fields: FieldRow[]): Promise<Record<string, unknown>> {
    const res = await tx.query(
      `SELECT field_id, value_text, value_number, value_bool, value_datetime, value_json
       FROM crm_field_values WHERE record_id = $1`,
      [recordId],
    );
    const byId = new Map(fields.map(f => [f.id, f]));
    const out: Record<string, unknown> = {};
    for (const row of res.rows) {
      const field = byId.get(row.field_id);
      if (!field) continue;
      const col = valueColumnFor(field.data_type);
      if (col) out[field.key] = row[col];
    }
    return out;
  }

  private static async upsertFieldValue(
    tx: PoolClient, tenantId: string, recordId: string, fieldId: string,
    col: 'value_text' | 'value_number' | 'value_bool' | 'value_datetime' | 'value_json', raw: unknown,
  ): Promise<void> {
    const stored = col === 'value_json' ? JSON.stringify(raw) : raw;
    const cast = col === 'value_json' ? '::jsonb' : '';
    await tx.query(
      `INSERT INTO crm_field_values (id, tenant_id, record_id, field_id, ${ col })
       VALUES ($1,$2,$3,$4,$5${ cast })
       ON CONFLICT (record_id, field_id)
       DO UPDATE SET ${ col } = EXCLUDED.${ col }, updated_at = now()`,
      [newId(), tenantId, recordId, fieldId, stored],
    );
  }

  /** Compute denormalized title (is_title field) + search_text (all text values). */
  private static computeDenormalized(
    fields: FieldRow[], values: Record<string, unknown>,
  ): { title: string | null; searchText: string } {
    const titleField = fields.find(f => f.is_title) ?? fields.find(f => valueColumnFor(f.data_type) === 'value_text');
    const title = titleField ? (values[titleField.key] != null ? String(values[titleField.key]) : null) : null;

    const parts: string[] = [];
    for (const f of fields) {
      if (valueColumnFor(f.data_type) === 'value_text' && values[f.key] != null) {
        parts.push(String(values[f.key]));
      }
    }
    return { title, searchText: parts.join(' ') };
  }

  /**
   * Write one append-only audit row (crm_audit, migration 0036) and return a
   * fresh undo_token. Runs on whatever executor is passed — a PoolClient when
   * inside a transaction (so the audit row commits atomically with the change)
   * or postgresClient for single-statement ops.
   */
  private static async writeAudit(
    exec: SqlExecutor,
    a: { op: string; entityType: AuditEntityType; entityId: string | null;
      before?: unknown; after?: unknown; tenantId: string; createdBy?: string },
  ): Promise<string> {
    const undoToken = `undo_${ crypto.randomUUID() }`;
    await exec.query(
      `INSERT INTO crm_audit
         (id, tenant_id, undo_token, op, entity_type, entity_id, before, after, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [crypto.randomUUID(), a.tenantId, undoToken, a.op, a.entityType, a.entityId,
        a.before == null ? null : JSON.stringify(a.before),
        a.after == null ? null : JSON.stringify(a.after),
        a.createdBy ?? null],
    );
    return undoToken;
  }

  /**
   * Revert a previously-audited op by its undo_token.
   *
   * Reversal is generic and soft where possible:
   *   • create* / defineRelationship → archive the created row (link → delete,
   *     since crm_record_links has no archived column).
   *   • archive*                     → un-archive the row.
   *   • updateRecord                 → restore the record's prior field values
   *                                    (and re-derive title/search_text) from
   *                                    the `before` snapshot.
   *   • unlink                       → re-create the link from `before`.
   *
   * Shallow by design: undoing a createRecordType archives the type (which
   * also hides its auto view/menu) but does not separately delete those child
   * rows — acceptable for the soft-delete model. Idempotent: a token already
   * marked `undone` returns an error rather than reverting twice.
   */
  static async undo(undoToken: string): Promise<OpResult> {
    try {
      return await postgresClient.transaction(async (tx) => {
        const res = await tx.query(
          `SELECT * FROM crm_audit WHERE undo_token = $1 AND undone = false LIMIT 1`, [undoToken]);
        const row = res.rows[0];
        if (!row) return { ok: false, error: 'unknown or already-undone undo_token' };

        const entityType = row.entity_type as AuditEntityType;
        const table = ENTITY_TABLE[entityType];
        const op = row.op as string;

        if (op === 'unlink') {
          const b = row.before ?? {};
          await tx.query(
            `INSERT INTO crm_record_links (id, tenant_id, relationship_id, from_record_id, to_record_id)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (relationship_id, from_record_id, to_record_id) DO NOTHING`,
            [crypto.randomUUID(), row.tenant_id, b.relationship_id, b.from_record_id, b.to_record_id]);
        } else if (op === 'updateRecord') {
          const before = (row.before ?? {}) as Record<string, unknown>;
          const recordTypeRows = await tx.query(`SELECT record_type_id FROM crm_records WHERE id = $1`, [row.entity_id]);
          if (recordTypeRows.rows[0]) {
            const fields = await CrmSchemaService.loadFields(tx, recordTypeRows.rows[0].record_type_id);
            const byKey = new Map(fields.map(f => [f.key, f]));
            for (const [key, val] of Object.entries(before)) {
              const field = byKey.get(key);
              if (!field) continue;
              const col = valueColumnFor(field.data_type);
              if (!col) continue;
              await CrmSchemaService.upsertFieldValue(tx, row.tenant_id, row.entity_id, field.id, col, val);
            }
            const { title, searchText } = CrmSchemaService.computeDenormalized(fields, before);
            await tx.query(`UPDATE crm_records SET title=$2, search_text=$3, updated_at=now() WHERE id=$1`,
              [row.entity_id, title, searchText]);
          }
        } else if (op.startsWith('archive')) {
          await tx.query(`UPDATE ${ table } SET archived = false, updated_at = now() WHERE id = $1`, [row.entity_id]);
        } else if (entityType === 'link') {            // a link create
          await tx.query(`DELETE FROM ${ table } WHERE id = $1`, [row.entity_id]);
        } else {                                        // any other create*
          await tx.query(`UPDATE ${ table } SET archived = true, updated_at = now() WHERE id = $1`, [row.entity_id]);
        }

        await tx.query(`UPDATE crm_audit SET undone = true WHERE id = $1`, [row.id]);
        return { ok: true, id: row.entity_id };
      });
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }
}
