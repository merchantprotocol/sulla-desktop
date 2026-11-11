// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createRenderer, defineComponent, h, nextTick, ref, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SuggestedUseCase, UseCaseSuggestionResponse } from '@pkg/shared/useCaseSuggestions';
import { useUseCaseSuggestions } from '@pkg/pages/chat/composables/useUseCaseSuggestions';
import type { UseCaseSuggestionDeps } from '@pkg/pages/chat/composables/useUseCaseSuggestions';
import type { UseCaseIntent } from '@pkg/pages/chat/services/UseCaseIntent';

interface HostNode { type: string; children: HostNode[]; parent?: HostNode; text?: string }
interface SuggestionHarness { app: App; draft: ReturnType<typeof ref<string>>; getIntent(): UseCaseIntent | null; api: ReturnType<typeof useUseCaseSuggestions> }

class SuggestionHarnessFactory {
  create(query: UseCaseSuggestionDeps['query']): SuggestionHarness {
    const draft = ref('');
    const blocked = ref(false);
    let api!: ReturnType<typeof useUseCaseSuggestions>;
    const root: HostNode = { type: 'root', children: [] };
    const renderer = createRenderer<HostNode, HostNode>({
      patchProp: () => undefined,
      insert: (node, parent, anchor) => {
        node.parent = parent;
        const index = anchor ? parent.children.indexOf(anchor) : -1;
        if (index < 0) parent.children.push(node);
        else parent.children.splice(index, 0, node);
      },
      remove: (node) => { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); },
      createElement: type => ({ type, children: [] }),
      createText: text => ({ type: '#text', children: [], text }),
      createComment: text => ({ type: '#comment', children: [], text }),
      setText: (node, text) => { node.text = text; },
      setElementText: (node, text) => { node.text = text; node.children = []; },
      parentNode: node => node.parent ?? null,
      nextSibling: node => {
        const siblings = node.parent?.children ?? [];
        return siblings[siblings.indexOf(node) + 1] ?? null;
      },
    });
    const component = defineComponent({
      setup() {
        api = useUseCaseSuggestions({ draft, blocked, query, isNarrow: () => false, debounceMs: 10 });
        return () => h('span');
      },
    });
    const app = renderer.createApp(component);
    app.mount(root);

    return { app, draft, getIntent: () => api.intent.value, api };
  }
}

const report: SuggestedUseCase = { type: 'skill', slug: 'report-writer', title: 'Report writer', description: 'Writes reports', score: 0.9, reason: 'semantic match' };
const workflow: SuggestedUseCase = {
  type: 'workflow', slug: 'lead-digest', title: 'Lead digest', description: 'Summarizes leads', score: 0.8, reason: 'semantic match',
  inputs: [{ name: 'recipient', required: true }, { name: 'period', required: true }],
};

class DeferredResponse {
  readonly promise: Promise<UseCaseSuggestionResponse>;
  resolve!: (value: UseCaseSuggestionResponse) => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}

describe('composer use-case suggestion interactions', () => {
  const harnesses: SuggestionHarness[] = [];
  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.app.unmount();
    vi.useRealTimers();
  });

  it('debounces injected queries and ignores a late response for stale text', async() => {
    // risk: stale suggestions can apply an unrelated workflow to the next message
    vi.useFakeTimers();
    const first = new DeferredResponse();
    const second = new DeferredResponse();
    const query = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const harness = new SuggestionHarnessFactory().create(query);
    harnesses.push(harness);

    harness.draft.value = 'write a report';
    await nextTick();
    await vi.advanceTimersByTimeAsync(10);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenLastCalledWith('write a report', 5);

    harness.draft.value = 'summarize the leads';
    await nextTick();
    await vi.advanceTimersByTimeAsync(10);
    expect(query).toHaveBeenCalledTimes(2);
    first.resolve({ items: [report], ms: 2 });
    await Promise.resolve();
    await nextTick();
    expect(harness.api.strip.items).toEqual([]);

    second.resolve({ items: [workflow], ms: 3 });
    await Promise.resolve();
    await nextTick();
    expect(harness.api.strip.items).toEqual([workflow]);
  });

  it('keyboard selection creates an intent without executing it before send', async() => {
    // risk: selecting a use case must not execute a workflow before the user sends
    vi.useFakeTimers();
    const query = vi.fn(async(): Promise<UseCaseSuggestionResponse> => ({ items: [workflow], ms: 1 }));
    const harness = new SuggestionHarnessFactory().create(query);
    harnesses.push(harness);
    harness.draft.value = 'summarize my leads';
    await nextTick();
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await nextTick();

    const key = (name: string) => ({ key: name, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn() }) as unknown as KeyboardEvent;
    const down = key('ArrowDown');
    expect(harness.api.onKeydown(down, true)).toBe(true);
    const enter = key('Enter');
    expect(harness.api.onKeydown(enter, true)).toBe(true);
    expect(harness.getIntent()?.item).toEqual(workflow);
    expect(harness.api.directive.missing(harness.getIntent()!)).toEqual(['recipient', 'period']);
    expect(harness.api.directive.compose(harness.getIntent()!, harness.draft.value)).toContain('Ask me for recipient, period before running it');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('keeps the composer quiet before the minimum query length and uses Escape/Tab without stealing normal behavior', async() => {
    vi.useFakeTimers();
    const query = vi.fn(async(): Promise<UseCaseSuggestionResponse> => ({ items: [report], ms: 1 }));
    const harness = new SuggestionHarnessFactory().create(query);
    harnesses.push(harness);
    harness.draft.value = 'hi';
    await nextTick();
    await vi.advanceTimersByTimeAsync(20);
    expect(query).not.toHaveBeenCalled();

    harness.draft.value = 'report this';
    await nextTick();
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await nextTick();
    const key = (name: string) => ({ key: name, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn() }) as unknown as KeyboardEvent;
    expect(harness.api.onKeydown(key('Tab'), true)).toBe(false);
    expect(harness.api.open.value).toBe(true);
    expect(harness.api.onKeydown(key('Escape'), true)).toBe(true);
    expect(harness.api.open.value).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('editing required workflow inputs clears missing fields and sends those values in metadata', async() => {
    // risk: workflow input values or required-field gaps can be lost when the user sends
    const harness = new SuggestionHarnessFactory().create(async() => ({ items: [], ms: 0 }));
    harnesses.push(harness);
    harness.api.pick(workflow);
    const intent = harness.getIntent()!;
    intent.fields[0].value = 'ops@example.com';
    intent.fields[1].value = 'last 7 days';

    expect(harness.api.directive.missing(intent)).toEqual([]);
    expect(harness.api.directive.metadata(intent).inputs).toEqual({ recipient: 'ops@example.com', period: 'last 7 days' });
    expect(harness.api.directive.compose(intent, 'summarize leads')).toContain('using inputs {"recipient":"ops@example.com","period":"last 7 days"}');
  });
});
