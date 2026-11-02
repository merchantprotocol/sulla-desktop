// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { prepareProviderMessages } from '../../nodes/contextBudget';

import { OpenAICompatibleService } from '../OpenAICompatibleService';

class TestOpenAICompatibleService extends OpenAICompatibleService {
  wire(messages: any[]): string {
    const prepared = prepareProviderMessages(messages, 128_000);
    const body = this.transformToResponsesAPI(this.buildRequestBody(prepared.messages, {}));

    return this.buildFetchOptions(body).body as string;
  }

  toResponses(body: any): any {
    return this.transformToResponsesAPI(body);
  }
}

describe('OpenAICompatibleService Responses API conversion', () => {
  it.each(['head', 'tail'])('keeps %s compaction boundaries valid for strict Unicode JSON decoders', (boundary) => {
    const service = new TestOpenAICompatibleService({ id: 'test', model: 'grok-4.7', baseUrl: 'https://example.invalid/v1' });
    // Include actual ANSI, literal escaped ANSI, and incomplete literal escapes.
    // These are ordinary text; only a split UTF-16 pair makes the wire invalid.
    const prefix = '\u001b[31m \\u001b \\u00 \\x';
    const text = boundary === 'head'
      ? 'a'.repeat(699) + '😀' + prefix + 'x'.repeat(3000)
      : prefix + 'x'.repeat(3000) + '😀' + 'z'.repeat(499);
    const wire = service.wire([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'synthetic', name: 'exec', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic', content: text }] },
    ]);
    const parsed = JSON.parse(wire);
    const output = parsed.input.find((item: any) => item.type === 'function_call_output').output;

    expect(output).toContain('tool result compacted');
    // JSON.parse alone accepts lone surrogates, unlike strict Unicode parsers.
    // UTF-8 roundtrip replaces them, so equality asserts Unicode scalar validity.
    expect(Buffer.from(output, 'utf8').toString('utf8')).toBe(output);
  });

  it('converts parallel chat tool calls and results into linked Responses items', () => {
    const service = new TestOpenAICompatibleService({
      id:      'test',
      model:   'grok-4.5',
      baseUrl: 'https://example.invalid/v1',
    });

    const transformed = service.toResponses({
      model:    'grok-4.5',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Check the weather and time.' },
        {
          role:       'assistant',
          content:    'I will check both.',
          tool_calls: [
            {
              id:       'call_weather',
              type:     'function',
              function: { name: 'get_weather', arguments: '{"city":"Boise"}' },
            },
            {
              id:       'call_time',
              type:     'function',
              function: { name: 'get_time', arguments: '{"zone":"America/Boise"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_weather', content: '{"temperature":72}' },
        { role: 'tool', tool_call_id: 'call_time', content: '10:30' },
        {
          role:    'user',
          content: [
            { type: 'text', text: 'Here is the screenshot.' },
            {
              type:      'image_url',
              image_url: { url: 'data:image/png;base64,c3ludGhldGlj', detail: 'high' },
            },
          ],
        },
        {
          role:       'assistant',
          content:    null,
          tool_calls: [
            {
              id:       'call_inspect',
              type:     'function',
              function: { name: 'inspect_image', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_inspect', content: 'clear' },
        { role: 'assistant', content: 'It is 72 degrees at 10:30.' },
      ],
    });

    expect(transformed.input).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Check the weather and time.' },
      { role: 'assistant', content: 'I will check both.' },
      {
        type:      'function_call',
        call_id:   'call_weather',
        name:      'get_weather',
        arguments: '{"city":"Boise"}',
      },
      {
        type:      'function_call',
        call_id:   'call_time',
        name:      'get_time',
        arguments: '{"zone":"America/Boise"}',
      },
      {
        type:    'function_call_output',
        call_id: 'call_weather',
        output:  '{"temperature":72}',
      },
      {
        type:    'function_call_output',
        call_id: 'call_time',
        output:  '10:30',
      },
      {
        role:    'user',
        content: [
          { type: 'input_text', text: 'Here is the screenshot.' },
          {
            type:      'input_image',
            image_url: 'data:image/png;base64,c3ludGhldGlj',
            detail:    'high',
          },
        ],
      },
      {
        type:      'function_call',
        call_id:   'call_inspect',
        name:      'inspect_image',
        arguments: '{}',
      },
      {
        type:    'function_call_output',
        call_id: 'call_inspect',
        output:  'clear',
      },
      { role: 'assistant', content: 'It is 72 degrees at 10:30.' },
    ]);
  });
});
