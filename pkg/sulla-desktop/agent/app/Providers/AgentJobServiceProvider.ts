// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SystemClock } from '@sulla/foundation';
import { DesktopPostgresConnection } from '../Database/DesktopPostgresConnection';
import { AgentJobMessagingRepository } from '../Repositories/AgentJobMessagingRepository';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { AgentJobService } from '../Services/AgentJobService';
import { AgentStateService } from '../Services/AgentStateService';
import { JobIdGenerator } from '../Services/JobIdGenerator';
import { JobRecoveryService } from '../Services/JobRecoveryService';
import { JobRuntimeRegistry } from '../Services/JobRuntimeRegistry';
import { JobTaskLocator } from '../Services/JobTaskLocator';
import { postgresClient } from '../../database/PostgresClient';

export class AgentJobServiceProvider {
  readonly jobs: AgentJobRepository;
  readonly messaging: AgentJobMessagingRepository;
  readonly runtime: JobRuntimeRegistry;
  readonly service: AgentJobService;
  readonly states: AgentStateService;

  constructor() {
    const connection = new DesktopPostgresConnection(postgresClient);
    this.jobs = new AgentJobRepository(connection);
    this.messaging = new AgentJobMessagingRepository(connection);
    const clock = new SystemClock();
    this.runtime = new JobRuntimeRegistry();
    this.states = new AgentStateService(this.jobs, this.runtime);
    const recovery = new JobRecoveryService(this.jobs);
    const taskLocator = new JobTaskLocator(this.jobs, this.runtime, recovery);
    this.service = new AgentJobService(this.jobs, this.runtime, recovery, clock, new JobIdGenerator(clock), taskLocator, this.states);
  }
}

export const agentJobProvider = new AgentJobServiceProvider();
