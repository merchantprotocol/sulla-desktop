// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Persisted compact check-in fields shared by fleet presenters. */
export interface FleetCheckinView {
  step: string;
  summary: string;
  blockers: string[];
  percent?: number;
  time: string;
}

export interface FleetTaskView {
  [key: string]: unknown;
  taskIndex: number;
  agentId: string;
  label: string;
  taskId?: string;
  status: string;
  returned: boolean;
  startedAt: string;
  finishedAt: string | null;
  returnedAt: string | null;
  completionDeliveredAt: string | null;
  lastActivityAt: string;
  threadId: string | null;
  parentJobId: string | null;
  parentTaskIndex: number | null;
  rootThreadId: string | null;
  latestCheckin: FleetCheckinView | null;
  result?: unknown;
  completion?: unknown;
}

export interface FleetJobView {
  [key: string]: unknown;
  jobId: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  parentThreadId: string | null;
  parentJobId: string | null;
  parentTaskIndex: number | null;
  rootThreadId: string | null;
  tasks: FleetTaskView[];
  results?: Array<{ status?: string; output?: unknown; result?: unknown }>;
  error?: string;
}
