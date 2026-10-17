import { OpenAICompatibleService } from '../OpenAICompatibleService';

class TestOpenAICompatibleService extends OpenAICompatibleService {
  toResponses(body: any): any {
    return this.transformToResponsesAPI(body);
  }
}

describe('OpenAICompatibleService Responses API conversion', () => {
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
