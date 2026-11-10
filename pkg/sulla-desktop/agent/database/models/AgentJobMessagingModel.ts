// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';

export interface AgentJobTaskTarget {
  jobId:          string;
  taskIndex:      number;
  jobStatus:      string;
  taskStatus:     string;
  threadId?:      string;
  parentChannel?:  string;
  parentThreadId?: string;
  label?:          string;
}

export interface AgentJobMessage {
  id:         string;
  jobId:      string;
  taskIndex:  number;
  message:    string;
  createdAt:  number;
  deliveredAt?:  number;
}

export interface AgentJobCheckin {
  step:         string;
  summary:      string;
  filesTouched: string[];
  blockers:     string[];
  percent?:     number;
  createdAt:    number;
}

export interface AgentJobCheckinReceipt {
  target:          AgentJobTaskTarget;
  checkin:         AgentJobCheckin;
  blockersChanged: boolean;
}

export interface AgentJobTaskTelemetry {
  latestCheckin: AgentJobCheckin | null;
  checkins:      AgentJobCheckin[];
  undeliveredMessages: number;
  /** Latest delivery time of any orchestrator message to this task; resolves an earlier blocker. */
  lastMessageDeliveredAt?: number | null;
}

export class AgentJobMessagingModel {
  static readonly taskForThread = agentJobProvider.messaging.taskForThread.bind(agentJobProvider.messaging);
  static readonly targetsForJob = agentJobProvider.messaging.targetsForJob.bind(agentJobProvider.messaging);
  static readonly queueMessage = agentJobProvider.messaging.queueMessage.bind(agentJobProvider.messaging);
  static readonly pendingMessagesForThread = agentJobProvider.messaging.pendingMessagesForThread.bind(agentJobProvider.messaging);
  static readonly markMessagesDelivered = agentJobProvider.messaging.markMessagesDelivered.bind(agentJobProvider.messaging);
  static readonly appendCheckin = agentJobProvider.messaging.appendCheckin.bind(agentJobProvider.messaging);
  static readonly telemetryForJob = agentJobProvider.messaging.telemetryForJob.bind(agentJobProvider.messaging);
  static readonly latestTelemetryForJobs = agentJobProvider.messaging.latestTelemetryForJobs.bind(agentJobProvider.messaging);
}
