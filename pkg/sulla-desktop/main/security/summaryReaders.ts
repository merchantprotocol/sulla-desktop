// SPDX-License-Identifier: GPL-2.0-or-later
import { decisionService } from '@pkg/agent/services/DecisionService';
import { RulesModel } from '@pkg/agent/database/models/RulesModel';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import type { DecisionRecord } from '@pkg/shared/decisions';
import type { SecuritySummary } from './types';

const READ_TIMEOUT_MS = 3_000;
type DailyCounts = { scannedToday: number; blockedToday: number };
type ActivityRow = { at: string; actor: string; action: string; target: string };

async function boundedRead<T>(read: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('Security summary source timed out')), timeoutMs) })]);
  } finally { if (timer) clearTimeout(timer) }
}

/** Counts the same live, unexpired Files-publish decisions displayed by Decide. */
export class PendingUseCaseApprovalsReader {
  constructor(private readonly list: () => Promise<DecisionRecord[]> = () => decisionService.list(), private readonly timeoutMs = READ_TIMEOUT_MS) {}
  async read(): Promise<SecuritySummary['approvals']> {
    try {
      const now = Date.now();
      const records = await boundedRead(this.list, this.timeoutMs);
      const pending = records.filter(record => record.kind === 'approval' && ['pending', 'deferred'].includes(record.status) && record.expiresAt > now && typeof record.payload?.filesPublishRequestId === 'string').length;
      return { pending };
    } catch { return null }
  }
}

/** Reads the active user-authored rules from the same repository used by rules/list_rules. */
export class SecurityRulesReader {
  constructor(private readonly list: () => Promise<Array<{ id: string; title: string }>> = async() => {
    await RulesModel.ensureTable();
    return RulesModel.listActive({ limit: 500 });
  }, private readonly timeoutMs = READ_TIMEOUT_MS) {}
  async read(): Promise<SecuritySummary['rules']> {
    try { return await boundedRead(this.list, this.timeoutMs).then(rows => rows.map(row => ({ id: row.id, title: row.title }))) } catch { return null }
  }
}

/** Maps persisted agent tool-result messages to a content-free recent action list. */
export class AgentActionsReader {
  constructor(private readonly query: (sql: string, params?: unknown[]) => Promise<ActivityRow[]> = (sql, params) => postgresClient.query(sql, params), private readonly timeoutMs = READ_TIMEOUT_MS) {}
  async read(): Promise<SecuritySummary['activity']> {
    try {
      const rows = await boundedRead(() => this.query(`
        SELECT created_at AS at,
               COALESCE(NULLIF(meta->>'agentName', ''), NULLIF(meta->>'agent', ''), 'agent') AS actor,
               COALESCE(NULLIF(tool_name, ''), 'tool call') AS action,
               COALESCE(NULLIF(tool_name, ''), 'tool call') AS target
        FROM conversation_messages
        WHERE role = 'tool' AND deleted_at IS NULL
        ORDER BY created_at DESC, seq DESC
        LIMIT 10
      `), this.timeoutMs);
      return rows.map(row => ({ at: new Date(row.at).toISOString(), actor: row.actor, action: row.action, target: row.target }));
    } catch { return null }
  }
}

/** Null when the proxy image/state has no authoritative counter file. */
export class ThreatDailyCountersReader {
  constructor(private readonly readCounters: () => Promise<DailyCounts | null>, private readonly timeoutMs = READ_TIMEOUT_MS) {}
  async read(): Promise<DailyCounts | null> {
    try {
      const result = await boundedRead(this.readCounters, this.timeoutMs);
      return result && Number.isSafeInteger(result.scannedToday) && result.scannedToday >= 0 && Number.isSafeInteger(result.blockedToday) && result.blockedToday >= 0 ? result : null;
    } catch { return null }
  }
}
