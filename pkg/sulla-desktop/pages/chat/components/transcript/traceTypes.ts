// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { TracePayload } from './TracePayloadSerializer';

export type TraceRowKind = 'thought' | 'tool' | 'memory' | 'heartbeat' | 'activity' | 'handoff' | 'retry' | 'approval' | 'usage' | 'source' | 'subagent';
export type SubAgentTraceStatus = 'starting' | 'working' | 'quiet' | 'waiting' | 'blocked' | 'returned' | 'failed' | 'stopped';

export interface SubAgentTraceDetails {
  agentId?: string;
  conversationId?: string;
  jobId?: string;
  taskIndex?: number;
  model?: string;
  runLocation?: string;
  isReviewer?: boolean;
  brief?: string;
  briefAt?: number;
  checkinAt?: number;
  checkinSummary?: string;
  report: string;
  startedAt?: number;
  endedAt?: number;
  noteAt?: number;
}

export type TraceRowStatus = SubAgentTraceStatus | 'ok' | 'failed' | 'waiting' | 'approved' | 'running';

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
  subagent?: SubAgentTraceDetails;
  payload?: TracePayload;
  anchorEntryId: string;
  at?: number;
}

export interface TraceTurn {
  id: string;
  anchorEntryId: string;
  rows: TraceRow[];
  usage?: { model?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number; durationLabel?: string };
}
