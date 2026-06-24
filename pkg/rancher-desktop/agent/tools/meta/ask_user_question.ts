/**
 * ask_user_question — pause the agent and ask the user one or more
 * multiple-choice questions. The chat transcript renders an interactive
 * card (ToolQuestion.vue); the tool BLOCKS on a Promise parked in
 * ApprovalService until the user picks options (or types a free-form
 * answer) — or the timeout fires.
 *
 * This is the richer sibling of `request_user_input` (a binary
 * approve/deny gate). Use it when you need the user to *choose* between
 * concrete options or supply a small piece of information before you can
 * proceed. It is sent to EVERY model — not the Sulla CLI catalog — so any
 * provider can call it, and claude-code reciprocates its own native
 * AskUserQuestion through the matching MCP tool.
 */

import { BaseTool, type InputSchemaDef, type ToolResponse } from '../base';

import { ApprovalService } from '@pkg/agent/services/ApprovalService';
import {
  clampTimeout,
  formatQuestionResolution,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  normalizeQuestions,
} from './askUserQuestionShared';

export class AskUserQuestionWorker extends BaseTool {
  name = 'ask_user_question';
  description = 'Pause and ask the user one or more multiple-choice questions, then BLOCK until they answer in the chat (or the timeout elapses — default 5 min). Renders an interactive card with selectable options; the user may also type a free-form answer. Returns the selected option(s) per question. Use this whenever the next step depends on a decision only the user can make — picking between approaches, confirming an assumption, or supplying a missing detail. For a simple yes/no go-ahead, prefer request_user_input instead.';

  schemaDef: InputSchemaDef = {
    questions: {
      type:        'array',
      description: '1–4 questions to ask. Each renders as its own card with selectable options.',
      items:       {
        type:       'object',
        properties: {
          question:    { type: 'string', description: 'The full question text shown to the user.' },
          header:      { type: 'string', description: 'Short label/chip shown above the question (≤ ~12 chars), e.g. "Auth method".' },
          multiSelect: { type: 'boolean', description: 'Set true to let the user pick multiple options. Default false (single choice).' },
          options:     {
            type:        'array',
            description: '2–4 distinct options the user can choose from.',
            items:       {
              type:       'object',
              properties: {
                label:       { type: 'string', description: 'The option text the user selects.' },
                description: { type: 'string', description: 'Optional one-line explanation of what this option means or implies.' },
              },
            },
          },
        },
      },
    },
    timeoutMs: {
      type:        'number',
      optional:    true,
      description: `Timeout in milliseconds. Min ${ MIN_TIMEOUT_MS }, max ${ MAX_TIMEOUT_MS }, default 5 min. On timeout the tool resolves with no selection.`,
    },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { questions, error } = normalizeQuestions(input);
    if (error) {
      return { successBoolean: false, responseString: error };
    }

    const timeoutMs = clampTimeout(input?.timeoutMs);
    const service = ApprovalService.getInstance();
    const questionId = service.newQuestionId();

    // Emit the question card over the same WS pipeline chat messages use.
    // Content is intentionally empty — the structured payload rides on
    // `toolQuestion`. MessageDispatcher + PersonaAdapter turn this into a
    // ToolQuestionMessage in the transcript.
    const emitted = await this.emitMessage('', 'tool_question', {
      toolQuestion: { questionId, questions },
    });

    if (!emitted) {
      return {
        successBoolean: false,
        responseString: 'Failed to emit question card — WebSocket channel not ready. Make sure the tool is invoked inside an active chat turn.',
      };
    }

    const resolution = await service.parkQuestion(questionId, timeoutMs);

    return {
      successBoolean: true,
      responseString: formatQuestionResolution(questions, resolution, timeoutMs),
    };
  }
}
