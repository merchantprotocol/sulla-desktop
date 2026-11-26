// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SystemClock } from '@sulla/foundation';
import Logging from '@pkg/utils/logging';
import { DesktopPostgresConnection } from '../Database/DesktopPostgresConnection';
import { AgentJobMessagingRepository } from '../Repositories/AgentJobMessagingRepository';
import { AgentJobReviewItemRepository } from '../Repositories/AgentJobReviewItemRepository';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { AgentJobChildrenQuery } from '../Repositories/AgentJobChildrenQuery';
import { ConversationTitleRepository } from '../Repositories/ConversationTitleRepository';
import { StrandedEpisodeRepository } from '../Repositories/StrandedEpisodeRepository';
import { CompletionAcknowledgementService } from '../Services/CompletionAcknowledgementService';
import { AgentJobService } from '../Services/AgentJobService';
import { AgentFleetProjectionService } from '../Services/AgentFleetProjectionService';
import { AgentJobFailureLogger } from '../Services/AgentJobFailureLogger';
import { AgentJobMutationQueue, AgentStateService } from '../Services/AgentStateService';
import { JobIdGenerator } from '../Services/JobIdGenerator';
import { JobRecoveryService } from '../Services/JobRecoveryService';
import { JobRuntimeRegistry } from '../Services/JobRuntimeRegistry';
import { JobTaskLocator } from '../Services/JobTaskLocator';
import { StrandedManagerAlertService } from '../Services/StrandedManagerAlertService';
import { StrandedManagerDetector } from '../Services/StrandedManagerDetector';
import { StrandedManagerScheduler } from '../Services/StrandedManagerScheduler';
import { RunActivityManagerActivitySource, type RunActivityReader } from '../Services/RunActivityManagerActivitySource';
import { JobStopService } from '../Services/JobStopService';
import { ActiveThreadRunRegistry } from '../Services/ActiveThreadRunRegistry';
import { JobWrapUpService, type JobWrapUpMessageSender } from '../Services/JobWrapUpService';
import { JobCompletionDelivery } from '../../tools/agents/jobDelivery';
import { completionInboxStore } from '../../services/AgentCompletionInbox';
import { BlockerEscalationService } from '../../services/BlockerEscalationService';
import { postgresClient } from '../../database/PostgresClient';
import { RunActivity } from '../../services/RunActivity';
import { GraphRegistry } from '../../services/GraphRegistry';
import { AgentTaskActivityProjector } from '../Services/AgentTaskActivityProjector';
import { ReviewObligationGate } from '../Services/ReviewObligationGate';
import { resolveAgentIdentity } from '../../utils/agentIdentity';
import { AgentJobCustodyRepository } from '../Repositories/AgentJobCustodyRepository';
import { JobCustodyService } from '../Services/JobCustodyService';
import { JobCustodyAuthorityPolicy, TopLevelHumanSessionAuthorityRule } from '../Services/JobCustodyAuthorityPolicy';
import { CustodyCallerVerifier } from '../Services/CustodyCallerVerifier';
import { GraphRegistryTopLevelConversationRegistry } from '../Services/GraphRegistryTopLevelConversationRegistry';
import { GraphRegistryOwnerPresence } from '../Services/GraphRegistryOwnerPresence';
import { JobTaskCustodyLineage, MainCustodyOwnerLiveness, MainStrandedOwnerDetector } from '../Services/MainCustodyOwnerLiveness';
import { NoopCustodyChangeNotifier } from '../Services/JobCustodyTypes';
import { agentWorkSleepPrevention, AgentWorkSleepPrevention } from '../Services/AgentWorkSleepPrevention';

