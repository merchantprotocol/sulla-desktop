import { BaseTool, ToolResponse } from '../base';

export class RefreshSchedulesWorker extends BaseTool {
  name = 'refresh_schedules';
  description = 'Force WorkflowSchedulerService to re-scan production workflows and re-arm all schedule triggers, then report what is actually armed. Use after any direct DB change to workflows, or to verify arming without grepping logs. No restart required.';

  schemaDef = {};

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const { getWorkflowManagerClient } = await import('../../services/WorkflowManagerClient');
      const manager = getWorkflowManagerClient();
      if (await manager.isHealthy(true)) {
        const result = await manager.request<{ schedules: any[] }>('POST', '/v1/schedules/refresh', {});
        return {
          successBoolean: true,
          responseString: `Workflow manager refreshed — ${ result.schedules.length } schedule trigger(s) armed:\n${ result.schedules.map(job => `  • ${ job.workflowName } — cron "${ job.cronExpression }" ${ job.timezone } — next: ${ job.nextInvocation ?? 'none' }`).join('\n') }`,
        };
      }
      manager.logFallback('schedule refresh');
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Workflow manager refused schedule refresh: ${ error instanceof Error ? error.message : String(error) }`,
      };
    }

    let scheduler;
    try {
      const { getWorkflowSchedulerService } = await import('@pkg/agent/services/WorkflowSchedulerService');

      scheduler = getWorkflowSchedulerService();
      await scheduler.refresh();
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Scheduler refresh failed: ${ (err as Error).message }`,
      };
    }

    const jobs = scheduler.getScheduledJobs();

    if (jobs.length === 0) {
      return {
        successBoolean: true,
        responseString: 'Scheduler refreshed — 0 schedule triggers armed. (Only enabled production workflows with a trigger/schedule node are scanned.)',
      };
    }

    const lines = jobs.map(j => `  • ${ j.workflowName } — cron "${ j.cronExpression }" ${ j.timezone } — next: ${ j.nextInvocation ?? 'none' }`);

    return {
      successBoolean: true,
      responseString: [
        `Scheduler refreshed — ${ jobs.length } schedule trigger(s) armed:`,
        ...lines,
      ].join('\n'),
    };
  }
}
