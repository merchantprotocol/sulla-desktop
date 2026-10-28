// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Browser mirror of packages/vault-crypto/src/customFields.ts (the source of truth).
// The local vault page has no bundler, so the types, limits and validators are repeated here.
// services/sulla-vault/src/customFields.test.ts loads this file and fails if it drifts.
// To add a type: follow the steps at the top of customFields.ts, then add an editor input and a
// detail renderer for it in local.js (customFieldInput / customFieldDetail).
(root => {
  'use strict';

  const TYPES = ['text', 'multiline', 'password', 'url', 'email', 'number', 'date', 'phone', 'one-time', 'boolean'];
  const TYPE_LABELS = {
    text: 'Text', multiline: 'Long text', password: 'Password', url: 'Website / URL', email: 'Email',
    number: 'Number', date: 'Date', phone: 'Phone', 'one-time': 'One-time code (TOTP)', boolean: 'Yes / No',
  };
  const SECRET_TYPES = ['password', 'one-time'];
  const LIMITS = { maxFields: 40, maxLabelLength: 80, maxValueBytes: 8 * 1024 };
  const FIELD_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
  const FUTURE_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

  const isKnownType = type => typeof type === 'string' && TYPES.includes(type);
  const isSecret = field => field.hidden === true || SECRET_TYPES.includes(field.type);

  const validCalendarDate = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
  const validTotpSecret = value => {
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
  };

  // Same contract as customFieldValueError() in customFields.ts.
  const valueError = (type, value) => {
    if (typeof value !== 'string') return 'must be text';
    if (new TextEncoder().encode(value).length > LIMITS.maxValueBytes) return `must be ${LIMITS.maxValueBytes / 1024} KiB or less`;
    if (type === 'boolean') return value === 'true' || value === 'false' ? null : 'must be Yes or No';
    if (value === '' || !isKnownType(type)) return null;
    const trimmed = value.trim();
    switch (type) {
    case 'text':
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
  };

  // Label problem for one field given the other labels on the item, or null.
  const labelError = (label, otherLabels) => {
    const trimmed = String(label ?? '').trim();
    if (!trimmed || trimmed.length > LIMITS.maxLabelLength) return `Label must be 1–${LIMITS.maxLabelLength} characters`;
    if (CONTROL_CHARACTERS.test(trimmed)) return 'Label contains control characters';
    if (otherLabels.some(other => String(other ?? '').trim().toLowerCase() === trimmed.toLowerCase())) return 'Label is already used on this item';
    return null;
  };

  // Same contract as validateCustomFields() in customFields.ts.
  const validate = (input, options = {}) => {
    if (input === undefined) return { ok: true, fields: [] };
    if (!Array.isArray(input)) return { ok: false, error: 'Custom fields must be a list' };
    if (input.length > LIMITS.maxFields) return { ok: false, error: `Items can have at most ${LIMITS.maxFields} custom fields` };
    const preservedTypes = new Map((options.preserved || []).map(field => [field.id, field.type]));
    const labels = new Set(); const ids = new Set(); const fields = [];
    for (const [index, field] of input.entries()) {
      const where = `Custom field ${index + 1}`;
      if (!field || typeof field !== 'object' || Array.isArray(field)) return { ok: false, error: `${where} is invalid` };
      if (Object.keys(field).some(key => !['id', 'label', 'type', 'value', 'hidden'].includes(key))) return { ok: false, error: `${where} has unsupported properties` };
      if (typeof field.id !== 'string' || !FIELD_ID_PATTERN.test(field.id)) return { ok: false, error: `${where} has an invalid id` };
      if (ids.has(field.id)) return { ok: false, error: `${where} repeats another field's id` };
      if (typeof field.label !== 'string') return { ok: false, error: `${where} needs a label` };
      const label = field.label.trim();
      if (!label || label.length > LIMITS.maxLabelLength) return { ok: false, error: `${where} label must be 1–${LIMITS.maxLabelLength} characters` };
      if (CONTROL_CHARACTERS.test(label)) return { ok: false, error: `${where} label contains control characters` };
      if (labels.has(label.toLowerCase())) return { ok: false, error: `${where} label is already used on this item` };
      if (typeof field.type !== 'string') return { ok: false, error: `${where} needs a type` };
      if (!isKnownType(field.type) && (!FUTURE_TYPE_PATTERN.test(field.type) || preservedTypes.get(field.id) !== field.type)) return { ok: false, error: `${where} has an unsupported type` };
      if (field.hidden !== undefined && typeof field.hidden !== 'boolean') return { ok: false, error: `${where} hidden flag is invalid` };
      const problem = valueError(field.type, field.value);
      if (problem) return { ok: false, error: `${where} ${problem}` };
      ids.add(field.id); labels.add(label.toLowerCase());
      fields.push({ id: field.id, label, type: field.type, value: field.value, ...(field.hidden === undefined ? {} : { hidden: field.hidden }) });
    }
    return { ok: true, fields };
  };

  root.SullaVaultCustomFields = Object.freeze({ TYPES, TYPE_LABELS, SECRET_TYPES, LIMITS, isKnownType, isSecret, valueError, labelError, validate });
})(globalThis);
