// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Custom fields: user-defined label/value pairs stored ONLY inside the encrypted item plaintext
// (VaultItemPlaintext.customFields). They never go to plaintext columns, list responses,
// integration metadata or audit rows.
//
// This file is the single source of truth for custom field types, limits and validation.
// The local vault page (services/sulla-vault/console/local/customFields.js) is plain browser
// JavaScript without a bundler, so it mirrors these definitions; customFields.test.ts loads that
// file and fails if the two drift apart.
//
// How to add a new type:
//   1. Add the key to CUSTOM_FIELD_TYPES and a friendly name to CUSTOM_FIELD_TYPE_LABELS.
//   2. Add a validator branch in customFieldValueError() (return a message, or null when valid).
//   3. If the value is a secret, add it to SECRET_CUSTOM_FIELD_TYPES.
//   4. Mirror steps 1–3 in console/local/customFields.js, then give it an editor input and a
//      detail renderer in console/local/local.js. The parity test covers steps 1–3.
// Stored items may contain types this build does not know yet (written by a newer client).
// They are kept untouched on save and shown as plain text; they are never dropped.

export const CUSTOM_FIELD_TYPES = [
  'text', 'multiline', 'password', 'url', 'email', 'number', 'date', 'phone', 'one-time', 'boolean', 'linked',
] as const;

export type CustomFieldType = typeof CUSTOM_FIELD_TYPES[number];

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text:       'Text',
  multiline:  'Long text',
  password:   'Password',
  url:        'Website / URL',
  email:      'Email',
  number:     'Number',
  date:       'Date',
  phone:      'Phone',
  'one-time': 'One-time code (TOTP)',
  boolean:    'Yes / No',
  linked:     'Linked field',
};

/** Types whose value is a secret: masked in the UI and treated like the item password. */
export const SECRET_CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = ['password', 'one-time'];

export const CUSTOM_FIELD_LIMITS = {
  maxFields:      40,
  maxLabelLength: 80,
  maxValueBytes:  8 * 1024,
} as const;

export interface VaultItemCustomField {
  /** Stable id (UUID) so edits and reorders keep identity. */
  id:      string;
  label:   string;
  /** A CustomFieldType, or a type from a newer client that is preserved as-is. */
  type:    string;
  value:   string;
  /** Mask the value like a password even when the type is not a secret type. */
  hidden?: boolean;
}

const FIELD_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const FUTURE_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function isKnownCustomFieldType(type: unknown): type is CustomFieldType {
  return typeof type === 'string' && (CUSTOM_FIELD_TYPES as readonly string[]).includes(type);
}

export function isSecretCustomField(field: Pick<VaultItemCustomField, 'type' | 'hidden'>): boolean {
  return field.hidden === true || (SECRET_CUSTOM_FIELD_TYPES as readonly string[]).includes(field.type);
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTotpSecret(value: string): boolean {
  const trimmed = value.trim();
  if (/^otpauth:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'otpauth:' || !['totp', 'hotp'].includes(url.hostname.toLowerCase())) return false;
      const secret = url.searchParams.get('secret') ?? '';
      return /^[A-Z2-7]{16,}=*$/i.test(secret.replace(/\s+/g, ''));
    } catch {
      return false;
    }
  }
  return /^[A-Z2-7]{16,}=*$/i.test(trimmed.replace(/[\s-]+/g, ''));
}

/**
 * Returns a human-readable problem with `value` for `type`, or null when it is valid.
 * Messages never include the value. Empty values are allowed for every type except boolean.
 */
