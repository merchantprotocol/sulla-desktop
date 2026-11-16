// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { useChatController } from '../controller/useChatController';
import type { Message, ToolQuestionItem, ToolQuestionMessage } from '../models/Message';

type ChatController = Pick<ReturnType<typeof useChatController>, 'answerQuestion' | 'send'>;

/**
 * A task Sulla asked the user to do (ask_user_question with `task: true`):
 * run a command, set a secret, sign in. One question, answered with Done or a
 * reply. Shared by the transcript card and the side column's Waiting on you.
 */
export class TaskAsks {
  static isTask(msg: Message): msg is ToolQuestionMessage {
    return msg.kind === 'tool_question' && msg.questions.length === 1 && msg.questions[0].task === true;
  }

  static item(msg: ToolQuestionMessage): ToolQuestionItem { return msg.questions[0] }

  /** The task's name: its header, else its question. */
  static title(msg: ToolQuestionMessage): string {
    const q = TaskAsks.item(msg);
    return q.header?.trim() || q.question;
  }

  /** Done: answers a waiting task; once Sulla stopped waiting, tells it in the chat instead. */
  static done(controller: ChatController, msg: ToolQuestionMessage): void {
    TaskAsks.answer(controller, msg, 'Done');
  }

  static reply(controller: ChatController, msg: ToolQuestionMessage, text: string): void {
    const said = text.trim();
    if (said) TaskAsks.answer(controller, msg, said);
  }

  private static answer(controller: ChatController, msg: ToolQuestionMessage, said: string): void {
    if (msg.status === 'pending') {
      controller.answerQuestion(msg.id, [{ question: TaskAsks.item(msg).question, selected: [said] }]);
      return;
    }
    controller.send(said === 'Done' ? `Done: ${ TaskAsks.title(msg) }` : `${ TaskAsks.title(msg) }: ${ said }`);
  }
}
