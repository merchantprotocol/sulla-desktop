import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getMock = jest.fn();
const setMock = jest.fn();

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: getMock, set: setMock },
}));

const { IntentDecisionEngine } = await import('../IntentDecisionEngine');

describe('IntentDecisionEngine', () => {
  beforeEach(() => {
    getMock.mockReset().mockResolvedValue(null);
    setMock.mockReset().mockResolvedValue(undefined);
  });

  it('pre-reads browser and container requests without executing anything', async() => {
    const engine = new IntentDecisionEngine();
    const decision = await engine.decide('Open the doctor container in my browser');

    expect(decision.label).toBe('browser');
    expect(decision.confidence).toBeGreaterThan(0.5);
    expect(decision.suggestedTools).toContain('browser_tab');
    expect(setMock).not.toHaveBeenCalled();
  });

  it('learns aggregate token counts from a completed tool turn', async() => {
    const engine = new IntentDecisionEngine();
    await engine.learn([
      { role: 'user', content: 'Open the doctor container in my browser' },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'browser_tab', input: {} }] },
    ]);

    expect(setMock).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(setMock.mock.calls[0][1] as string);
    expect(stored.examples).toBe(1);
    expect(stored.labels.browser).toBe(1);
    expect(stored.tokens.browser.doctor).toBe(1);
    expect(stored.tokens.browser.container).toBe(1);
    expect(JSON.stringify(stored)).not.toContain('Open the doctor container');
  });

  it('does not train when no tool actually ran', async() => {
    const engine = new IntentDecisionEngine();
    await engine.learn([{ role: 'user', content: 'Please explain this design' }]);
    expect(setMock).not.toHaveBeenCalled();
  });
});
