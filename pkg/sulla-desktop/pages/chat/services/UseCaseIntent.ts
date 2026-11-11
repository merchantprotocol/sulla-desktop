// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DeclaredUseCaseInput, SuggestedUseCase, UseCaseIntentMetadata } from '@pkg/shared/useCaseSuggestions';

import { UseCaseInputExtractor, UseCaseInputRequirements } from './UseCaseInputs';

export interface UseCaseIntentField extends DeclaredUseCaseInput { value: string }

/** The one removable chip attached to the next message. */
export interface UseCaseIntent {
  item:   SuggestedUseCase;
  fields: UseCaseIntentField[];
}

/** Builds an intent from a picked suggestion, prefilling declared inputs from the draft. */
export class UseCaseIntentFactory {
  constructor(private readonly extractor: UseCaseInputExtractor = new UseCaseInputExtractor()) {}

  create(item: SuggestedUseCase, draft: string): UseCaseIntent {
    const declared = item.type === 'workflow' || item.type === 'recipe' ? item.inputs ?? [] : [];
    const values = this.extractor.extract(draft, declared);

    return { item, fields: declared.map(input => ({ ...input, value: values[input.name] ?? '' })) };
  }
}

/**
 * Turns an intent into what the agent receives: a short visible directive
 * (the agent reads it in the message), structured metadata, and — for an
 * agent pick — the agent the turn routes to via the existing per-turn agentId.
 */
export class UseCaseIntentDirective {
  constructor(private readonly requirements: UseCaseInputRequirements = new UseCaseInputRequirements()) {}

  label(intent: UseCaseIntent): { verb: string; title: string } {
    const { type, title } = intent.item;
    if (type === 'skill') return { verb: 'Use skill:', title };
    if (type === 'agent') return { verb: 'Ask', title };

    return { verb: 'Run', title };
  }

  missing(intent: UseCaseIntent): string[] {
    return this.requirements.missingRequired(intent.fields, this.values(intent));
  }

  routeAgentId(intent: UseCaseIntent): string | undefined {
    return intent.item.type === 'agent' ? intent.item.slug : undefined;
  }

  metadata(intent: UseCaseIntent): UseCaseIntentMetadata {
    const { type, slug, title } = intent.item;
    const missing = this.missing(intent);

    return {
      type, slug, title,
      ...(intent.item.workflowId ? { workflowId: intent.item.workflowId } : {}),
      ...(intent.item.extensionId ? { extensionId: intent.item.extensionId } : {}),
      ...(intent.fields.length ? { inputs: this.values(intent) } : {}),
      ...(missing.length ? { missing } : {}),
    };
  }

  directive(intent: UseCaseIntent): string {
    const { type, slug, title } = intent.item;
    const json = (value: unknown) => JSON.stringify(value);
    switch (type) {
    case 'skill':
      return `[Use skill: ${ title }] Load it first with \`sulla skills/skill_get '${ json({ slug }) }'\` and follow it for this message.`;
    case 'agent':
      return `[Ask ${ title }] This message is addressed to the ${ json(slug) } agent.`;
    case 'workflow':
      return intent.item.workflowId
        ? `[Run ${ title }] Call execute_workflow with workflowId ${ json(intent.item.workflowId) }.${ this.inputClause(intent) }`
        : `[Run ${ title }] Find this workflow's exact slug in Available workflows, then call execute_workflow with that workflowId; do not guess it from the Files listing slug.${ this.inputClause(intent) }`;
    case 'recipe':
      return intent.item.extensionId
        ? `[Run ${ title }] Call start_extension with id ${ json(intent.item.extensionId) }.${ this.inputClause(intent) }`
        : `[Run ${ title }] Resolve this recipe to its exact installed extension id using list_installed_extensions, then call start_extension with that id; do not assume the Files listing slug is the extension id.${ this.inputClause(intent) }`;
    }
  }

  /** Message text the agent receives: directive line, then the user's words. */
  compose(intent: UseCaseIntent, text: string): string {
    return text.trim() ? `${ this.directive(intent) }\n\n${ text.trim() }` : this.directive(intent);
  }

  private inputClause(intent: UseCaseIntent): string {
    const values = Object.fromEntries(Object.entries(this.values(intent)).filter(([, v]) => v));
    const missing = this.missing(intent);
    const using = Object.keys(values).length ? ` using inputs ${ JSON.stringify(values) }` : '';
    const ask = missing.length ? ` Ask me for ${ missing.join(', ') } before running it.` : '';

    return `${ using }.${ ask }`;
  }

  private values(intent: UseCaseIntent): Record<string, string> {
    return Object.fromEntries(intent.fields.map(field => [field.name, field.value.trim()]));
  }
}
