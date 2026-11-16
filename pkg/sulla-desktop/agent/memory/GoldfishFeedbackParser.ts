// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const GOLDFISH_ISSUE_KINDS = [
  'missing_episode', 'missing_item', 'unsupported_item', 'wrong_item', 'vague_text',
  'missing_keys', 'missing_refs', 'missing_evidence', 'contradiction', 'other',
] as const;

export interface GoldfishIssue {
  kind:   typeof GOLDFISH_ISSUE_KINDS[number];
  target: string | null;
  note:   string;
}

export interface GoldfishFeedback {
  issues: GoldfishIssue[];
}

/** Strict parser for goldfish's JSON. Returns null when the output is not usable feedback. */
export class GoldfishFeedbackParser {
  static readonly MAX_ISSUES = 30;

  parse(response: string | null): GoldfishFeedback | null {
    if (!response) return null;
    let raw: unknown;
    try {
      const trimmed = response.trim();
      const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      raw = JSON.parse(fenced?.[1] ?? trimmed);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).issues)) return null;
    const kinds = new Set<string>(GOLDFISH_ISSUE_KINDS);
    const issues: GoldfishIssue[] = [];
    for (const value of (raw as any).issues.slice(0, GoldfishFeedbackParser.MAX_ISSUES)) {
      if (!value || typeof value !== 'object') continue;
      const note = typeof value.note === 'string' ? value.note.trim().slice(0, 1000) : '';
      if (!note) continue;
      issues.push({
        kind:   kinds.has(value.kind) ? value.kind : 'other',
        target: typeof value.target === 'string' && value.target.trim() ? value.target.trim().slice(0, 80) : null,
        note,
      });
    }
    return { issues };
  }
}
