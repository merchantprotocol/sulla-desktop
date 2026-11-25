// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolQuestionMessage } from '../../models/Message';

export interface ToolQuestionSelectionSource {
  msg: ToolQuestionMessage;
  retainOptions?: boolean;
}

/** Keeps option-selection behavior in one instance owned by a question card. */
export class ToolQuestionSelection {
  constructor(
    private readonly source: () => ToolQuestionSelectionSource,
    private readonly picks: string[][],
    private readonly otherText: string[],
    private readonly customSelected: boolean[],
    private readonly isLocked: () => boolean,
  ) {}

  selectCustom(questionIndex: number, selected: boolean): void {
    const { msg } = this.source();
    if (this.isLocked()) return;
    this.customSelected[questionIndex] = selected;
    if (selected && !msg.questions[questionIndex].multiSelect) this.picks[questionIndex] = [];
  }

  customAnswer(questionIndex: number): string {
    return this.customSelected[questionIndex] ? (this.otherText[questionIndex] ?? '') : '';
  }

  isPicked(questionIndex: number, label: string): boolean {
    return this.selectedLabels(questionIndex).includes(label);
  }

  toggle(questionIndex: number, label: string, multi: boolean): void {
    if (this.isLocked()) return;
    if (!multi) this.customSelected[questionIndex] = false;
    const current = this.picks[questionIndex] ?? [];
    this.picks[questionIndex] = current.includes(label)
      ? current.filter(item => item !== label)
      : multi ? [...current, label] : [label];
  }

  private selectedLabels(questionIndex: number): readonly string[] {
    const { msg, retainOptions } = this.source();
    if (retainOptions && msg.status !== 'pending') {
      const question = msg.questions[questionIndex].question;
      return msg.answers?.find(answer => answer.question === question)?.selected ?? [];
    }
    return this.picks[questionIndex] ?? [];
  }
}
