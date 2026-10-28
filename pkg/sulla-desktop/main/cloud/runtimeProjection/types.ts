// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { RunOutcome } from '@pkg/main/workflowRunSummaries';

export interface CloudWorkflowProjection {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: 'active' | 'paused' | 'waiting';
  deviceId: string;
  deviceName: string;
  trigger: { kind: string; label: string };
  nextRunAt: string | null;
  nextRunOn: string | null;
  runs: Array<{ executionId: string; outcome: RunOutcome; startedAt: string | null; completedAt: string | null; trigger: string }>;
  observedAt: string;
}

export interface CloudWorkflowRunProjection {
  executionId: string;
  workflowId: string;
  runNumber: number;
  outcome: RunOutcome;
  trigger: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  deviceId: string;
  deviceName: string;
  steps: Array<{ sequence: number; nodeId: string; label: string; subtype: string; outcome: RunOutcome; startedAt: string | null; completedAt: string | null; error: string | null }>;
}