export function customFieldValueError(type: string, value: unknown): string | null {
  if (typeof value !== 'string') return 'must be text';
  if (new TextEncoder().encode(value).length > CUSTOM_FIELD_LIMITS.maxValueBytes) {
    return `must be ${ CUSTOM_FIELD_LIMITS.maxValueBytes / 1024 } KiB or less`;
  }
  if (type === 'boolean') return value === 'true' || value === 'false' ? null : 'must be Yes or No';
  if (value === '' || !isKnownCustomFieldType(type)) return null;
  const trimmed = value.trim();
  switch (type) {
  case 'text':
  case 'linked':
  case 'password':
    return /[\r\n]/.test(value) ? 'must be a single line' : null;
  case 'multiline':
    return null;
  case 'url':
    try {
      const url = new URL(trimmed);
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? null : 'must start with https://, http:// or mailto:';
    } catch {
      return 'must be a full URL such as https://example.com';
    }
  case 'email':
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? null : 'must be an email address';
  case 'number':
    return /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(trimmed) && Number.isFinite(Number(trimmed)) ? null : 'must be a number';
  case 'date':
    return validCalendarDate(trimmed) ? null : 'must be a date (YYYY-MM-DD)';
  case 'phone':
    return /^\+?[0-9 ().-]{3,32}$/.test(trimmed) && (trimmed.match(/\d/g)?.length ?? 0) >= 3 ? null : 'must be a phone number';
  case 'one-time':
    return validTotpSecret(value) ? null : 'must be a base32 secret or an otpauth:// URI';
  }
  return null;
}

export type CustomFieldsValidation =
  | { ok: true; fields: VaultItemCustomField[] }
  | { ok: false; error: string };

/**
 * Validates an item's customFields array. Fails closed. Error messages identify fields by
 * position only, never by label or value, so they are safe to return from the service.
 *
 * `preserved` lists stored fields whose unknown type may round-trip: a field with a type this
 * build does not know is accepted only when the same id already had that type in `preserved`.
 */
export function validateCustomFields(
  input: unknown,
  options: { preserved?: readonly VaultItemCustomField[] } = {},
): CustomFieldsValidation {
  if (input === undefined) return { ok: true, fields: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'Custom fields must be a list' };
  if (input.length > CUSTOM_FIELD_LIMITS.maxFields) {
    return { ok: false, error: `Items can have at most ${ CUSTOM_FIELD_LIMITS.maxFields } custom fields` };
  }
  const preservedTypes = new Map((options.preserved ?? []).map(field => [field.id, field.type]));
  const labels = new Set<string>();
  const ids = new Set<string>();
  const fields: VaultItemCustomField[] = [];
  for (const [index, raw] of input.entries()) {
    const where = `Custom field ${ index + 1 }`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${ where } is invalid` };
    const field = raw as Record<string, unknown>;
    const extra = Object.keys(field).filter(key => !['id', 'label', 'type', 'value', 'hidden'].includes(key));
    if (extra.length) return { ok: false, error: `${ where } has unsupported properties` };
    if (typeof field.id !== 'string' || !FIELD_ID_PATTERN.test(field.id)) return { ok: false, error: `${ where } has an invalid id` };
    if (ids.has(field.id)) return { ok: false, error: `${ where } repeats another field's id` };
    if (typeof field.label !== 'string') return { ok: false, error: `${ where } needs a label` };
    const label = field.label.trim();
    if (!label || label.length > CUSTOM_FIELD_LIMITS.maxLabelLength) {
      return { ok: false, error: `${ where } label must be 1–${ CUSTOM_FIELD_LIMITS.maxLabelLength } characters` };
    }
    if (CONTROL_CHARACTERS.test(label)) return { ok: false, error: `${ where } label contains control characters` };
    if (labels.has(label.toLowerCase())) return { ok: false, error: `${ where } label is already used on this item` };
    if (typeof field.type !== 'string') return { ok: false, error: `${ where } needs a type` };
    if (!isKnownCustomFieldType(field.type)) {
      if (!FUTURE_TYPE_PATTERN.test(field.type) || preservedTypes.get(field.id) !== field.type) {
        return { ok: false, error: `${ where } has an unsupported type` };
      }
    }
    if (field.hidden !== undefined && typeof field.hidden !== 'boolean') return { ok: false, error: `${ where } hidden flag is invalid` };
    const problem = customFieldValueError(field.type, field.value);
    if (problem) return { ok: false, error: `${ where } ${ problem }` };
    ids.add(field.id);
    labels.add(label.toLowerCase());
    fields.push({
      id: field.id, label, type: field.type, value: field.value as string,
      ...(field.hidden === undefined ? {} : { hidden: field.hidden }),
    });
  }
  return { ok: true, fields };
}
