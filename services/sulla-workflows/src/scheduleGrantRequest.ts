export interface ScheduleGrantIssueInput {
  authorityId:     string | null;
  organizationId:  string | null;
  audience:        string;
  serviceId:       string;
  workflowId:      string;
  scheduleNodeId:  string;
  requiredRoles:   string[];
  expiresAt:       string;
  replaceGrantId?: string;
}

export interface ScheduleGrantIssueRequest {
  path: string;
  init: RequestInit;
  log:  Readonly<{
    operation:      'issue_schedule_grant';
    path:           string;
    workflowId:     string;
    scheduleNodeId: string;
    replacement:    boolean;
  }>;
}

const scheduleGrantIssuePath = '/v1/authority/schedule-grants';

/**
 * Keep the user's bearer in the Authorization header only. `log` is the complete
 * metadata callers may attach to diagnostics; neither it nor the JSON body can
 * expose the credential.
 */
export function scheduleGrantIssueRequest(
  input: ScheduleGrantIssueInput,
  bearerToken: string,
  serviceHeaders: Record<string, string>,
): ScheduleGrantIssueRequest {
  return {
    path: scheduleGrantIssuePath,
    init: {
      method:  'POST',
      headers: { ...serviceHeaders, Authorization: `Bearer ${ bearerToken }` },
      body:    JSON.stringify(input),
    },
    log: Object.freeze({
      operation:      'issue_schedule_grant',
      path:           scheduleGrantIssuePath,
      workflowId:     input.workflowId,
      scheduleNodeId: input.scheduleNodeId,
      replacement:    Boolean(input.replaceGrantId),
    }),
  };
}
