// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface RecordedStartAttempt {
  attempt: number;
  message: string;
}

interface InternalAttempt extends RecordedStartAttempt {
  error: unknown;
}

interface AttemptGroup {
  message:  string;
  attempts: number[];
}

/**
 * Records every attempt of a retried operation so the operation's final failure can report the
 * first real error instead of only the last ("No such container" once `--rm` has already deleted
 * the container that actually failed to start).
 */
export class StartAttemptRecorder {
  private readonly recorded: InternalAttempt[] = [];

  record(attempt: number, error: unknown): void {
    this.recorded.push({ attempt, message: this.messageOf(error), error });
  }

  get firstError(): unknown {
    return this.recorded[0]?.error;
  }

  get attempts(): readonly RecordedStartAttempt[] {
    return this.recorded.map(({ attempt, message }) => ({ attempt, message }));
  }

  /**
   * The first attempt's real error first, then every later error distinct from it, deduped by
   * message and annotated with which attempts produced it. When the first error is not a missing-
   * container error but a later one is, the container clearly died mid-start and was cleaned up by
   * `--rm` before the retry could see why — the summary says so instead of only naming the symptom.
   */
  summary(): string {
    if (this.recorded.length === 0) return 'no start attempts were recorded';

    const groups = this.groupByMessage(this.recorded);
    const headline = groups.find(group => group.attempts.includes(this.recorded[0].attempt))!;
    const otherGroups = groups.filter(group => group !== headline);
    const headlineIsContainerGone = this.isMissingContainerError(headline.message);
    const laterIsContainerGone = otherGroups.some(group => this.isMissingContainerError(group.message));

    const headlineText = !headlineIsContainerGone && laterIsContainerGone
      ? `container exited during start and was removed: ${ headline.message }`
      : `${ this.describeAttempts(headline.attempts) }: ${ headline.message }`;

    return [headlineText, ...otherGroups.map(group => `${ this.describeAttempts(group.attempts) }: ${ group.message }`)]
      .join('; ');
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isMissingContainerError(message: string): boolean {
    return /no such container|is not running and was removed/i.test(message);
  }

  private groupByMessage(recorded: readonly RecordedStartAttempt[]): AttemptGroup[] {
    const groups: AttemptGroup[] = [];
    for (const { attempt, message } of recorded) {
      const existing = groups.find(group => group.message === message);
      if (existing) existing.attempts.push(attempt);
      else groups.push({ message, attempts: [attempt] });
    }
    return groups;
  }

  private describeAttempts(attempts: readonly number[]): string {
    const sorted = [...attempts].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const current = sorted[i];
      if (current === prev + 1) { prev = current; continue }
      ranges.push(start === prev ? `${ start }` : `${ start }-${ prev }`);
      if (current !== undefined) { start = current; prev = current }
    }
    return `${ sorted.length === 1 ? 'attempt' : 'attempts' } ${ ranges.join(', ') }`;
  }
}
