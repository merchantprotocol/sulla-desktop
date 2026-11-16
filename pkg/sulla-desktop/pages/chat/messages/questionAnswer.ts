// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * What a question card sends for one question. A single-choice question accepts exactly one answer,
 * so a typed note is folded into the chosen option instead of being sent as a second answer
 * (a second answer is rejected and the reply is lost).
 */
export function answerSelection(picked: readonly string[], other: string, multiSelect: boolean): string[] {
  const note = other.trim();
  if (multiSelect) return note ? [...picked, note] : [...picked];
  if (!picked.length) return note ? [note] : [];
  return [note ? `${ picked[0] } (${ note })` : picked[0]];
}
