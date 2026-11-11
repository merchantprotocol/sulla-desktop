// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import type { SuggestedUseCase } from '@pkg/shared/useCaseSuggestions';
import { UseCaseIntentDirective, UseCaseIntentFactory } from '@pkg/pages/chat/services/UseCaseIntent';

const factory = new UseCaseIntentFactory();
const directive = new UseCaseIntentDirective();
const uc = (type: SuggestedUseCase['type'], extra: Partial<SuggestedUseCase> = {}): SuggestedUseCase =>
  ({ type, slug: `${ type }-slug`, title: `${ type } title`, description: '', score: 0.9, reason: '', ...extra });

describe('UseCaseIntentDirective (routing on send)', () => {
  it('routes only agent picks to that agent', () => {
    expect(directive.routeAgentId(factory.create(uc('agent', { slug: 'inbox-manager' }), 'reply to Ana'))).toBe('inbox-manager');
    expect(directive.routeAgentId(factory.create(uc('skill'), 'x'))).toBeUndefined();
    expect(directive.routeAgentId(factory.create(uc('workflow'), 'x'))).toBeUndefined();
  });

  it('tells the agent to load a picked skill with skill_get', () => {
    const text = directive.compose(factory.create(uc('skill', { slug: 'summarize-sheet', title: 'Summarise a spreadsheet' }), ''), 'summarise the leads');
    expect(text).toContain(`sulla skills/skill_get '{"slug":"summarize-sheet"}'`);
    expect(text.endsWith('summarise the leads')).toBe(true);
  });

  it('prefills workflow inputs from the draft and asks for missing required ones before running', () => {
    const draft = 'weekly digest of the "Sweeps Leads" sheet for the last 7 days';
    const intent = factory.create(uc('workflow', {
      slug:   'weekly-lead-digest',
      inputs: [{ name: 'sheet', required: true }, { name: 'period' }, { name: 'recipient', required: true }],
    }), draft);

    expect(intent.fields.map(f => [f.name, f.value])).toEqual([['sheet', 'Sweeps Leads'], ['period', 'last 7 days'], ['recipient', '']]);
    expect(directive.metadata(intent)).toEqual({
      type: 'workflow', slug: 'weekly-lead-digest', title: 'workflow title',
      inputs: { sheet: 'Sweeps Leads', period: 'last 7 days', recipient: '' },
      missing: ['recipient'],
    });
    const text = directive.directive(intent);
    expect(text).toContain('Available workflows');
    expect(text).toContain('{"sheet":"Sweeps Leads","period":"last 7 days"}');
    expect(text).toContain('Ask me for recipient before running it.');

    intent.fields[2].value = 'ana@acme.co';
    expect(directive.metadata(intent).missing).toBeUndefined();
    expect(directive.directive(intent)).not.toContain('Ask me for');
  });

  it('uses the canonical runtime workflow id when provided instead of the listing slug', () => {
    const intent = factory.create(uc('workflow', { slug: 'files-slug', workflowId: 'exact-runtime-workflow' }), '');
    expect(directive.directive(intent)).toContain('workflowId "exact-runtime-workflow"');
    expect(directive.metadata(intent).workflowId).toBe('exact-runtime-workflow');
  });

  it('starts recipes through the existing extension start path', () => {
    const unresolved = directive.directive(factory.create(uc('recipe', { slug: 'sweeps-pipeline' }), ''));
    expect(unresolved).toContain('list_installed_extensions');
    expect(unresolved).not.toContain('"id":"sweeps-pipeline"');
    expect(directive.directive(factory.create(uc('recipe', { slug: 'sweeps-pipeline', extensionId: 'docker.io/acme/sweeps' }), ''))).toContain('start_extension with id "docker.io/acme/sweeps"');
  });

  it('ignores declared inputs on skills and agents', () => {
    expect(factory.create(uc('skill', { inputs: [{ name: 'x', required: true }] }), 'x').fields).toEqual([]);
  });
});
