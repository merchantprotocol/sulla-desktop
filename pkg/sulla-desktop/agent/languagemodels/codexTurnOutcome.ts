// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type CodexErrorKind = 'notice' | 'error';

/**
 * Codex CLI reports informational warnings (context-length advice, compaction
 * hints) through the same `error` event shapes it uses for real failures.
 * This classifier separates those notices so they are logged, not fatal.
 */
export class CodexNoticeClassifier {
  private static readonly PATTERNS: readonly RegExp[] = [
    /^\s*heads up:/i,
    /start a new thread/i,
    /compaction/i,
  ];

  isNotice(message: unknown): boolean {
    if (typeof message !== 'string' || !message.trim()) return false;
    return CodexNoticeClassifier.PATTERNS.some(pattern => pattern.test(message));
  }
}

/**
 * Tracks the terminal state of one `codex exec --json` turn.
 *
 * Fatal only when the turn itself failed (`turn.failed`) or an error or notice
 * event arrived and the turn never reached a successful completion. An error event
 * followed by `turn.completed` / `task_complete` is a warning, not a failure.
 */
export class CodexTurnOutcome {
  private sawErrorEvent = false;
  private sawNotice = false;
  private sawTurnFailed = false;
  private sawCompletion = false;

  constructor(private readonly classifier: CodexNoticeClassifier = new CodexNoticeClassifier()) {}

  /** Records an error event from any Codex schema shape. Returns how it was classified. */
  recordErrorEvent(message: unknown): CodexErrorKind {
    if (this.classifier.isNotice(message)) {
      this.sawNotice = true;
      return 'notice';
    }
    this.sawErrorEvent = true;
    return 'error';
  }

  recordTurnFailed(): void {
    this.sawTurnFailed = true;
  }

  recordCompletion(): void {
    this.sawCompletion = true;
  }

  get completed(): boolean {
    return this.sawCompletion;
  }

  get fatal(): boolean {
    // A notice is only harmless when the turn still completes: an error that
    // merely mentions compaction must not turn a failed turn into a success.
    return this.sawTurnFailed || ((this.sawErrorEvent || this.sawNotice) && !this.sawCompletion);
  }
}
