// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { AppleScriptAuditRepository } from '../../../app/Repositories/AppleScriptAuditRepository';
import { DesktopAuditRepository } from '../../../app/Repositories/DesktopAuditRepository';
import { NotificationRepository } from '../../../app/Repositories/NotificationRepository';

const fakeClient = (rows: unknown[] = []) => ({ query: vi.fn(async() => rows) as any });
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('NotificationRepository', () => {
  // risk: data accuracy — history rows must keep the jsonb targets and null error.
  it('inserts a notification history row with jsonb targets', async() => {
    const client = fakeClient();
    await new NotificationRepository(client).insert({
      title: 'T', message: 'M', targets: ['desktop', 'mobile'], id: 'n1', silent: false, delivered: true,
    });
    const [sql, params] = client.query.mock.calls[0];
    expect(squash(sql)).toBe('INSERT INTO notifications (title, message, targets, notification_id, silent, delivered, error) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)');
    expect(params).toEqual(['T', 'M', '["desktop","mobile"]', 'n1', false, true, null]);
  });

  // risk: data accuracy — filter placeholders must line up with params.
  it('builds the filtered history query with ordered placeholders', async() => {
    const rows = [{ id: 1 }];
    const client = fakeClient(rows);
    const result = await new NotificationRepository(client).recent({
      target: 'mobile', onlyFailures: true, sinceIso: '2026-11-01T00:00:00.000Z', limit: 7,
    });
    const [sql, params] = client.query.mock.calls[0];
    expect(result).toBe(rows);
    expect(squash(sql)).toBe('SELECT id, title, message, targets, notification_id, silent, delivered, error, sent_at FROM notifications WHERE targets @> $1::jsonb AND delivered = false AND sent_at >= $2 ORDER BY sent_at DESC LIMIT $3');
    expect(params).toEqual(['["mobile"]', '2026-11-01T00:00:00.000Z', 7]);
  });

  it('omits the WHERE clause when no filter is given', async() => {
    const client = fakeClient();
    await new NotificationRepository(client).recent({ onlyFailures: false, limit: 50 });
    const [sql, params] = client.query.mock.calls[0];
    expect(squash(sql)).toBe('SELECT id, title, message, targets, notification_id, silent, delivered, error, sent_at FROM notifications ORDER BY sent_at DESC LIMIT $1');
    expect(params).toEqual([50]);
  });
});

describe('AppleScriptAuditRepository', () => {
  // risk: audit integrity — anything other than "write" is recorded as "read".
  it('inserts an audit row and normalises the action type', async() => {
    const client = fakeClient();
    await new AppleScriptAuditRepository(client).insert({
      target_app: 'Finder', script: 'tell app', action_type: 'delete', success: false, durationMs: 12, responseChars: 3, error: 'boom',
    });
    const [sql, params] = client.query.mock.calls[0];
    expect(squash(sql)).toBe('INSERT INTO applescript_audit (target_app, action_type, script, success, duration_ms, response_chars, error) VALUES ($1, $2, $3, $4, $5, $6, $7)');
    expect(params).toEqual(['Finder', 'read', 'tell app', false, 12, 3, 'boom']);
  });

  it('keeps "write" actions as write', async() => {
    const client = fakeClient();
    await new AppleScriptAuditRepository(client).insert({
      target_app: 'Mail', script: 's', action_type: 'write', success: true, durationMs: 1, responseChars: 0,
    });
    expect(client.query.mock.calls[0][1]).toEqual(['Mail', 'write', 's', true, 1, 0, null]);
  });

  // risk: data accuracy — filter placeholders must line up with params.
  it('builds the filtered audit query with ordered placeholders', async() => {
    const client = fakeClient();
    await new AppleScriptAuditRepository(client).recent({
      targetApp: 'Finder', onlyFailures: true, sinceIso: '2026-11-01T00:00:00.000Z', limit: 5,
    });
    const [sql, params] = client.query.mock.calls[0];
    expect(squash(sql)).toBe('SELECT id, target_app, action_type, script, success, duration_ms, response_chars, error, executed_at FROM applescript_audit WHERE target_app = $1 AND success = false AND executed_at >= $2 ORDER BY executed_at DESC LIMIT $3');
    expect(params).toEqual(['Finder', '2026-11-01T00:00:00.000Z', 5]);
  });
});

describe('DesktopAuditRepository', () => {
  // risk: audit integrity — a missing target app is stored as null.
  it('inserts a desktop audit row', async() => {
    const client = fakeClient();
    await new DesktopAuditRepository(client).insert('desktop_click', undefined, 'click', true, 40);
    expect(client.query).toHaveBeenCalledWith(
      'INSERT INTO desktop_audit (tool, target_app, action, success, duration_ms) VALUES ($1,$2,$3,$4,$5)',
      ['desktop_click', null, 'click', true, 40],
    );
  });
});
