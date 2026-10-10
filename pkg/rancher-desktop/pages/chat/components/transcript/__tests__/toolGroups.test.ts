import { asMessageId } from '../../../types/chat';
import { groupTranscriptTools } from '../toolGroups';

import type { Message, ToolMessage } from '../../../models/Message';

function tool(id: string, turnId?: string): ToolMessage {
  return { id: asMessageId(id), kind: 'tool', createdAt: 1, turnId, tool: id, desc: '', status: 'ok' };
}

describe(groupTranscriptTools, () => {
  test('groups only adjacent tools from the same turn', () => {
    const separator: Message = { id: asMessageId('reply'), kind: 'sulla', createdAt: 2, text: 'done', model: 'test' };
    const result = groupTranscriptTools([
      tool('one', 'turn-a'),
      tool('two', 'turn-a'),
      tool('three', 'turn-b'),
      separator,
      tool('four', 'turn-a'),
    ]);

    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ kind: 'tool-group', messages: [{ id: 'one' }, { id: 'two' }] });
    expect(result[1]).toMatchObject({ kind: 'tool-group', messages: [{ id: 'three' }] });
    expect(result[2]).toBe(separator);
    expect(result[3]).toMatchObject({ kind: 'tool-group', messages: [{ id: 'four' }] });
  });

  test('groups an adjacent legacy run without turn ids', () => {
    const result = groupTranscriptTools([tool('one'), tool('two')]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'tool-group', messages: [{ id: 'one' }, { id: 'two' }] });
  });
});
