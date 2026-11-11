// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Shapes shared by the main-process suggestion query and the chat composer.
 * Functions are deliberately absent: Jonathon's rule is that the composer only
 * ever suggests skills, agents, workflows and recipes.
 */
export const SUGGESTABLE_USE_CASE_TYPES = ['skill', 'agent', 'workflow', 'recipe'] as const;
export type SuggestedUseCaseType = typeof SUGGESTABLE_USE_CASE_TYPES[number];

/** One input a workflow or recipe declares. */
export interface DeclaredUseCaseInput {
  name:      string;
  label?:    string;
  required?: boolean;
}

export interface SuggestedUseCase {
  type:        SuggestedUseCaseType;
  /** Canonical ids used by the runtime tools; these may differ from the Files listing slug. */
  slug:        string;
  workflowId?: string;
  extensionId?: string;
  title:       string;
  description: string;
  score:       number;
  reason:      string;
  /** Declared inputs, when the catalog knows them (workflows / recipes). */
  inputs?:     DeclaredUseCaseInput[];
}

export interface UseCaseSuggestionResponse {
  items: SuggestedUseCase[];
  ms:    number;
}

export function isSuggestableUseCaseType(type: unknown): type is SuggestedUseCaseType {
  return typeof type === 'string' && (SUGGESTABLE_USE_CASE_TYPES as readonly string[]).includes(type);
}

/** Structured intent sent with a chat message when the user picked a suggestion. */
export interface UseCaseIntentMetadata {
  type:     SuggestedUseCaseType;
  slug:     string;
  title:    string;
  workflowId?: string;
  extensionId?: string;
  inputs?:  Record<string, string>;
  missing?: string[];
}
