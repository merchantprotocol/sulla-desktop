// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { InfrastructureFailure } from './WorkerResourcePreflight';

export interface ProcessFailureEvidence {
  error?: unknown;
  exitOutput?: string;
  lastLogLines?: string;
}

/** Parent-facing failure payload; the F-1 delivery hook can persist this without parsing prose. */
export interface InfrastructureTaskFailureResult {
  status: 'failed';
  failureType: 'infrastructure';
  summary: string;
}

export class InfrastructureFailureResultPresenter {
  present(failure: InfrastructureFailure): InfrastructureTaskFailureResult {
    return { status: 'failed', failureType: failure.failureType, summary: failure.reason };
  }
}

/** Resolves a running worker's process failure into the parent-facing result contract. */
export class RunningTaskInfrastructureFailureResolver {
  constructor(
    private readonly classifier: InfrastructureFailureClassifier,
    private readonly presenter: InfrastructureFailureResultPresenter,
  ) {}

  resolve(evidence: ProcessFailureEvidence): InfrastructureTaskFailureResult | undefined {
    const failure = this.classifier.classify(evidence);
    return failure ? this.presenter.present(failure) : undefined;
  }
}

/** Converts known machine failures into typed failures without mislabeling ordinary work errors. */
export class InfrastructureFailureClassifier {
  classify(evidence: ProcessFailureEvidence): InfrastructureFailure | undefined {
    if (evidence.error instanceof InfrastructureFailure) return evidence.error;
    const errors = this.errorChain(evidence.error);
    const text = [...errors.map(error => this.errorText(error)), evidence.exitOutput, evidence.lastLogLines]
      .filter(Boolean).join('\n');
    if (errors.some(error => this.hasDiskFullCode(error)) || this.isDiskFullText(text)) {
      return new InfrastructureFailure('infrastructure: disk full', { cause: evidence.error });
    }
    return undefined;
  }

  private hasDiskFullCode(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    const errno = typeof error === 'object' && error !== null && 'errno' in error ? String(error.errno) : '';
    return code === 'ENOSPC' || errno === 'ENOSPC' || errno === '-28';
  }

  private isDiskFullText(text: string): boolean {
    return /\bENOSPC\b|no space left on device|docker[^\n]*no space left|git[^\n]*no space left/i.test(text);
  }

  private errorChain(error: unknown): unknown[] {
    const chain: unknown[] = [];
    let current = error;
    for (let depth = 0; current !== undefined && depth < 5; depth++) {
      chain.push(current);
      if (typeof current !== 'object' || current === null) break;
      current = 'firstError' in current ? current.firstError : 'cause' in current ? current.cause : undefined;
    }
    return chain;
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? `${ error.name }: ${ error.message }` : error === undefined ? '' : String(error);
  }
}
