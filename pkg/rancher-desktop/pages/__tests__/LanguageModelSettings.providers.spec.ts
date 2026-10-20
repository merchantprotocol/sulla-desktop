import { describe, expect, it, jest, beforeAll } from '@jest/globals';
import { flushPromises, mount } from '@vue/test-utils';

const PROVIDERS = Array.from({ length: 22 }, (_, i) => ({ id: `prov${ i }`, name: `Provider ${ i }`, connected: true }));
const invoke = jest.fn<(channel: string, ...args: any[]) => Promise<unknown>>(async(channel: string) => {
  switch (channel) {
  case 'model-provider:get-providers': return PROVIDERS;
  case 'model-provider:get-state': return { primaryProvider: 'prov0', primaryModel: 'm', secondaryProvider: 'prov1', secondaryModel: 'm', subconsciousProvider: 'default' };
  case 'model-provider:get-models':
  case 'model-provider:get-accounts': return [];
  default: return null;
  }
});

jest.unstable_mockModule('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    on: jest.fn(), off: jest.fn(), removeListener: jest.fn(), send: jest.fn(), invoke,
  },
}));
jest.unstable_mockModule('../../agent/database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: async(_k: string, d: unknown) => d, set: async() => true, getMany: async() => ({}),
  },
}));
jest.unstable_mockModule('../../agent/languagemodels', () => ({
  getSupportedProviders: () => [], fetchModelsForProvider: async() => [], clearModelCache: () => {},
}));

let Page: any;
beforeAll(async() => {
  Page = (await import('../LanguageModelSettings.vue')).default;
});

async function mountPage() {
  const w = mount(Page);
  await flushPromises();
  (w.vm as any).currentNav = 'models';
  await flushPromises();
  return w;
}

describe('LanguageModelSettings provider choosers', () => {
  it('renders each provider chooser as a select with all providers and no tab row', async() => {
    const w = await mountPage();
    for (const slot of ['primary', 'secondary', 'subconscious']) {
      const sel = w.find(`#provider-${ slot }`);
      expect(sel.exists()).toBe(true);
      expect(sel.element.tagName).toBe('SELECT');
      const opts = sel.findAll('option').filter(o => o.element.value !== 'default');
      expect(opts).toHaveLength(22);
    }
    const pane = w.find('.noir-models-pane');
    for (const r of pane.findAll('.noir-segment-row')) {
      expect(r.text()).not.toContain('Provider 0');
    }
    expect(pane.find('label[for="provider-primary"]').exists()).toBe(true);
  });

  it('selecting an option updates the bound value and calls the same IPC', async() => {
    const w = await mountPage();
    await w.find('#provider-secondary').setValue('prov7');
    await flushPromises();
    expect((w.vm as any).secondaryProvider).toBe('prov7');
    expect(invoke).toHaveBeenCalledWith('model-provider:set-secondary', 'prov7');
  });

  it('keeps the not-connected hint on options and inline', async() => {
    const w = await mountPage();
    (w.vm as any).availableProviders = [...PROVIDERS, { id: 'ghost', name: 'Ghost', connected: false }];
    (w.vm as any).primaryProvider = 'ghost';
    await flushPromises();
    expect(w.find('#provider-primary').text()).toContain('Ghost (not connected)');
    expect(w.find('.noir-models-pane').text()).toContain('isn\'t connected yet');
  });
});
