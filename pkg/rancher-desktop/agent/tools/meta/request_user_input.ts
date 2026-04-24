/**
 * request_user_input — pause the agent and ask the user for an approve/deny
 * decision. The chat transcript renders an inline approval card; the tool
 * blocks on a Promise parked in ApprovalService until the user clicks a
 * button or the timeout fires.
 *
 * This is the generic gate the agent can invoke anywhere it wants explicit
 * user consent (or just a go/no-go on an ambiguous decision). Phase-2 work
 * will add dedicated gates for tool execution, workflow nodes, vault reads,
 * and function runs — each backed by the same ApprovalService primitive this
 * tool uses.
 */

import { BaseTool, type ToolResponse } from '../base';

import { ApprovalService } from '@pkg/agent/services/ApprovalService';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_TIMEOUT_MS = 5 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

export class RequestUserInputWorker extends BaseTool {
  name = 'request_user_input';
  description = 'Pause and ask the user for an approve/deny decision before proceeding. Renders a prompt in the chat transcript and BLOCKS until the user clicks Approve or Deny (or the timeout elapses — default 5 min). Returns {decision: "approved" | "denied" | "timed_out", note?}. Use whenever you need explicit consent for a risky or reversible action, OR whenever the next step is ambiguous and you want the user to pick. Do NOT use for free-form questions — this is a binary gate, not a question-asker.';

  schemaDef = {
    question: {
      type:        'string' as const,
      description: 'One-line user-facing description of what you want approval for. Rendered as the card headline (the "reason"). Phrase it as a neutral summary, not a loaded yes/no. Example: "Delete the draft routine `blog-publisher-v2`?"',
    },
    command: {
      type:        'string' as const,
      optional:    true,
      description: 'The exact action / command / payload the user is approving. Rendered in a mono-font block under the question for transparency. Example: "sulla workflow/import_workflow {\\"slug\\":\\"...\\",\\"status\\":\\"production\\"}". Omit when the action is obvious from the question.',
    },
    timeoutMs: {
      type:        'number' as const,
      optional:    true,
      description: `Timeout in milliseconds. Min ${ MIN_TIMEOUT_MS }, max ${ MAX_TIMEOUT_MS }, default ${ DEFAULT_TIMEOUT_MS } (5 minutes). If the user doesn't respond in time, the tool resolves as "timed_out" — treat that as a soft deny.`,
    },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const question: string = typeof input?.question === 'string' ? input.question.trim() : '';
    const command: string = typeof input?.command === 'string' ? input.command.trim() : question;
    const rawTimeout = Number(input?.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, rawTimeout))
      : DEFAULT_TIMEOUT_MS;

    if (!question) {
      return {
        successBoolean: false,
        responseString: 'request_user_input: `question` is required.',
      };
    }

    const service = ApprovalService.getInstance();
    const approvalId = service.newApprovalId();
    const origin = { kind: 'request_user_input' as const };

    // Emit the approval card over the same WS pipeline chat messages use.
    // Content is intentionally empty — reason/command live on the
    // structured `toolApproval` payload. MessageDispatcher +
    // PersonaAdapter turn this into a ToolApprovalMessage in the
    // transcript.
    const emitted = await this.emitMessage('', 'tool_approval', {
      toolApproval: {
        approvalId,
        reason:  question,
        command: command || question,
        origin,
      },
    });

    if (!emitted) {
      return {
        successBoolean: false,
        responseString: 'Failed to emit approval card — WebSocket channel not ready. Make sure the tool is invoked inside an active chat turn.',
      };
    }

    const decision = await service.parkPending(approvalId, origin, timeoutMs);

    // Return a deterministic shape the agent can branch on.
    const human = decision.decision === 'approved'
      ? 'User approved.'
      : decision.decision === 'denied'
        ? 'User denied.'
        : `User did not respond within ${ Math.round(timeoutMs / 1000) }s (treat as soft deny).`;

    return {
      successBoolean: true,
      responseString: [
        human,
        `decision: ${ decision.decision }`,
        decision.note ? `note: ${ decision.note }` : null,
      ].filter(Boolean).join('\n'),
    };
  }
}
