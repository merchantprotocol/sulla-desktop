import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const convert = jest.fn<(name: string) => Promise<any>>().mockImplementation(name => Promise.resolve({ name }));
jest.unstable_mockModule('@pkg/agent/tools/registry', () => ({ toolRegistry: { convertToolToLLM: convert } }));
const { configureRoutineBrowser } = await import('../routineBrowser');
const { isGraphBrowserControllerEnabled } = await import('../../utils/graphBrowserController');
beforeEach(() => { jest.clearAllMocks() });
describe('scheduled browser admission', () => {
  it.each([undefined, false, 'true', 1])('does not grant browser for %p', async browser => {
    const state: any = { metadata: {} };
    await configureRoutineBrowser(state, { browser } as any);
    expect(isGraphBrowserControllerEnabled(state)).toBe(false);
    expect(convert).not.toHaveBeenCalled();
  });
  it('grants graph-owned browser with only the slim scheduled tool set', async() => {
    const state: any = { metadata: { userVisibleBrowser: true, threadId: 'routine-a' } };
    await configureRoutineBrowser(state, { browser: true });
    expect(isGraphBrowserControllerEnabled(state)).toBe(true);
    expect(state.metadata.allowedToolNames).toEqual(['browse_tools', 'exec', 'read_file', 'write_file', 'browser_controller']);
    expect(state.llmTools).toHaveLength(5);
  });
  it.each([{ userVisibleBrowser: false }, { allowedToolNames: ['read_file'] }])('cannot override an existing restriction %p', async metadata => {
    const state: any = { metadata };
    await expect(configureRoutineBrowser(state, { browser: true })).rejects.toThrow();
    expect(isGraphBrowserControllerEnabled(state)).toBe(false);
    expect(convert).not.toHaveBeenCalled();
  });
  it('preserves an existing narrower policy', async() => {
    const state: any = { metadata: { allowedToolNames: ['browser_controller'] } };
    await configureRoutineBrowser(state, { browser: true });
    expect(state.metadata.allowedToolNames).toEqual(['browser_controller']);
  });
  it('does not grant capability after schema resolution fails', async() => {
    convert.mockRejectedValueOnce(new Error('unregistered'));
    const state: any = { metadata: {} };
    await expect(configureRoutineBrowser(state, { browser: true })).rejects.toThrow('unregistered');
    expect(isGraphBrowserControllerEnabled(state)).toBe(false);
  });
});
