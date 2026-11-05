// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SystemClock } from '@sulla/foundation';
import { DesktopPostgresConnection } from '../Database/DesktopPostgresConnection';
import { AgentJobMessagingRepository } from '../Repositories/AgentJobMessagingRepository';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { ConversationTitleRepository } from '../Repositories/ConversationTitleRepository';
import { StrandedEpisodeRepository } from '../Repositories/StrandedEpisodeRepository';
import { AgentJobService } from '../Services/AgentJobService';
import { AgentFleetProjectionService } from '../Services/AgentFleetProjectionService';
import { AgentStateService } from '../Services/AgentStateService';
import { JobIdGenerator } from '../Services/JobIdGenerator';
import { JobRecoveryService } from '../Services/JobRecoveryService';
import { JobRuntimeRegistry } from '../Services/JobRuntimeRegistry';
import { JobTaskLocator } from '../Services/JobTaskLocator';
import { StrandedManagerAlertService } from '../Services/StrandedManagerAlertService';
import { StrandedManagerDetector } from '../Services/StrandedManagerDetector';
import { StrandedManagerScheduler } from '../Services/StrandedManagerScheduler';
import { RunActivityManagerActivitySource, type RunActivityReader } from '../Services/RunActivityManagerActivitySource';
import { JobStopService } from '../Services/JobStopService';
import { JobWrapUpService, type JobWrapUpMessageSender } from '../Services/JobWrapUpService';
import { JobCompletionDelivery } from '../../tools/agents/jobDelivery';
import { BlockerEscalationService } from '../../services/BlockerEscalationService';
import { completionInboxStore } from '../../services/AgentCompletionInbox';
import { postgresClient } from '../../database/PostgresClient';
import { RunActivity } from '../../services/RunActivity';

export class AgentJobServiceProvider {
  readonly jobs: AgentJobRepository;
  readonly messaging: AgentJobMessagingRepository;
  readonly runtime: JobRuntimeRegistry;
  readonly service: AgentJobService;
  readonly states: AgentStateService;
  readonly fleet: AgentFleetProjectionService;
  readonly stranded: StrandedManagerScheduler;
  readonly delivery: JobCompletionDelivery;
  readonly wrapUp: JobWrapUpService;
  readonly blockerEscalation: BlockerEscalationService;

  constructor(runActivity: RunActivityReader = RunActivity) {
    const connection = new DesktopPostgresConnection(postgresClient);
    this.jobs = new AgentJobRepository(connection);
    this.messaging = new AgentJobMessagingRepository(connection);
    this.blockerEscalation = new BlockerEscalationService(this.messaging, completionInboxStore);
    const clock = new SystemClock();
    this.runtime = new JobRuntimeRegistry();
    this.states = new AgentStateService(this.jobs, this.runtime);
    const titles = new ConversationTitleRepository(connection);
    const strandedEpisodes = new StrandedEpisodeRepository(connection);
    this.fleet = new AgentFleetProjectionService(this.states, this.messaging, titles, Date.now, strandedEpisodes);
    this.stranded = new StrandedManagerScheduler(this.fleet, new StrandedManagerDetector(Date.now, new RunActivityManagerActivitySource(runActivity)),
      strandedEpisodes, new StrandedManagerAlertService(completionInboxStore));
    const recovery = new JobRecoveryService(this.jobs);
    const taskLocator = new JobTaskLocator(this.jobs, this.runtime, recovery);
    const stops = new JobStopService(this.jobs, this.runtime, clock, taskLocator);
    const messages: JobWrapUpMessageSender = { send: async(input) => { const { sendJobMessage } = await import('../../tools/agents/send_job_message'); return sendJobMessage(input); } };
    this.wrapUp = new JobWrapUpService(stops, messages);
    this.service = new AgentJobService(this.jobs, this.runtime, recovery, clock, new JobIdGenerator(clock), taskLocator, this.states, stops);
    this.delivery = new JobCompletionDelivery(this.service);
  }
}

export const agentJobProvider = new AgentJobServiceProvider();
