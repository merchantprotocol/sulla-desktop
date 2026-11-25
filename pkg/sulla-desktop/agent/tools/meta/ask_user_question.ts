// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * ask_user_question — pause the agent and ask the user one or more
 * multiple-choice questions. The chat transcript renders an interactive
 * card in For You. The tool returns its saved receipt immediately; the
 * actual answer is delivered later through the existing durable chat inbox.
 *
 * This is the single "pause and ask the human" tool. Use it when you need
 * the user to *choose* between concrete options, supply a small piece of
 * information, or give a yes/no go-ahead (offer Approve / Deny options)
 * before you can proceed. It is sent to EVERY model — not the Sulla CLI
 * catalog — so any provider can call it, and claude-code reciprocates its
 * own native AskUserQuestion through the matching MCP tool.
 */

import { BaseTool, type InputSchemaDef, type ToolResponse } from '../base';

import { decisionService } from '@pkg/agent/services/DecisionService';
import {
  formatQuestionReceipt,
  normalizeQuestions,
} from './askUserQuestionShared';

export class AskUserQuestionWorker extends BaseTool {
  name = 'ask_user_question';
  description = 'Save persistent questions in For You and return a receipt immediately. Chat askers receive answers through the chat inbox; delegated tasks are durably parked and receive answers through their job mailbox. End the current turn; do not infer consent or ask again while the decision is pending. Resume dependent work only after the answer arrives.';

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
    return { successBoolean: true, responseString: formatQuestionReceipt(record.id, ['queued', 'processing'].includes(record.answerDelivery ?? ''), parked) };
  }
}
