// SPDX-License-Identifier: GPL-2.0-or-later
// Renderer copy of the security IPC contract; backend owns main/security/types.ts.
export type CheckId = 'runtime' | 'containers' | 'threatProxy' | 'blocklist' | 'vault' | 'filesEncryption' | 'hostAccess' | 'signature';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_checked';
export interface SecurityCheckResult { id: CheckId; label: string; status: CheckStatus; detail: string }
export interface SecurityCheckReport { startedAt: string; finishedAt: string; checks: SecurityCheckResult[]; score: { on: number; total: number } }
export interface SecuritySummary {
  lastReport: SecurityCheckReport | null;
  vault: { locked: boolean; autoLockMinutes: number | null } | null;
  threat: { scannedToday: number | null; blockedToday: number | null; recentBlocked: { host: string; reason: string; at: string }[] } | null;
  approvals: { pending: number | null } | null;
  rules: { id: string; title: string }[] | null;
  activity: { at: string; actor: string; action: string; target: string }[] | null;
}
