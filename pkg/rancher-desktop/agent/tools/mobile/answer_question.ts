import { BaseTool, ToolResponse } from '../base';
import type { UserQuestionAnswerItem } from '../../services/ApprovalService';
import { AgentQuestionRegistry } from '../../services/AgentQuestionRegistry';

/**
 * Answer a pending agent question from the mobile surface.
 *
 * Claim-then-resolve (AgentQuestionRegistry.submitAnswer): the durable row is
 * atomically claimed pending -> answered first, and only a successful claim
 * resumes the live parked promise — so a double answer or a crash mid-submit
 * can never resume the asking thread twice. If the desktop restarted and no
 * live promise exists, the answer is still durably recorded. A store error is
 * reported as retryable.
 */
export class MobileAnswerQuestionWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      return { successBoolean: false, responseString: 'Missing required field: id (question id from list_questions).' };
    }

    // Same sanitization the desktop `question:resolve` IPC applies.
    const rawAnswers = Array.isArray(input.answers) ? input.answers : [];
    const answers: UserQuestionAnswerItem[] = rawAnswers
      .map((a: any) => ({
        question: typeof a?.question === 'string' ? a.question : '',
        selected: Array.isArray(a?.selected)
          ? a.selected.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
          : [],
      }))
      .filter((a: UserQuestionAnswerItem) => a.selected.length > 0);
    if (answers.length === 0) {
      return { successBoolean: false, responseString: 'answers must contain at least one { question, selected[] } item with a non-empty selection.' };
    }

    const answeredBy = typeof input.answered_by === 'string' && input.answered_by.trim()
      ? input.answered_by.trim()
      : null;

    try {
      const result = await AgentQuestionRegistry.submitAnswer(id, answers, { answeredBy, answeredVia: 'mobile' });
      if (result.persisted) {
        const resumed = result.routedLive
          ? 'the asking agent thread resumed immediately'
          : 'no live thread was waiting (desktop restarted) — the answer is durably recorded and picked up on resume';
        return { successBoolean: true, responseString: `Answer recorded for ${ id }; ${ resumed }.` };
      }
      switch (result.reason) {
      case 'already_settled':
        return { successBoolean: false, responseString: `Question ${ id } was already ${ result.question?.status ?? 'settled' } — this answer was not applied.` };
      case 'store_error':
        return { successBoolean: false, responseString: `Could not persist the answer for ${ id } (store unavailable). Nothing changed — retry shortly.` };
      default:
        return { successBoolean: false, responseString: `No pending question ${ id } is visible in this scope.` };
      }
    } catch (err) {
      return { successBoolean: false, responseString: `mobile/answer_question failed: ${ (err as Error).message }` };
    }
  }
}
