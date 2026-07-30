import { BaseTool, ToolResponse } from '../base';

const VALID_STATUSES = ['draft', 'production', 'archive'];

export class SetWorkflowStatusWorker extends BaseTool {
  name = 'set_workflow_status';
  description = 'Enable/disable a workflow or change its status (draft | production | archive) by id or exact name, then re-arm the scheduler so the change takes effect immediately — no restart required.';

  schemaDef = {
    id: {
      type:        'string' as const,
      optional:    true,
      description: 'Workflow id (as stored in the workflows table). Provide id or name.',
    },
    name: {
      type:        'string' as const,
      optional:    true,
      description: 'Exact workflow name (case-insensitive). Provide id or name.',
    },
    status: {
      type:        'string' as const,
      optional:    true,
      description: 'New status: draft | production | archive. Omit to leave unchanged.',
    },
    enabled: {
      type:        'boolean' as const,
      optional:    true,
      description: 'Set the enabled flag. Omit to leave unchanged.',
    },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { id, name, status, enabled } = input as {
      id?: string; name?: string; status?: string; enabled?: boolean;
    };

    if (!id && !name) {
      return { successBoolean: false, responseString: 'Provide "id" or "name" to identify the workflow.' };
    }
    if (status === undefined && enabled === undefined) {
      return { successBoolean: false, responseString: 'Nothing to change — provide "status" and/or "enabled".' };
    }
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return { successBoolean: false, responseString: `Invalid status "${ status }". Valid: ${ VALID_STATUSES.join(' | ') }.` };
    }

    const { postgresClient } = await import('@pkg/agent/database/PostgresClient');

    let rows: any[];
    try {
      rows = id
        ? await postgresClient.queryAll(`SELECT id, name, status, enabled FROM workflows WHERE id = $1`, [id])
        : await postgresClient.queryAll(`SELECT id, name, status, enabled FROM workflows WHERE LOWER(name) = LOWER($1)`, [name]);
    } catch (err) {
      return { successBoolean: false, responseString: `Workflow lookup failed: ${ (err as Error).message }` };
    }

    if (rows.length === 0) {
      return { successBoolean: false, responseString: `No workflow found for ${ id ? `id "${ id }"` : `name "${ name }"` }.` };
    }
    if (rows.length > 1) {
      const list = rows.map(r => `  • ${ r.name } (id: ${ r.id })`).join('\n');

      return { successBoolean: false, responseString: `Multiple workflows match — retry with "id":\n${ list }` };
    }

    const target = rows[0];
    const sets: string[] = [];
    const params: unknown[] = [];

    if (status !== undefined) {
      params.push(status);
      sets.push(`status = $${ params.length }`);
    }
    if (enabled !== undefined) {
      params.push(enabled);
      sets.push(`enabled = $${ params.length }`);
    }
    params.push(target.id);

    try {
      await postgresClient.query(
        `UPDATE workflows SET ${ sets.join(', ') }, updated_at = NOW() WHERE id = $${ params.length }`,
        params,
      );
    } catch (err) {
      return { successBoolean: false, responseString: `Update failed: ${ (err as Error).message }` };
    }

    // Re-arm immediately — same reason as import_workflow: the scheduler only
    // scans at boot and on UI save events.
    let armedLine = '';
    try {
      const { getWorkflowSchedulerService } = await import('@pkg/agent/services/WorkflowSchedulerService');
      const scheduler = getWorkflowSchedulerService();

      await scheduler.refresh();
      const jobs = scheduler.getScheduledJobs().filter(j => j.workflowId === target.id);

      armedLine = jobs.length > 0
        ? jobs.map(j => `  armed: cron "${ j.cronExpression }" ${ j.timezone } — next: ${ j.nextInvocation ?? 'none' }`).join('\n')
        : '  armed: no schedule trigger active for this workflow (not production+enabled, or no schedule node)';
    } catch (err) {
      armedLine = `  ⚠ scheduler refresh failed: ${ (err as Error).message }`;
    }

    return {
      successBoolean: true,
      responseString: [
        `✓ Workflow "${ target.name }" updated.`,
        `  status:  ${ target.status } → ${ status ?? target.status }`,
        `  enabled: ${ target.enabled } → ${ enabled ?? target.enabled }`,
        armedLine,
      ].join('\n'),
    };
  }
}
