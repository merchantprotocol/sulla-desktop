import { BaseTool, ToolResponse } from '../base';
import { AgentQuestionRegistry } from '../../services/AgentQuestionRegistry';

/**
 * Full detail for one pending/settled agent question — the card content a
 * mobile client renders: context, recommendation, risk, every question with
 * its options, and (once settled) the recorded answers. Scoped to the
 * caller's profile.
 */
export class MobileGetQuestionWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      return { successBoolean: false, responseString: 'Missing required field: id (question id from list_questions).' };
    }

    try {
      const q = await AgentQuestionRegistry.getQuestion(id);
      if (!q) {
        return { successBoolean: false, responseString: `No question ${ id } is visible in this scope.` };
      }

      const parts: string[] = [];
      parts.push(`Question ${ q.id } — ${ q.status } [${ q.kind }]`);
      if (q.title) parts.push(`Title: ${ q.title }`);
      if (q.agent) parts.push(`Asked by: ${ q.agent }`);
      parts.push(`Conversation: ${ q.conversation_id }${ q.task_id ? ` — task ${ q.task_id }` : '' }`);
      parts.push(`Asked at: ${ q.created_at }${ q.expires_at ? ` — expires ${ q.expires_at }` : '' }`);
      if (q.context) parts.push(`\nContext:\n${ q.context }`);
      if (q.recommendation) parts.push(`Recommendation: ${ q.recommendation }`);
      if (q.risk) parts.push(`Risk: ${ q.risk }`);
      for (const [i, uq] of (q.questions ?? []).entries()) {
        const opts = (uq.options ?? [])
          .map(o => `    - ${ o.label }${ o.description ? ` — ${ o.description }` : '' }`)
          .join('\n');
        parts.push(`\nQ${ i + 1 }${ uq.multiSelect ? ' (multi-select)' : '' }: ${ uq.question }\n${ opts }`);
      }
      if (q.status !== 'pending' && q.answers?.length) {
        const answered = q.answers.map(a => `  - ${ a.question }: ${ a.selected.join(', ') || '(none)' }`).join('\n');
        parts.push(`\nAnswered${ q.answered_by ? ` by ${ q.answered_by }` : '' }${ q.answered_via ? ` via ${ q.answered_via }` : '' } at ${ q.answered_at }:\n${ answered }`);
      }
      return { successBoolean: true, responseString: parts.join('\n') };
    } catch (err) {
      return { successBoolean: false, responseString: `mobile/get_question failed: ${ (err as Error).message }` };
    }
  }
}
