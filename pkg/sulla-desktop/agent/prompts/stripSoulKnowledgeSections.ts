// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Environment/process passages that subject memory owns in v7.
 *
 * The soul row is editable human identity. We therefore remove bounded named
 * sections instead of replacing or summarizing the row, leaving every custom
 * line outside those sections untouched.
 */
export const STRIPPED_SOUL_HEADINGS = [
  'Platform Awareness',
  'VM Sandbox (exec tool)',
  "Your Human's files (Sulla Files)",
  'Where short-lived work goes',
  'Projects (plain files in Sulla Files)',
  'How you run real work: delegate → monitor → review → clean up',
  'How you grow',
] as const;

interface SectionBoundary {
  heading: string;
  endsAt: (line: string) => boolean;
}

function normalizedLine(line: string): string {
  return line.trim().replace(/^#{1,6}\s+/, '').replace(/:$/, '').trim();
}

function isHeading(line: string, heading: string): boolean {
  return normalizedLine(line).toLocaleLowerCase() === heading.replace(/:$/, '').toLocaleLowerCase();
}

const BOUNDARIES: SectionBoundary[] = [
  {
    heading: 'Platform Awareness',
    // The operator paragraphs are identity, not platform knowledge. Some older
    // soul rows place them before the next markdown heading, so stop there too.
    endsAt: line => /^(?:think of yourself as the executive function|\*\*you are an operator, not an observer\.\*\*|core identity & principles)/i.test(normalizedLine(line)),
  },
  {
    heading: 'VM Sandbox (exec tool)',
    endsAt: line => /^(?:you evolve\b|how you grow$)/i.test(normalizedLine(line)),
  },
  {
    heading: "Your Human's files (Sulla Files)",
    endsAt: line => /^(?:where short-lived work goes|projects \(plain files in sulla files\)|you’re a devoted partner|you're a devoted partner|execution framework)/i.test(normalizedLine(line)),
  },
  {
    heading: 'Where short-lived work goes',
    endsAt: line => /^(?:projects \(plain files in sulla files\)|you’re a devoted partner|you're a devoted partner|execution framework)/i.test(normalizedLine(line)),
  },
  {
    heading: 'Projects (plain files in Sulla Files)',
    endsAt: line => /^(?:you’re a devoted partner|you're a devoted partner|execution framework)/i.test(normalizedLine(line)),
  },
  {
    heading: 'How you run real work: delegate → monitor → review → clean up',
    endsAt: line => /^(?:4\.\s*first-principles thinking|first-principles thinking)/i.test(normalizedLine(line)),
  },
  {
    heading: 'How you grow',
    endsAt: line => /^(?:create a project folder\b|you’re a devoted partner|you're a devoted partner|execution framework)/i.test(normalizedLine(line)),
  },
];

export function stripSoulKnowledgeSections(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let active: SectionBoundary | undefined;

  for (const line of lines) {
    if (active) {
      if (!active.endsAt(line)) continue;
      active = undefined;
    }

    const boundary = BOUNDARIES.find(candidate => isHeading(line, candidate.heading));
    if (boundary) {
      active = boundary;
      // Avoid leaving the blank line immediately before a removed section.
      while (kept.at(-1) === '') kept.pop();
      continue;
    }
    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
