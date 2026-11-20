// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { classifyLLMFailure } from './providerRecovery';
import type { CliFaultError } from './cliFaultRecovery';

type DiagnosticLogger = (line: string) => void;

/** Emits only bounded identifiers, typed fault metadata and the safe recovery category. */
export class CodexFailureDiagnostics {
  constructor(private readonly write: DiagnosticLogger) {}

  retry(error: CliFaultError, attempt: number, conversationId: string, runId: string): void {
    this.write(this.serialize({
      event: 'retry', conversationId: this.correlationId(conversationId), runId: this.correlationId(runId),
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 0,
      fault: error.kind, category: classifyLLMFailure(error).kind,
      ...this.processStatus(error),
    }));
  }

  failure(input: {
    error: unknown;
    fault: CliFaultError['kind'];
    conversationId: string;
    runId: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
  }): void {
    this.write(this.serialize({
      event: 'failure', conversationId: this.correlationId(input.conversationId), runId: this.correlationId(input.runId),
      fault: input.fault, category: classifyLLMFailure(input.error).kind,
      exitCode: typeof input.exitCode === 'number' && Number.isInteger(input.exitCode) ? input.exitCode : null,
      signal: typeof input.signal === 'string' && /^SIG[A-Z0-9]+$/.test(input.signal) ? input.signal : null,
    }));
  }

  private serialize(fields: Record<string, unknown>): string {
    return `[CodexService][diagnostic] ${ JSON.stringify(fields) }`;
  }

  private correlationId(value: string): string {
    return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : 'invalid';
  }

  private processStatus(error: CliFaultError): { exitCode: number | null; signal: string | null } {
    let current: any = error;
    for (let depth = 0; current && depth < 8; depth++, current = current.cause) {
      if (typeof current.exitCode === 'number' || current.exitCode === null) {
        return {
          exitCode: typeof current.exitCode === 'number' && Number.isInteger(current.exitCode) ? current.exitCode : null,
          signal: typeof current.signal === 'string' && /^SIG[A-Z0-9]+$/.test(current.signal) ? current.signal : null,
        };
      }
    }
    return { exitCode: null, signal: null };
  }
}
