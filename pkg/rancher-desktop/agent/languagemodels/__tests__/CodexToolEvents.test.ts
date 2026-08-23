import { describe, expect, it, jest } from '@jest/globals';

import { codexToolEventForItem, emitCodexToolEvent } from '../codexToolEvents';

describe('CodexService tool-event normalization', () => {
  it('captures completed command execution details and failures', () => {
    expect(codexToolEventForItem({
      id:                'item-1',
      type:              'command_execution',
      command:           'printf hello',
      cwd:               '/workspace',
      aggregated_output: 'hello',
      exit_code:         7,
      status:            'failed',
    })).toEqual({
      toolUseId:   'item-1',
      toolName:    'command_execution',
      input:       { command: 'printf hello', cwd: '/workspace' },
      resultChars: 5,
      isError:     true,
    });
  });

  it('captures MCP tool arguments and structured result size', () => {
    const result = { content: [{ type: 'text', text: 'project data' }] };

    expect(codexToolEventForItem({
      id:        'item-2',
      type:      'mcp_tool_call',
      server:    'sulla-native',
      tool:      'project_get_project_item',
      arguments: { id: '7BAO' },
      result,
      status:    'completed',
    })).toEqual({
      toolUseId:   'item-2',
      toolName:    'sulla-native/project_get_project_item',
      input:       { id: '7BAO' },
      resultChars: JSON.stringify(result).length,
      isError:     undefined,
    });
  });

  it('ignores non-tool and unidentifiable items', () => {
    expect(codexToolEventForItem({ id: 'item-3', type: 'agent_message', text: 'done' })).toBeNull();
    expect(codexToolEventForItem({ type: 'mcp_tool_call', tool: 'missing_id' })).toBeNull();
  });

  it('forwards only completed tool items to the stream callback', () => {
    const callback = jest.fn();
    const item = {
      id:                'item-4',
      type:              'command_execution',
      command:           'pwd',
      aggregated_output: '/workspace',
      exit_code:         0,
      status:            'completed',
    };

    emitCodexToolEvent('item.started', item, callback);
    expect(callback).not.toHaveBeenCalled();

    emitCodexToolEvent('item.completed', item, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      toolUseId: 'item-4',
      toolName:  'command_execution',
      isError:   undefined,
    }));
  });
});
