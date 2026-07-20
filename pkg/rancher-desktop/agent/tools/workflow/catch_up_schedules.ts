import parser from 'cron-parser';

import { BaseTool, ToolResponse } from '../base';
import { SCHEDULE_TRIGGER } from '@pkg/pages/editor/workflow/types';

/**
 * catch_up_schedules — detect and recover missed scheduled fires.
 *
 * The scheduler only fires crons while the app is running with the schedule
 * armed. If the app was off (or the scheduler dormant) when a cron time
 * passed, the fire is silently skipped until the next occurrence — for a
 * weekly routine that's a whole week of drift.
 *
 * For every enabled production workflow with a schedule trigger, this tool
 * computes the previous expected fire time from the exact same cron the
 * scheduler arms, checks workflow_executions for a run since then, and
 * dispatches missed ones through the same executeRoutine path the cron
 * callback uses. Dispatch is fire-and-forget (routine runs can take
 * minutes); verify completion via the workflow_executions table.
 */
export class CatchUpSchedulesWorker extends BaseTool {
  name = 'catch_up_schedules';
  description = 'Detect scheduled workflow fires that were missed (app off or scheduler dormant when the cron time passed) and dispatch them through the real executor. Compares each armed schedule\'s previous expected fire time against workflow_executions. Use dryRun to report without firing.';

  schemaDef = {
    dryRun: {
      type:        'boolean' as const,
      optional:    true,
      description: 'Report missed fires without dispatching them. Default: false.',
    },
    lookbackDays: {
      type:        'number' as const,
      optional:    true,
      description: 'Only treat fires missed within this many days as recoverable. Default 7, max 31.',
    },
  };

  protected async _validatedCall(input: { dryRun?: boolean; lookbackDays?: number }): Promise<ToolResponse> {
    const dryRun = input.dryRun === true;
    const lookbackDays = Math.min(Math.max(Number(input.lookbackDays ?? 7), 1), 31);
    const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
    const now = new Date();

    // A scheduled fire can land a hair BEFORE its exact cron boundary (timer
    // coalescing / tick granularity): e.g. a Mon-04:00 cron observed firing at
    // 03:59:59.112 — 888ms early. Without a grace window the strict
    // `latestStart >= prevFire` comparison reads that perfectly on-time run as
    // "missed" and (outside dryRun) dispatches a DUPLICATE. Any two legitimate
    // fires of the same schedule are at least an hour apart, so a small grace
    // can never collapse two real fires into one.
    const FIRE_GRACE_MS = 60 * 1000;

    const { WorkflowModel } = await import('../../database/models/WorkflowModel');
    const { WorkflowExecutionModel } = await import('../../database/models/WorkflowExecutionModel');
    const { buildCronExpression } = await import('../../services/WorkflowSchedulerService');

    let rows: any[];
    try {
      rows = await WorkflowModel.listByStatus('production');
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Failed to load production workflows: ${ (err as Error).message }`,
      };
    }

    const lines: string[] = [];
    let missedCount = 0;
    let dispatchedCount = 0;

    for (const row of rows) {
      if (row.attributes.enabled === false) continue;

      const { id, name } = row.attributes;
      const definition = row.attributes.definition || {};
      const nodes = Array.isArray((definition as any).nodes) ? (definition as any).nodes : [];

      for (const node of nodes) {
        if (node?.data?.category !== SCHEDULE_TRIGGER.category || node?.data?.subtype !== SCHEDULE_TRIGGER.subtype) continue;

        const config = node.data?.config || {};
        const cron = buildCronExpression(config);
        if (!cron) {
          lines.push(`  • ${ name } — SKIP: could not build cron from schedule config`);
          continue;
        }
        const tz = (config.timezone as string || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;

        let prevFire: Date;
        try {
          prevFire = parser.parseExpression(cron, { tz, currentDate: now }).prev().toDate();
        } catch (err) {
          lines.push(`  • ${ name } — SKIP: cron "${ cron }" unparsable (${ (err as Error).message })`);
          continue;
        }

        if (now.getTime() - prevFire.getTime() > lookbackMs) {
          lines.push(`  • ${ name } — ok: last expected fire ${ prevFire.toISOString() } is outside the ${ lookbackDays }d lookback`);
          continue;
        }

        const latest = await WorkflowExecutionModel.findLatestByWorkflow(id);
        const latestStartRaw = latest?.attributes.started_at;
        const latestStart = latestStartRaw ? new Date(latestStartRaw) : null;

        if (latestStart && latestStart.getTime() >= prevFire.getTime() - FIRE_GRACE_MS) {
          lines.push(`  • ${ name } — ok: fired ${ latestStart.toISOString() } (expected ${ prevFire.toISOString() })`);
          continue;
        }

        missedCount++;

        const active = await WorkflowExecutionModel.findActiveByWorkflow(id);
        if (active) {
          lines.push(`  • ${ name } — MISSED ${ prevFire.toISOString() } but an execution is already active (${ (active.attributes as any).execution_id }) — skipped`);
          continue;
        }

        if (dryRun) {
          lines.push(`  • ${ name } — MISSED: expected ${ prevFire.toISOString() }, last run ${ latestStart?.toISOString() ?? 'never' } (dry-run, not dispatched)`);
          continue;
        }

        try {
          // Same entry point the cron callback uses. Fire-and-forget: routine
          // runs can take minutes and this tool must return promptly.
          const { executeRoutine } = await import('@pkg/main/sullaRoutineTemplateEvents');

          void executeRoutine(
            id,
            `Catch-up: the scheduled run of "${ name }" expected at ${ prevFire.toISOString() } was missed (app offline or scheduler dormant). Run it now.`,
          ).catch((err: unknown) => {
            console.error(`[CatchUpSchedules] Dispatched catch-up for "${ name }" failed:`, err);
          });
          dispatchedCount++;
          lines.push(`  • ${ name } — MISSED ${ prevFire.toISOString() } → DISPATCHED (verify via workflow_executions)`);
        } catch (err) {
          lines.push(`  • ${ name } — MISSED ${ prevFire.toISOString() } but dispatch failed: ${ (err as Error).message }`);
        }
      }
    }

    if (lines.length === 0) {
      return {
        successBoolean: true,
        responseString: 'No enabled production workflows with schedule triggers found — nothing to catch up.',
      };
    }

    const header = dryRun
      ? `Catch-up scan (dry-run): ${ missedCount } missed fire(s) found.`
      : `Catch-up scan: ${ missedCount } missed fire(s) found, ${ dispatchedCount } dispatched.`;

    return {
      successBoolean: true,
      responseString: [header, ...lines].join('\n'),
    };
  }
}
