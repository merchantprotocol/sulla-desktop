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
    expect(document.documentElement.classList.contains('theme-noir')).toBe(true);
    expect(document.documentElement.classList.contains('theme-protocol-dark')).toBe(false);

    wrapper.unmount();
  });

  it('selects both Noir variants and applies their family root class', async() => {
    const noirDark = availableThemes.find(theme => theme.id === 'noir-dark');
    const noirLight = availableThemes.find(theme => theme.id === 'noir-light');
    const noirGroup = themeGroups.find(group => group.scheme === 'noir');
    let themeApi: ReturnType<typeof useTheme> | undefined;
    const harness = defineComponent({
      setup() {
        themeApi = useTheme();

        return () => h('div');
      },
    });
    const wrapper = mount(harness);

    expect(noirDark).toEqual({
      id:     'noir-dark',
      scheme: 'noir',
      mode:   'dark',
      label:  'Noir Dark',
      isDark: true,
    });
    expect(noirLight).toEqual({
      id:     'noir-light',
      scheme: 'noir',
      mode:   'light',
      label:  'Noir Light',
      isDark: false,
    });
    expect(noirGroup?.themes).toEqual([noirDark, noirLight]);

    themeApi?.setTheme('noir-dark');
    await nextTick();

    expect(document.documentElement.classList.contains('theme-noir-dark')).toBe(true);
    expect(document.documentElement.classList.contains('theme-noir')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    themeApi?.setTheme('noir-light');
    await nextTick();

    expect(document.documentElement.classList.contains('theme-noir-dark')).toBe(false);
    expect(document.documentElement.classList.contains('theme-noir-light')).toBe(true);
    expect(document.documentElement.classList.contains('theme-noir')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    themeApi?.setTheme('protocol-light');
    await nextTick();

    expect(document.documentElement.classList.contains('theme-noir-light')).toBe(false);
    expect(document.documentElement.classList.contains('theme-noir')).toBe(false);
    expect(document.documentElement.classList.contains('theme-protocol-light')).toBe(true);

    wrapper.unmount();
  });
});
