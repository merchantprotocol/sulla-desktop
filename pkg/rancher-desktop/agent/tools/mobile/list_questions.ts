import { BaseTool, ToolResponse } from '../base';
import { AgentQuestionRegistry } from '../../services/AgentQuestionRegistry';

/**
 * List pending agent questions — the durable inbox behind `ask_user_question`
 * (agent_questions, migration 0078). This is the read surface a
 * mobile-originated chat uses to show the human what is still waiting on
 * them; results are scoped to the caller's profile, so an answerer only sees
 * questions scoped to them.
 */
export class MobileListQuestionsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(100, input.limit) : 20;

    try {
      const rows = await AgentQuestionRegistry.listInbox({ limit });
      if (rows.length === 0) {
        return { successBoolean: true, responseString: 'No pending questions — nothing is waiting on the user.' };
      }
      const lines = rows.map((q) => {
        const first = q.questions?.[0]?.question ?? '(no question text)';
        const extra = (q.questions?.length ?? 0) > 1 ? ` (+${ q.questions.length - 1 } more)` : '';
        const title = q.title ? `${ q.title }: ` : '';
        const from = q.agent ? ` from ${ q.agent }` : '';
        const task = q.task_id ? ` task:${ q.task_id }` : '';
        const expires = q.expires_at ? ` expires:${ q.expires_at }` : '';
        return `  [${ q.kind }] ${ title }${ first }${ extra } (id:${ q.id }${ from }${ task } asked:${ q.created_at }${ expires })`;
      });
      return {
        successBoolean: true,
        responseString: `${ rows.length } pending question(s), newest first:\n${ lines.join('\n') }\nUse mobile/get_question for full options, then mobile/answer_question to answer.`,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `mobile/list_questions failed: ${ (err as Error).message }` };
    }
  }
}
