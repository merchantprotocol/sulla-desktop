// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ContainerRuntimeDriver, ContainerSpec } from '@pkg/runtime/containerRuntime';
import type { SullaFilesBindPlan, SullaFilesBindPlanner } from './SullaFilesMountHealthProbe';
import type { IdempotentRetry } from './AgentContainerStartupRetry';

export const FAILED_CONTAINER_LOG_TAIL = 200;
export const FAILED_CONTAINER_SUFFIX = '-failed';

export interface AgentContainerDiagnosticRuntime extends ContainerRuntimeDriver {
  stop(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  logs(id: string, tail?: number): Promise<string>;
}

export interface AgentLaunchJobReporter {
  warning(message: string): Promise<void>;
  failure(message: string): Promise<void>;
}

export interface FailedContainerRecord {
  containerId: string;
  name:        string;
  reason:      string;
  logs:        string;
}

/** Coordinates the failure-sensitive Docker operations shared by both launcher entry points. */
export class AgentContainerLaunchCoordinator {
  constructor(
    private readonly runtime: ContainerRuntimeDriver,
    private readonly retry: IdempotentRetry,
    private readonly files: SullaFilesBindPlanner,
    private readonly reporter: AgentLaunchJobReporter,
  ) {}

  async filesPlan(): Promise<SullaFilesBindPlan> {
    const plan = await this.files.plan();
    if (plan.warning) await this.reporter.warning('Sulla Files unavailable for this run');
    return plan;
  }

  create(spec: ContainerSpec): Promise<string> {
    return this.runtime.create({ ...spec, autoRemove: false });
  }

  start(containerId: string, delaysMs: readonly number[], onRetry?: (message: string) => void): Promise<void> {
    return this.retry.run(() => this.runtime.start(containerId), delaysMs, 'agent container start', onRetry);
  }

  async removeNormal(containerId: string): Promise<void> {
    await this.runtime.remove(containerId, true);
  }

  async retainFailure(containerId: string, originalName: string, failure: unknown): Promise<FailedContainerRecord> {
    const runtime = this.diagnosticRuntime();
    const reason = failure instanceof Error ? failure.message : String(failure);
    await runtime.stop(containerId).catch(() => {});
    const name = await this.renameForFailure(runtime, containerId, originalName);
    const logs = await runtime.logs(containerId, FAILED_CONTAINER_LOG_TAIL).catch(error =>
      `[failed to capture container logs: ${ error instanceof Error ? error.message : String(error) }]`);
    // Docker labels are immutable. The existing com.sulla.job-id and com.sulla.workload=agent
    // labels remain the durable identity/retention marker; failure reason and logs live in the job record.
    await this.reporter.failure(`Agent container retained as ${ name }. Failure: ${ reason }\nLast ${ FAILED_CONTAINER_LOG_TAIL } log lines:\n${ logs }`);
    return { containerId, name, reason, logs };
  }

  private diagnosticRuntime(): AgentContainerDiagnosticRuntime {
    const runtime = this.runtime as Partial<AgentContainerDiagnosticRuntime>;
    if (!runtime.stop || !runtime.rename || !runtime.logs) {
      throw new Error('Container runtime does not support failed-container diagnostics');
    }
    return runtime as AgentContainerDiagnosticRuntime;
  }

  private async renameForFailure(runtime: AgentContainerDiagnosticRuntime, id: string, originalName: string): Promise<string> {
    const base = `${ originalName }${ FAILED_CONTAINER_SUFFIX }`;
    for (let suffix = 0; suffix < 100; suffix++) {
      const candidate = suffix === 0 ? base : `${ base }-${ suffix }`;
      try {
        await runtime.rename(id, candidate);
        return candidate;
      } catch (error) {
        if (!/already in use|conflict/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    throw new Error(`Unable to reserve a failed-container name for ${ originalName }`);
  }
}
