/**
 * Migration 0033 — Create crm_field_values table (hybrid-typed EAV).
 *
 * The custom "cells": one row per (record, field). Rather than a single
 * stringly-typed `value`, the value lands in the typed column matching the
 * field's data_type — exactly one of value_* is non-null per row:
 *   text/long_text/email/phone/url → value_text
 *   number/currency                → value_number
 *   bool                           → value_bool
 *   date/datetime                  → value_datetime
 *   select                         → value_text
 *   multi_select/json              → value_json
 *
 * Typed columns (not a JSON blob) preserve sortability, range queries, and
 * index usefulness — required for the dynamic-widget aggregations
 * (e.g. SUM(value_number) GROUP BY date_trunc('month', value_datetime)).
 * The exactly-one-non-null invariant is enforced in the app layer for now
 * (a CHECK may be added later if drift appears).
 *
 * Design: projects/sulla-crm-dynamic-architecture/01-P1-SCHEMA-DRAFT.md
 */

export const up = `
  CREATE TABLE IF NOT EXISTS crm_field_values (
    id             TEXT        PRIMARY KEY,
    tenant_id      TEXT        NOT NULL,
    record_id      TEXT        NOT NULL REFERENCES crm_records(id) ON DELETE CASCADE,
    field_id       TEXT        NOT NULL REFERENCES crm_fields(id)  ON DELETE CASCADE,
    value_text     TEXT,
    value_number   NUMERIC,
    value_bool     BOOLEAN,
    value_datetime TIMESTAMPTZ,
    value_json     JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_fv_record_field
    ON crm_field_values (record_id, field_id);

  CREATE INDEX IF NOT EXISTS idx_crm_fv_field_text
    ON crm_field_values (field_id, value_text);

  CREATE INDEX IF NOT EXISTS idx_crm_fv_field_number
    ON crm_field_values (field_id, value_number);

  CREATE INDEX IF NOT EXISTS idx_crm_fv_field_datetime
    ON crm_field_values (field_id, value_datetime);
`;

export const down = `DROP TABLE IF EXISTS crm_field_values CASCADE;`;
