import { describe, expect, it, jest } from '@jest/globals';

const getSetting = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);

jest.unstable_mockModule('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: getSetting },
}));
jest.unstable_mockModule('../../../services/DecisionService', () => ({
  decisionService: { requiresApproval: jest.fn<() => Promise<boolean>>().mockResolvedValue(false) },
}));
jest.unstable_mockModule('@pkg/utils/paths', () => ({ default: { config: '/synthetic-config' } }));
jest.unstable_mockModule('@pkg/utils/logging', () => ({ default: { background: { log: jest.fn() } } }));

const { BaseTool } = await import('../../base');
const { HOST_ACCESS_DISABLED_MESSAGE } = await import('../hostAccess');
const { toolRequiresHostAccess } = await import('../hostAccessPolicy');

class ProbeTool extends BaseTool {
  name = 'screenshot';
  description = '';
  invoked = false;
  protected async _validatedCall(): Promise<any> {
    this.invoked = true;
    return { successBoolean: true, responseString: 'unsafe' };
  }
}

describe('host execution gate', () => {
  it('fails closed before every audited host surface can execute', async() => {
    expect([
      ['applescript', 'applescript_execute'],
      ['capture', 'screenshot'],
      ['lima', 'lima_shell'],
      ['secretary', 'start'],
    ].every(([category, name]) => toolRequiresHostAccess(category, name))).toBe(true);

    const tool = new ProbeTool();
    tool.metadata.category = 'capture';
    const result = await tool.call({});

    expect(result).toEqual({ toolName: 'screenshot', success: false, error: HOST_ACCESS_DISABLED_MESSAGE });
    expect(tool.invoked).toBe(false);
  });
});
