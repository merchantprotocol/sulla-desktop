import fs from 'fs';
import { jest } from '@jest/globals';
import { compileScript, parse } from '@vue/compiler-sfc';
import { mount, flushPromises } from '@vue/test-utils';
import * as vue from 'vue';
import ts from 'typescript';

const record = { id: 'request-a', conversationId: 'original-thread', channel: 'mobile-relay', title: 'Publish this change?', kind: 'approval', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 60000 };
const records = vue.ref([record]);
const invoke = jest.fn<(...args: any[]) => Promise<any>>();
const push = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined);
const restore = jest.fn<(...args: any[]) => any>().mockReturnValue({ id: 'original-tab' });
const refresh = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
// The repository's legacy Vue Jest transform only handles <script>, not
// <script setup>. Compile this actual SFC with Vue's own compiler to exercise
// the real rendered controls without an Electron process or Desktop restart.
const source = fs.readFileSync(new URL('../DecidePage.vue', import.meta.url), 'utf8');
const compiled = compileScript(parse(source).descriptor, { id: 'decide-test', inlineTemplate: true });
const js = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const module = { exports: {} as any };
const dependencies: Record<string, any> = {
  vue,
  'vue-router': { useRouter: () => ({ push }) },
  '@pkg/composables/useDecisions': { useDecisions: () => ({ records, pending: records, error: vue.ref(''), refresh }) },
  '@pkg/utils/ipcRenderer': { ipcRenderer: { invoke } },
  '@pkg/pages/chat/services/historyRestore': { restoreChatFromHistory: restore },
};
new Function('require', 'module', 'exports', js)((name: string) => {
  if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
  return dependencies[name];
}, module, module.exports);
const Component = module.exports.default;
beforeEach(() => { jest.clearAllMocks(); records.value = [{ ...record }]; });

test('Approve waits for receipt, then opens exactly the original conversation', async() => {
  let settle!: (value: any) => void;
  invoke.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
  const wrapper = mount(Component);
  await wrapper.findAll('button').find(b => b.text() === 'Approve')!.trigger('click');
  expect(push).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith('decisions:resolve', expect.objectContaining({ id: 'request-a', conversationId: 'original-thread', action: 'approved' }));
  settle({ settled: true }); await flushPromises();
  expect(restore).toHaveBeenCalledWith(expect.objectContaining({ id: 'original-thread', thread_id: 'original-thread' }));
  expect(push).toHaveBeenCalledWith('/Browser/original-tab');
  wrapper.unmount();
});
test('failed receipt stays in inbox and visibly reports failure', async() => {
  invoke.mockResolvedValueOnce({ settled: false, reason: 'This request expired.' });
  const wrapper = mount(Component);
  await wrapper.findAll('button').find(b => b.text() === 'Approve')!.trigger('click'); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('expired');
  expect(push).not.toHaveBeenCalled(); wrapper.unmount();
});
test('settings search filters catalog categories and checkbox saves chosen policy', async() => {
  invoke.mockResolvedValueOnce([{ name: 'git_push', category: 'github', description: 'Push branch', required: false }, { name: 'list_tasks', category: 'project', description: 'List tasks', required: false }]);
  const wrapper = mount(Component);
  await wrapper.findAll('button').find(b => b.text() === 'Approval settings')!.trigger('click'); await flushPromises();
  await wrapper.get('input[type="search"]').setValue('github');
  expect(wrapper.text()).toContain('git_push'); expect(wrapper.text()).not.toContain('list_tasks');
  invoke.mockResolvedValueOnce({ saved: true });
  await wrapper.get('input[type="checkbox"]').setValue(true); await flushPromises();
  expect(invoke).toHaveBeenLastCalledWith('decisions:set-policy', 'git_push', true);
  wrapper.unmount();
});
