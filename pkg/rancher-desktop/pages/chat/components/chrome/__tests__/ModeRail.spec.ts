import fs from 'fs';
import path from 'path';

import { compileScript, parse } from '@vue/compiler-sfc';
import { mount, type VueWrapper } from '@vue/test-utils';
import ts from 'typescript';
import * as vue from 'vue';

const pending = vue.ref<unknown[]>([]);
let ModeRail: any;

function nextFrame(): Promise<void> {
  return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}

async function settleIndicator(): Promise<void> {
  await vue.nextTick();
  await nextFrame();
}

function modeButton(wrapper: VueWrapper, label: string) {
  return wrapper.get(`button[aria-label="${ label }"]`);
}

beforeAll(() => {
  const source = fs.readFileSync(path.resolve('pkg/rancher-desktop/pages/chat/components/chrome/ModeRail.vue'), 'utf8');
  const compiled = compileScript(parse(source).descriptor, { id: 'mode-rail-test', inlineTemplate: true });
  const js = ts.transpileModule(compiled.content, {
    compilerOptions: {
      esModuleInterop: true,
      module:          ts.ModuleKind.CommonJS,
      target:          ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} as any };
  const dependencies: Record<string, any> = {
    vue,
    '@pkg/composables/useDecisions': { useDecisions: () => ({ pending }) },
  };

  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- evaluates the real SFC compiled above
  new Function('require', 'module', 'exports', js)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${ name }`);

    return dependencies[name];
  }, module, module.exports);
  ModeRail = module.exports.default;
});

beforeEach(() => {
  window.localStorage.clear();
});

test('moves the shared indicator to the active button and hides it for an unknown mode', async() => {
  const wrapper = mount(ModeRail, { props: { active: 'chat' } });
  const chat = modeButton(wrapper, 'Chat');
  const library = modeButton(wrapper, 'Library');

  Object.defineProperty(chat.element, 'offsetTop', { configurable: true, value: 47 });
  Object.defineProperty(chat.element, 'offsetHeight', { configurable: true, value: 40 });
  Object.defineProperty(library.element, 'offsetTop', { configurable: true, value: 331 });
  Object.defineProperty(library.element, 'offsetHeight', { configurable: true, value: 40 });

  window.dispatchEvent(new Event('resize'));
  await settleIndicator();
  expect(wrapper.get('.active-indicator').attributes('style')).toContain('translateY(47px)');

  await wrapper.setProps({ active: 'routines', activeSubTab: 'library' });
  await settleIndicator();
  expect(wrapper.get('.active-indicator').attributes('style')).toContain('translateY(331px)');
  expect(library.attributes('aria-current')).toBe('page');

  await wrapper.setProps({ active: 'welcome', activeSubTab: undefined });
  await settleIndicator();
  expect(wrapper.get('.active-indicator').classes()).not.toContain('visible');
  wrapper.unmount();
});

test('persists expansion and restores it on the next mount', async() => {
  const wrapper = mount(ModeRail, { props: { active: 'chat' } });

  await modeButton(wrapper, 'Expand mode rail').trigger('click');
  expect(wrapper.get('.mode-rail').classes()).toContain('expanded');
  expect(window.localStorage.getItem('sulla:mode-rail-expanded')).toBe('true');
  wrapper.unmount();

  const restored = mount(ModeRail, { props: { active: 'chat' } });
  expect(restored.get('.mode-rail').classes()).toContain('expanded');
  expect(modeButton(restored, 'Collapse mode rail').attributes('aria-expanded')).toBe('true');
  restored.unmount();
});

test('keeps mode and utility emits unchanged', async() => {
  const wrapper = mount(ModeRail, { props: { active: 'chat' } });

  await modeButton(wrapper, 'Library').trigger('click');
  await modeButton(wrapper, 'Bookmarks').trigger('click');
  await modeButton(wrapper, 'File Explorer').trigger('click');

  expect(wrapper.emitted('set-mode')).toEqual([['routines', 'library']]);
  expect(wrapper.emitted('toggle-bookmarks')).toHaveLength(1);
  expect(wrapper.emitted('toggle-file-tree')).toHaveLength(1);
  wrapper.unmount();
});
