// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { UseCaseInputExtractor, UseCaseInputRequirements } from '@pkg/pages/chat/services/UseCaseInputs';

const extractor = new UseCaseInputExtractor();

describe('UseCaseInputExtractor', () => {
  it('prefills emails, "last N days", dates and quoted names from the draft', () => {
    const text = 'Summarise the "Sweeps Leads 2026" sheet for the last 7 days since 2026-11-01 and send it to ana.m+ops@acme.co.uk';
    const values = extractor.extract(text, [
      { name: 'recipient' }, { name: 'email' }, { name: 'days' }, { name: 'period' }, { name: 'start_date' }, { name: 'sheet' },
    ]);

    expect(values).toEqual({
      recipient:  'ana.m+ops@acme.co.uk',
      email:      'ana.m+ops@acme.co.uk',
      days:       '7',
      period:     'last 7 days',
      start_date: '2026-11-01',
      sheet:      'Sweeps Leads 2026',
    });
  });

  it('accepts "past N day" and slash dates', () => {
    expect(extractor.extract('report for the past 1 day from 11/3/2026', [{ name: 'days' }, { name: 'date' }]))
      .toEqual({ days: '1', date: '11/3/2026' });
  });

  it('leaves fields empty when nothing unambiguous matches', () => {
    // data accuracy: a wrong prefill would silently run a workflow with bad inputs
    const values = extractor.extract("don't email bob, it's for last week's leads", [
      { name: 'recipient' }, { name: 'days' }, { name: 'company' }, { name: 'date' }, { name: 'notes' },
    ]);

    expect(values).toEqual({});
  });

  it('is deterministic for the same input', () => {
    const text = 'send "Acme" numbers for the last 30 days to x@y.io';
    const inputs = [{ name: 'company' }, { name: 'days' }, { name: 'email' }];

    expect(extractor.extract(text, inputs)).toEqual(extractor.extract(text, inputs));
  });
});

describe('UseCaseInputRequirements', () => {
  it('reports required inputs that are blank or whitespace, not optional ones', () => {
    const missing = new UseCaseInputRequirements().missingRequired(
      [{ name: 'sheet', required: true }, { name: 'recipient', required: true }, { name: 'note' }],
      { sheet: 'Leads', recipient: '   ' },
    );

    expect(missing).toEqual(['recipient']);
  });
});
