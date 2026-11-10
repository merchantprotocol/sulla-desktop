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

/** An open (not closed) tracked review obligation on a delegated task. */
export interface FleetReviewItemView {
  id: string;
  text: string;
  status: string;
}

export interface FleetTaskView {
  [key: string]: unknown;
  taskIndex: number;
  agentId: string;
  label: string;
  taskId?: string;
  status: string;
  lifecycleStatus?: string;
  state: string;
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
  wakeAt?: string | null;
  stranded?: { stateKey: string; detectedAt: number; reason: string; alertedAt: number } | null;
  promotedToTab?: boolean;
  requestedVisibility?: 'tab';
  downgradeReason?: string;
  /** Live tasks beneath this task's thread at any depth (grandchildren included). */
  descendantsRunning?: number;
  /** Open or acknowledged review items for this task; closed items are never listed. */
  openReviewItems?: FleetReviewItemView[];
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
  parentChannel?: string | null;
  parentJobId: string | null;
  parentTaskIndex: number | null;
  rootThreadId: string | null;
  tasks: FleetTaskView[];
  waitingOnChildren?: number;
  results?: Array<{ status?: string; output?: unknown; result?: unknown }>;
  error?: string;
}
