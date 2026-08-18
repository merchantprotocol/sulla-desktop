import { buildProjectReport } from '../../prompts/projectReport';
import { BaseTool, ToolResponse } from '../base';

/**
 * Standup report — what got done in the last N hours (default 24) and what's
 * next. Read-only. Shares its builder with the one-time report injected into
 * the orchestrating agent's first run (see prompts/projectReport.ts).
 */
export class ProjectReportWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const report = await buildProjectReport({
        hours:     typeof input.hours === 'number' ? input.hours : undefined,
        nextLimit: typeof input.next_limit === 'number' ? input.next_limit : undefined,
        projectId: input.project_id,
        assignee:  input.assignee,
      });

      return { successBoolean: true, responseString: report };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to build project report: ${ err?.message }` };
    }
  }
}
