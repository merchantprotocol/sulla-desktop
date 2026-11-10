// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SystemClock } from '@sulla/foundation';
import { DesktopPostgresConnection } from '../Database/DesktopPostgresConnection';
import { AgentJobMessagingRepository } from '../Repositories/AgentJobMessagingRepository';
import { AgentJobReviewItemRepository } from '../Repositories/AgentJobReviewItemRepository';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { AgentJobCustodyRepository } from '../Repositories/AgentJobCustodyRepository';
import { JobWrapUpRepository } from '../Repositories/JobWrapUpRepository';
import { TaskExecutionIdentityRepository } from '../Repositories/TaskExecutionIdentityRepository';
import { ConversationTitleRepository } from '../Repositories/ConversationTitleRepository';
import { StrandedEpisodeRepository } from '../Repositories/StrandedEpisodeRepository';
import { CompletionAcknowledgementService } from '../Services/CompletionAcknowledgementService';
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
import { JobCustodyService } from '../Services/JobCustodyService';
import { CustodyCallerVerifier } from '../Services/CustodyCallerVerifier';
import { CustodyDestinationResolver } from '../Services/CustodyDestinationResolver';
import { DurableAgentInboxReceiverResolver } from '../../services/AgentInboxReceiverResolver';
import { GraphRegistry } from '../../services/GraphRegistry';
import { GraphRegistryTopLevelConversationRegistry } from '../Services/GraphRegistryTopLevelConversationRegistry';
import { JobCustodyAuthorityPolicy, TopLevelHumanSessionAuthorityRule } from '../Services/JobCustodyAuthorityPolicy';
import { JobTaskCustodyLineage, MainCustodyOwnerLiveness, MainStrandedOwnerDetector } from '../Services/MainCustodyOwnerLiveness';
import { CustodyChangeNotificationService } from '../Services/CustodyChangeNotificationService';
import { CustodyCompletionRequeueService } from '../Services/CustodyCompletionRequeueService';
import { JobWrapUpService, type JobWrapUpMessageSender } from '../Services/JobWrapUpService';
import { ConfirmedTaskTeardownService } from '../Services/ConfirmedTaskTeardownService';
import { PlatformTaskExecutionTerminationTransport } from '../Services/PlatformTaskExecutionTerminationTransport';
import { LaunchingTaskExecutionReconciler } from '../Services/LaunchingTaskExecutionReconciler';
import { JobCompletionDelivery } from '../../tools/agents/jobDelivery';
import { completionInboxStore } from '../../services/AgentCompletionInbox';
import { BlockerEscalationService } from '../../services/BlockerEscalationService';
import { postgresClient } from '../../database/PostgresClient';
import { RunActivity } from '../../services/RunActivity';
import { AgentTaskActivityProjector } from '../Services/AgentTaskActivityProjector';
import { ReviewObligationGate } from '../Services/ReviewObligationGate';

export class AgentJobServiceProvider {
  readonly jobs: AgentJobRepository;
  readonly messaging: AgentJobMessagingRepository;
  readonly reviewItems: AgentJobReviewItemRepository;
  readonly reviewGate: ReviewObligationGate;
  readonly runtime: JobRuntimeRegistry;
  readonly service: AgentJobService;
  readonly states: AgentStateService;
  readonly fleet: AgentFleetProjectionService;
  readonly activity: AgentTaskActivityProjector;
  readonly stranded: StrandedManagerScheduler;
  readonly completionAcknowledgements: CompletionAcknowledgementService;
  readonly completionRequeue: CustodyCompletionRequeueService;
  readonly delivery: JobCompletionDelivery;
  readonly wrapUp: JobWrapUpService;
  readonly executionIdentities: TaskExecutionIdentityRepository;
  readonly blockerEscalation: BlockerEscalationService;
  readonly custody: JobCustodyService;
  readonly custodyCallerVerifier: CustodyCallerVerifier;
  readonly custodyDestinations: CustodyDestinationResolver;
  readonly custodyLineage: JobTaskCustodyLineage;
  readonly recovery: JobRecoveryService;

  constructor(runActivity: RunActivityReader = RunActivity) {
    const connection = new DesktopPostgresConnection(postgresClient);
    this.jobs = new AgentJobRepository(connection);
    this.messaging = new AgentJobMessagingRepository(connection);
    this.reviewItems = new AgentJobReviewItemRepository(connection);
    this.reviewGate = new ReviewObligationGate(this.reviewItems);
    const clock = new SystemClock();
    this.runtime = new JobRuntimeRegistry();
    this.states = new AgentStateService(this.jobs, this.runtime);
    this.activity = new AgentTaskActivityProjector(runActivity);
    const titles = new ConversationTitleRepository(connection);
    const strandedEpisodes = new StrandedEpisodeRepository(connection);
    this.fleet = new AgentFleetProjectionService(this.states, this.messaging, titles, Date.now, strandedEpisodes, this.activity, this.reviewItems);
    const wrapUpRepository = new JobWrapUpRepository(postgresClient);
    this.executionIdentities = new TaskExecutionIdentityRepository(connection);
    const executionTransport = new PlatformTaskExecutionTerminationTransport();
    const taskTeardown = new ConfirmedTaskTeardownService(this.executionIdentities, executionTransport);
    const taskLocatorRecovery = new JobRecoveryService(this.jobs);
    const taskLocator = new JobTaskLocator(this.jobs, this.runtime, taskLocatorRecovery);
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
    this.stranded = new StrandedManagerScheduler(this.fleet, new StrandedManagerDetector(Date.now, new RunActivityManagerActivitySource(runActivity)),
      strandedEpisodes, new StrandedManagerAlertService(completionInboxStore, this.custody));
    const stops = new JobStopService(this.states, this.runtime, clock, taskLocator, this.custody, this.custodyLineage, taskTeardown, this.jobs);
    const inboxReceivers = new DurableAgentInboxReceiverResolver(this.jobs, channel => GraphRegistry.findThreadsByChannel(channel),this.custody);
    this.custodyDestinations = new CustodyDestinationResolver(taskLocator, inboxReceivers, async channel => GraphRegistry.findThreadByChannel(channel));
    const messages: JobWrapUpMessageSender = { send: async(input) => { const { sendJobMessage } = await import('../../tools/agents/send_job_message'); return sendJobMessage(input); } };
    this.wrapUp = new JobWrapUpService(stops, messages, undefined, wrapUpRepository, this.executionIdentities);
    const launchReconciler=new LaunchingTaskExecutionReconciler(this.executionIdentities,executionTransport);
    this.recovery = new JobRecoveryService(this.jobs,this.wrapUp,launchReconciler);
    this.service = new AgentJobService(this.jobs, this.runtime, this.recovery, clock, new JobIdGenerator(clock), taskLocator, this.states, stops, this.wrapUp);
    this.completionAcknowledgements = new CompletionAcknowledgementService(this.service, strandedEpisodes, completionInboxStore);
    this.completionRequeue = new CustodyCompletionRequeueService(completionInboxStore, this.custody);
    this.delivery = new JobCompletionDelivery(this.service, this.custody);
  }

  /** Boot hook invoked after migrations make durable recovery tables available. */
  start(): Promise<void> { return this.recovery.ensureHydrated(); }
}

export const agentJobProvider = new AgentJobServiceProvider();
