/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { AgentEditorCreateInput, AgentEditorPatch } from '../shared/agentEditor';

type ValidationErrorConstructor = new (message: string) => Error;

export class AgentAwarenessField {
  constructor(private readonly validationError: ValidationErrorConstructor) {}

  patch(record: Record<string, unknown>): Partial<Pick<AgentEditorPatch, 'agentAwareness'>> {
    const value = this.read(record);
    return value === undefined ? {} : { agentAwareness: value };
  }

  create(record: Record<string, unknown>): Pick<AgentEditorCreateInput, 'agentAwareness'> {
    return { agentAwareness: this.read(record) ?? true };
  }

  private read(record: Record<string, unknown>): boolean | undefined {
    if (!Object.prototype.hasOwnProperty.call(record, 'agentAwareness')) return undefined;
    const value = record.agentAwareness;
    if (typeof value !== 'boolean') {
      throw new this.validationError('agentAwareness must be a boolean.');
    }
    return value;
  }
}
