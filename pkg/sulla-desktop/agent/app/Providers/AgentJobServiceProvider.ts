// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SystemClock } from '@sulla/foundation';
import { DesktopPostgresConnection } from '../Database/DesktopPostgresConnection';
import { AgentJobMessagingRepository } from '../Repositories/AgentJobMessagingRepository';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { AgentJobCustodyRepository } from '../Repositories/AgentJobCustodyRepository';
import { AgentJobService } from '../Services/AgentJobService';
import { JobIdGenerator } from '../Services/JobIdGenerator';
import { JobRecoveryService } from '../Services/JobRecoveryService';
import { JobRuntimeRegistry } from '../Services/JobRuntimeRegistry';
import { JobTaskLocator } from '../Services/JobTaskLocator';
import { JobStopService } from '../Services/JobStopService';
import { JobCustodyService } from '../Services/JobCustodyService';
import { JobCustodyAuthorityPolicy } from '../Services/JobCustodyAuthorityPolicy';
import { JobTaskCustodyLineage, MainCustodyOwnerLiveness } from '../Services/MainCustodyOwnerLiveness';
import { CustodyActorResolver } from '../Services/CustodyActorResolver';
import { CustodyDestinationResolver } from '../Services/CustodyDestinationResolver';
import { CustodyChangeNotificationService } from '../Services/CustodyChangeNotificationService';
import { DurableAgentInboxReceiverResolver } from '../../services/AgentInboxReceiverResolver';
import { JobWrapUpService, type JobWrapUpMessageSender } from '../Services/JobWrapUpService';
import { postgresClient } from '../../database/PostgresClient';
import { JobCompletionDelivery } from '../../tools/agents/jobDelivery';
import { completionInboxStore } from '../../services/AgentCompletionInbox';
import { BlockerEscalationService } from '../../services/BlockerEscalationService';

export class AgentJobServiceProvider {
  readonly jobs: AgentJobRepository;
  readonly messaging: AgentJobMessagingRepository;
  readonly runtime: JobRuntimeRegistry;
  readonly service: AgentJobService;
  readonly delivery: JobCompletionDelivery;
  readonly wrapUp: JobWrapUpService;
  readonly blockerEscalation: BlockerEscalationService;
  readonly custody: JobCustodyService;
  readonly custodyActors: CustodyActorResolver;
  readonly custodyDestinations: CustodyDestinationResolver;
  readonly custodyLineage: JobTaskCustodyLineage;

  constructor() {
    const connection = new DesktopPostgresConnection(postgresClient);
    this.jobs = new AgentJobRepository(connection);
    this.messaging = new AgentJobMessagingRepository(connection);

    const clock = new SystemClock();
    this.runtime = new JobRuntimeRegistry();
    const recovery = new JobRecoveryService(this.jobs);
    const taskLocator = new JobTaskLocator(this.jobs, this.runtime, recovery);
    const custodyRepository = new AgentJobCustodyRepository(postgresClient);
    const graphPresence = { has: (_threadId: string) => false };
    const liveness = new MainCustodyOwnerLiveness(taskLocator, { isTerminal: status => !['queued', 'running', 'parked'].includes(status) }, graphPresence);
    this.custodyLineage = new JobTaskCustodyLineage(this.jobs, taskLocator);
    const custodyPolicy = new JobCustodyAuthorityPolicy(liveness, this.custodyLineage);
    this.custodyActors = new CustodyActorResolver();
    const receivers = new DurableAgentInboxReceiverResolver(this.jobs, () => undefined);
    this.custodyDestinations = new CustodyDestinationResolver(taskLocator, receivers, async channel => (await import('../../services/GraphRegistry')).GraphRegistry.findThreadByChannel(channel));
    const custodyNotifier = new CustodyChangeNotificationService(this.jobs, this.messaging, completionInboxStore);
    this.custody = new JobCustodyService(custodyRepository, custodyPolicy, custodyNotifier, clock);
    this.blockerEscalation = new BlockerEscalationService(this.messaging, completionInboxStore, this.custody);
    const stops = new JobStopService(this.jobs, this.runtime, clock, taskLocator, this.custody, this.custodyLineage);
    const messages: JobWrapUpMessageSender = { send: async(input) => { const { sendJobMessage } = await import('../../tools/agents/send_job_message'); return sendJobMessage(input); } };
    this.wrapUp = new JobWrapUpService(stops, messages);
    this.service = new AgentJobService(this.jobs, this.runtime, recovery, clock, new JobIdGenerator(clock), taskLocator, stops, this.wrapUp);
    this.delivery = new JobCompletionDelivery(this.service, this.custody);
  }
}

export const agentJobProvider = new AgentJobServiceProvider();
