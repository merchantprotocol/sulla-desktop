// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SystemClock } from '@sulla/foundation';
import { DesktopPostgresConnection } from '../Database/DesktopPostgresConnection';
import { AgentJobMessagingRepository } from '../Repositories/AgentJobMessagingRepository';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { AgentJobService } from '../Services/AgentJobService';
import { JobIdGenerator } from '../Services/JobIdGenerator';
import { JobRecoveryService } from '../Services/JobRecoveryService';
import { JobRuntimeRegistry } from '../Services/JobRuntimeRegistry';
import { JobTerminalObserver } from '../Services/JobTerminalObserver';
import { postgresClient } from '../../database/PostgresClient';

export class AgentJobServiceProvider {
  readonly jobs: AgentJobRepository;
  readonly messaging: AgentJobMessagingRepository;
  readonly runtime: JobRuntimeRegistry;
  readonly terminalTransitions: JobTerminalObserver;
  readonly service: AgentJobService;

  constructor() {
    const connection = new DesktopPostgresConnection(postgresClient);
    this.jobs = new AgentJobRepository(connection);
    this.messaging = new AgentJobMessagingRepository(connection);
    const clock = new SystemClock();
    this.runtime = new JobRuntimeRegistry();
    this.terminalTransitions = new JobTerminalObserver();
    this.service = new AgentJobService(this.jobs, this.runtime, new JobRecoveryService(this.jobs), clock, new JobIdGenerator(clock), this.terminalTransitions);
  }
}

export const agentJobProvider = new AgentJobServiceProvider();
