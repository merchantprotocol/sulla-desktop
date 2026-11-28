// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * ask_user_question — save one or more persistent decision questions. The
 * chat transcript renders an interactive card in For You. Plain questions
 * from delegated agents route to their parent first; the tool returns a
 * receipt immediately and the answer arrives later through the durable inbox.
 *
 * This is the single logical question tool exposed both as an in-process
 * graph tool and through the Sulla CLI catalog. Its caller identity is the
 * current graph/session, so a delegated child never asks as its root chat.
 */

import { BaseTool, type InputSchemaDef, type ToolResponse } from '../base';

import { decisionService } from '@pkg/agent/services/DecisionService';
import {
  formatQuestionReceipt,
  normalizeQuestions,
  QuestionReceiptPolicy,
} from './askUserQuestionShared';

export class AskUserQuestionWorker extends BaseTool {
  name = 'ask_user_question';
  description = 'Save persistent questions in For You and return a receipt. The human may answer any time. An agent in the delegation chain may also answer or pass plain questions when one is available; task questions require the human. Replies identify who answered. End this turn and wait; do not re-ask, infer consent, or continue dependent work.';

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
          task:        { type: 'boolean', description: 'Set true when you need the user to DO something you cannot (run a command on their Mac, set a secret, sign in, approve something outside Sulla). Renders a task card with a Done button; options default to Done.' },
          command:     { type: 'string', description: 'For a task: the exact shell command for the user to run, shown with a Copy button. Never include secret values.' },
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
      description: 'Legacy compatibility field. Questions no longer expire while waiting for the user.',
    },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { questions, error } = normalizeQuestions(input);
    if (error) {
      return { successBoolean: false, responseString: error };
    }

    const { record, reused, parked } = await decisionService.requestQuestion({
      title: questions[0].question, questions,
      conversationId: this.state?.metadata?.threadId || '',
      channel: this.state?.metadata?.wsChannel || '',
    }, this.state?.metadata?.options?.abort?.signal);
    if (!reused) await this.emitMessage('', 'tool_question', { toolQuestion: { questionId: record.id, questions } });
    return { successBoolean: true, responseString: formatQuestionReceipt(record.id, ['queued', 'processing'].includes(record.answerDelivery ?? ''), parked, new QuestionReceiptPolicy().parentMayAnswer(record)) };
  }
}
