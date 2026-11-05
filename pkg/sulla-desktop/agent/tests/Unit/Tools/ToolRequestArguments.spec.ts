// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ToolRequestArguments } from '@pkg/runtime/toolRequestArguments';

describe('ToolRequestArguments', () => {
  it('preserves a pg-style params array alongside sql in a flat tool request', () => {
    // risk: data accuracy — dropping sql turns a valid parameterized query into a missing-SQL failure.
    const body = { sql: 'select $1::text as value', params: ['x'] };

    expect(ToolRequestArguments.normalize(body)).toEqual(body);
  });

  it('preserves flat object params when sibling tool arguments are present', () => {
    // risk: data accuracy — reflex tools need both object params and their required sibling arguments.
    const body = { utterance: 'teach this', tool: 'reflex/teach', params: { url: 'https://example.test' } };

    expect(ToolRequestArguments.normalize(body)).toEqual(body);
  });

  it('unwraps the object envelope used by integration callers', () => {
    const argumentsBody = { sql: 'select 1', params: [] };

    expect(ToolRequestArguments.normalize({ params: argumentsBody })).toEqual(argumentsBody);
  });

  it('does not reinterpret non-object request bodies as tool arguments', () => {
    expect(ToolRequestArguments.normalize(['select 1'])).toEqual({});
    expect(ToolRequestArguments.normalize(null)).toEqual({});
  });
});
