// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type TraceRowKind = 'thought' | 'tool' | 'memory' | 'heartbeat' | 'activity' | 'handoff' | 'retry' | 'approval' | 'usage' | 'source';
export type TraceRowStatus = 'ok' | 'failed' | 'waiting' | 'approved' | 'running';

export interface TraceRow {
  id: string;
  kind: TraceRowKind;
  verb: string;
  target: string;
  targetIsCode: boolean;
  keyArgs?: string;
  durationLabel?: string;
  status: TraceRowStatus;
  note?: string;
  rawPayload?: string;
  anchorEntryId: string;
  at?: number;
}

export interface TraceTurn {
  id: string;
  anchorEntryId: string;
  rows: TraceRow[];
  usage?: { model?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number; durationLabel?: string };
}
