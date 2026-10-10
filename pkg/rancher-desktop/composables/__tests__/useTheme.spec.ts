import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';

jest.unstable_mockModule('@pkg/agent/database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: jest.fn(() => Promise.resolve(null)),
    set: jest.fn(() => Promise.resolve()),
  },
}));

const { availableThemes, DEFAULT_THEME, themeGroups, useTheme } = await import('../useTheme');

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  afterEach(() => {
    document.documentElement.className = '';
  });

  it('falls back to Noir when no theme has been saved', async() => {
    const harness = defineComponent({
      setup() {
        useTheme();

        return () => h('div');
      },
    });
    const wrapper = mount(harness);

    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    await nextTick();

    expect(DEFAULT_THEME).toBe('noir-dark');
    expect(document.documentElement.classList.contains('theme-noir-dark')).toBe(true);
    expect(document.documentElement.classList.contains('theme-protocol-dark')).toBe(false);

    wrapper.unmount();
  });

  it('selects Noir and applies its dark root classes', async() => {
    const noir = availableThemes.find(theme => theme.id === 'noir-dark');
    const noirGroup = themeGroups.find(group => group.scheme === 'noir');
    let themeApi: ReturnType<typeof useTheme> | undefined;
    const harness = defineComponent({
      setup() {
        themeApi = useTheme();

        return () => h('div');
      },
    });
    const wrapper = mount(harness);

    expect(noir).toEqual({
      id:     'noir-dark',
      scheme: 'noir',
      mode:   'dark',
      label:  'Noir',
      isDark: true,
    });
    expect(noirGroup?.themes).toEqual([noir]);

    themeApi?.setTheme('noir-dark');
    await nextTick();

    expect(document.documentElement.classList.contains('theme-noir-dark')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    wrapper.unmount();
  });
});