export class AgentJobServiceProvider {
  readonly jobs: AgentJobRepository;
  readonly children: AgentJobChildrenQuery;
  readonly messaging: AgentJobMessagingRepository;
  readonly reviewItems: AgentJobReviewItemRepository;
  readonly reviewGate: ReviewObligationGate;
  readonly runtime: JobRuntimeRegistry;
  readonly service: AgentJobService;
  readonly states: AgentStateService;
  readonly workSleepPrevention: AgentWorkSleepPrevention;
  readonly fleet: AgentFleetProjectionService;
  readonly activity: AgentTaskActivityProjector;
  readonly stranded: StrandedManagerScheduler;
  readonly completionAcknowledgements: CompletionAcknowledgementService;
  readonly delivery: JobCompletionDelivery;
  readonly wrapUp: JobWrapUpService;
  readonly blockerEscalation: BlockerEscalationService;
  readonly custody: JobCustodyService;
  readonly custodyCallerVerifier: CustodyCallerVerifier;
  readonly custodyLineage: JobTaskCustodyLineage;
  readonly activeThreadRuns = new ActiveThreadRunRegistry();

  constructor(runActivity: RunActivityReader = RunActivity) {
    const connection = new DesktopPostgresConnection(postgresClient);
    this.jobs = new AgentJobRepository(connection);
    this.children = new AgentJobChildrenQuery(connection);
    this.messaging = new AgentJobMessagingRepository(connection);
    this.reviewItems = new AgentJobReviewItemRepository(connection);
    this.reviewGate = new ReviewObligationGate(this.reviewItems);
    this.blockerEscalation = new BlockerEscalationService(this.messaging, completionInboxStore);
    const clock = new SystemClock();
    this.runtime = new JobRuntimeRegistry();
    this.states = new AgentStateService(this.jobs, this.runtime, Date.now, new AgentJobMutationQueue(), new AgentJobFailureLogger({ error: message => Logging.background.error(message) }));
    this.workSleepPrevention = agentWorkSleepPrevention;
    this.activity = new AgentTaskActivityProjector(runActivity);
    const titles = new ConversationTitleRepository(connection);
    const strandedEpisodes = new StrandedEpisodeRepository(connection);
    this.fleet = new AgentFleetProjectionService(this.states, this.messaging, titles, Date.now, strandedEpisodes, this.activity, this.reviewItems);
    this.stranded = new StrandedManagerScheduler(this.fleet, new StrandedManagerDetector(Date.now, new RunActivityManagerActivitySource(runActivity)),
      strandedEpisodes, new StrandedManagerAlertService(completionInboxStore));
    const recovery = new JobRecoveryService(this.jobs);
    const taskLocator = new JobTaskLocator(this.jobs, this.runtime, recovery);
    const custodyRepository = new AgentJobCustodyRepository(postgresClient);
    const conversations = new GraphRegistryTopLevelConversationRegistry();
    const ownerPresence = new GraphRegistryOwnerPresence({ get: threadId => GraphRegistry.get(threadId) ?? undefined });
    const liveness = new MainCustodyOwnerLiveness(taskLocator, { isTerminal: status => ['completed','blocked','error','stopped','lost'].includes(status) },
      { matches: async owner => ownerPresence.matches(owner) }, new MainStrandedOwnerDetector(taskLocator, this.jobs));
    this.custodyLineage = new JobTaskCustodyLineage(this.jobs, taskLocator, custodyRepository);
    const custodyPolicy = new JobCustodyAuthorityPolicy(liveness, this.custodyLineage, new TopLevelHumanSessionAuthorityRule(conversations));
    this.custody = new JobCustodyService(custodyRepository, custodyPolicy, new NoopCustodyChangeNotifier(), clock);
    this.custodyCallerVerifier = new CustodyCallerVerifier(taskLocator, conversations);
    const stops = new JobStopService(this.states, this.runtime, clock, taskLocator, this.activeThreadRuns);
    const messages: JobWrapUpMessageSender = { send: async(input) => { const { sendJobMessage } = await import('../../tools/agents/send_job_message'); return sendJobMessage(input); } };
    this.wrapUp = new JobWrapUpService(stops, messages);
    this.service = new AgentJobService(this.jobs, this.runtime, recovery, clock, new JobIdGenerator(clock), taskLocator, this.states, stops, this.wrapUp);
    this.completionAcknowledgements = new CompletionAcknowledgementService(this.service, strandedEpisodes, completionInboxStore);
    this.delivery = new JobCompletionDelivery(this.service);
  }
}

export const agentJobProvider = new AgentJobServiceProvider();
