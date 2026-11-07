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
import { CustodyCallerVerifier } from '../Services/CustodyCallerVerifier';
import { CustodyDestinationResolver } from '../Services/CustodyDestinationResolver';
import { DurableAgentInboxReceiverResolver } from '../../services/AgentInboxReceiverResolver';
import { GraphRegistry } from '../../services/GraphRegistry';
import { GraphRegistryTopLevelConversationRegistry } from '../Services/GraphRegistryTopLevelConversationRegistry';
import { JobCustodyAuthorityPolicy, TopLevelHumanSessionAuthorityRule } from '../Services/JobCustodyAuthorityPolicy';
import { JobTaskCustodyLineage, MainCustodyOwnerLiveness, MainStrandedOwnerDetector } from '../Services/MainCustodyOwnerLiveness';
import { CustodyChangeNotificationService } from '../Services/CustodyChangeNotificationService';
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
  readonly custodyCallerVerifier: CustodyCallerVerifier;
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
    const graphPresence = { matches: async(owner: { channel:string; threadId:string; agentId:string }) => { const { GraphRegistry } = await import('../../services/GraphRegistry'); const entry=GraphRegistry.get(owner.threadId); if(!entry)return false; const metadata=entry.state.metadata as any; return String(metadata.wsChannel??'')===owner.channel&&String(metadata.agentId??metadata.agent?.id??metadata.wsChannel??'')===owner.agentId; } };
    const liveness = new MainCustodyOwnerLiveness(taskLocator, { isTerminal: status => !['queued', 'running', 'parked'].includes(status) }, graphPresence, new MainStrandedOwnerDetector(taskLocator,this.jobs));
    const topLevelConversations=new GraphRegistryTopLevelConversationRegistry();
    this.custodyCallerVerifier=new CustodyCallerVerifier(taskLocator,topLevelConversations);
    const topLevelSessions=new TopLevelHumanSessionAuthorityRule(topLevelConversations);
    this.custodyLineage = new JobTaskCustodyLineage(this.jobs, taskLocator,custodyRepository);
    const custodyPolicy = new JobCustodyAuthorityPolicy(liveness, this.custodyLineage,topLevelSessions);
    const custodyNotifier = new CustodyChangeNotificationService(this.jobs, completionInboxStore);
    this.custody = new JobCustodyService(custodyRepository, custodyPolicy, custodyNotifier, clock);
    this.blockerEscalation = new BlockerEscalationService(this.messaging, completionInboxStore, this.custody);
    const stops = new JobStopService(this.jobs, this.runtime, clock, taskLocator, this.custody, this.custodyLineage);
    const inboxReceivers = new DurableAgentInboxReceiverResolver(this.jobs, channel => GraphRegistry.findThreadsByChannel(channel),this.custody);
    this.custodyDestinations = new CustodyDestinationResolver(taskLocator, inboxReceivers, async channel => GraphRegistry.findThreadByChannel(channel));
    const messages: JobWrapUpMessageSender = { send: async(input) => { const { sendJobMessage } = await import('../../tools/agents/send_job_message'); return sendJobMessage(input); } };
    this.wrapUp = new JobWrapUpService(stops, messages);
    this.service = new AgentJobService(this.jobs, this.runtime, recovery, clock, new JobIdGenerator(clock), taskLocator, stops, this.wrapUp);
    this.delivery = new JobCompletionDelivery(this.service, this.custody);
  }
}

export const agentJobProvider = new AgentJobServiceProvider();
