// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

import { createMessageDispatcher } from '@pkg/agent/database/models/MessageDispatcher';
import { stripProtocolTags, stripProtocolTagsForUi, stripProtocolTagsStreaming } from '@pkg/agent/utils/stripProtocolTags';
import MessageRouter from '@pkg/pages/chat/components/transcript/MessageRouter.vue';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { PersonaAdapter } from '@pkg/pages/chat/services/PersonaAdapter';
import { asMessageId } from '@pkg/pages/chat/types/chat';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('@pkg/pages/agent/ChatInterface', () => ({ ChatInterface: class {} }));

const documentReply = '<html><div><style>.example { color: inherit }</style><table><tr><td>orchid row</td></tr></table></div></html>';
const htmlSource = '<html><body><style>p { color: red }</style><script>/* inert fixture */</script><p>source only</p></body></html>';

const examples = [
  { name: 'raw wrapped HTML', text: documentReply, check: 'table td', visible: 'orchid row', isolated: true },
  { name: 'raw table fragment', text: '<table><tr><td>iris row</td></tr></table>', check: 'table td', visible: 'iris row' },
  { name: 'inline backticks', text: 'Use `<html>` as the opening tag.', check: 'p code', visible: '<html>' },
  { name: 'fenced code', text: '~~~js\nconst color = "blue";\n~~~', check: 'pre code', visible: 'const color = "blue";' },
  { name: 'fenced HTML', text: '```html\n' + htmlSource + '\n```', check: 'pre code', visible: htmlSource },
  { name: 'mixed prose and fenced HTML', text: '**Before** the example.\n\n```html\n' + htmlSource + '\n```\n\n**After** the example.', check: 'pre code', visible: htmlSource, mixed: true },
  { name: 'mixed prose and raw HTML', text: '**Before** the example.\n\n' + documentReply + '\n\n**After** the example.', check: 'table td', visible: 'orchid row', isolated: true, mixed: true },
];

const wrappedProse = (literal: string) => '**First paragraph** contains `' + literal + '`.\n\n**Second paragraph** stays separate.';
const citations = '<citations><source num="1" title="Synthetic citation" origin="fixture" /></citations>';
const doneWrapped = (answer: string) => '<AGENT_DONE>\n' + answer + '\n\n' + citations + '\n</AGENT_DONE>';

class SyntheticChat {
  readonly ctx = { messages: ref<any[]>([]).value, graphRunning: ref(false), registry: { setLoading() {} } };
  private readonly dispatcher = createMessageDispatcher();
  private readonly adapter = Object.create(PersonaAdapter.prototype);

  constructor(readonly controller = new ChatController()) {
    Object.assign(this.adapter, {
      controller, ci: { messages: ref(this.ctx.messages), graphRunning: this.ctx.graphRunning },
      seen: new Set(), seenRunning: new Set(), optimisticUserMessages: new Map(), pendingA2aStatuses: new Map(),
      firstSeenAt: new Map(), firstCompletedAt: new Map(), lastMappedHash: new Map(), lastRawSignature: new Map(),
      persistentArtifacts: new Set(),
    });
  }

  send(type: 'assistant_message' | 'thread_restored', data: object): void {
    this.dispatcher.dispatch(this.ctx as any, 'fixture-chat', 'fixture-thread', { type, data } as any);
    this.adapter.syncMessages();
  }

  publishArtifact(record: object): void {
    this.adapter.applyPersistentArtifact(record, true);
  }

  mount() {
    const controller = this.controller;
    return mount(defineComponent({
      setup: () => () => h('div', controller.messages.value.map(msg => h(MessageRouter, { key: msg.id, msg }))),
    }), { global: { provide: { [ChatControllerKey as symbol]: controller } } });
  }
}

describe('formatted replies stay in the chat transcript', () => {
  // risk: one reply may duplicate or disappear as it moves from stream to final to reopened history.
  it.each(examples)('keeps $name inline on stream, final and history replay', async(example) => {
    const live = new SyntheticChat();
    const turn = live.mount();
    const assertReply = (root: HTMLElement) => {
      const shadow = root.querySelector('.iso-host')?.shadowRoot;
      expect(Boolean(shadow)).toBe(Boolean(example.isolated));
      const reply = shadow ?? root;
      const result = reply.querySelectorAll(example.check);
      expect(result).toHaveLength(1);
      expect(result[0].textContent).toContain(example.visible);
      expect(reply.querySelector('script')).toBeNull();
      if (example.mixed) expect(Array.from(reply.querySelectorAll('strong'), node => node.textContent)).toEqual(['Before', 'After']);
    };

    live.send('assistant_message', { kind: 'streaming', content: example.text });
    const streamId = live.controller.messages.value[0].id;
    await nextTick();
    assertReply(turn.element as HTMLElement);
    expect(live.controller.messages.value).toHaveLength(1);
    expect(live.controller.artifacts.value).toEqual({ list: [], activeId: null });

    live.send('assistant_message', { kind: 'streaming_complete' });
    live.send('assistant_message', { kind: 'text', content: example.text });
    await nextTick();
    assertReply(turn.element as HTMLElement);
    expect(live.controller.messages.value).toMatchObject([{ id: streamId, kind: 'sulla', text: example.text }]);
    expect(live.controller.artifacts.value).toEqual({ list: [], activeId: null });

    const reopened = new SyntheticChat(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.controller.serialize())) }));
    const reopenedTurn = reopened.mount();
    reopened.send('thread_restored', { messages: [{ id: streamId, role: 'assistant', content: example.text }] });
    await nextTick();
    assertReply(reopenedTurn.element as HTMLElement);
    expect(reopened.controller.messages.value).toHaveLength(1);
    expect(reopened.controller.artifacts.value).toEqual({ list: [], activeId: null });
    turn.unmount();
    reopenedTurn.unmount();
    live.controller.dispose();
    reopened.controller.dispose();
  });

  it.each([
    { title: 'wrapper with literal HTML', literal: '<html>…</html>', wrap: doneWrapped, wrapped: true },
    { title: 'wrapper with no HTML tag', literal: 'sample text', wrap: doneWrapped, wrapped: true },
    { title: 'literal HTML with no wrapper', literal: '<html>…</html>', wrap: (answer: string) => answer + '\n\n' + citations, wrapped: false },
  ])('keeps two formatted paragraphs for $title through stream, final and reopen', async({ literal, wrap, wrapped }) => {
    // risk: wrapper stripping and HTML detection must not flatten or hide Markdown.
    const answer = wrappedProse(literal);
    const wire = wrap(answer);
    const partial = wire.replace('</AGENT_DONE>', '</AGENT_DO');
    const live = new SyntheticChat();
    const turn = live.mount();
    const assertProse = (root: HTMLElement) => {
      const body = root.querySelector('.chat-body')!;
      expect(Array.from(body.querySelectorAll('p'), node => node.textContent)).toEqual([
        'First paragraph contains ' + literal + '.',
        'Second paragraph stays separate.',
      ]);
      expect(Array.from(body.querySelectorAll('strong'), node => node.textContent)).toEqual(['First paragraph', 'Second paragraph']);
      expect(body.querySelector('p code')?.textContent).toBe(literal);
      expect(root.querySelector('iframe, .iso-host, citations, agent_done')).toBeNull();
      expect(body.textContent).not.toMatch(/AGENT_DONE|Synthetic citation|Needs user input/i);
    };

    expect(stripProtocolTagsStreaming(partial)).toBe(answer);
    expect(stripProtocolTagsForUi(wire)).toBe(answer);
    live.send('assistant_message', { kind: 'streaming', content: wrapped ? partial : stripProtocolTagsStreaming(partial) });
    await nextTick();
    assertProse(turn.element as HTMLElement);
    expect(live.controller.artifacts.value).toEqual({ list: [], activeId: null });

    const id = live.controller.messages.value[0].id;
    live.send('assistant_message', { kind: 'streaming_complete' });
    live.send('assistant_message', { kind: 'text', content: wrapped ? wire : stripProtocolTagsForUi(wire) });
    await nextTick();
    assertProse(turn.element as HTMLElement);
    expect(live.controller.messages.value).toMatchObject([{ id, kind: 'sulla', text: answer }]);
    expect(live.controller.artifacts.value).toEqual({ list: [], activeId: null });

    const snapshot = JSON.parse(JSON.stringify(live.controller.serialize()));
    const cached = new SyntheticChat(new ChatController({ hydrateFrom: snapshot }));
    const cachedTurn = cached.mount();
    assertProse(cachedTurn.element as HTMLElement);
    expect(cached.controller.messages.value).toHaveLength(1);
    expect(cached.controller.artifacts.value).toEqual({ list: [], activeId: null });

    // Reopen from the wire alone; a hydrated snapshot could mask a dropped history reply.
    const reopened = new SyntheticChat();
    const reopenedTurn = reopened.mount();
    reopened.send('thread_restored', { messages: [{ id, role: 'assistant', content: wire }] });
    await nextTick();
    assertProse(reopenedTurn.element as HTMLElement);
    expect(reopened.controller.messages.value).toHaveLength(1);
    expect(reopened.controller.artifacts.value).toEqual({ list: [], activeId: null });
    turn.unmount();
    reopenedTurn.unmount();
    cachedTurn.unmount();
    cached.controller.dispose();
    live.controller.dispose();
    reopened.controller.dispose();
  });

  it('keeps terminal status-only and private wrappers out of the visible reply', () => {
    // risk: formatted-reply compatibility must not expose private protocol metadata.
    const status = '<AGENT_DONE>Status only.</AGENT_DONE>';
    const privateReply = doneWrapped(wrappedProse('example') + '\n\n<overheard>private note</overheard>');
    expect(stripProtocolTagsForUi(status)).toBe('');
    expect(stripProtocolTagsStreaming(status.replace('</AGENT_DONE>', ''))).toBe('');
    expect(stripProtocolTagsForUi(privateReply)).toBe('');
    expect(stripProtocolTagsForUi(doneWrapped(wrappedProse('example') + '\n\nNeeds user input: no'))).toBe(wrappedProse('example'));
    expect(stripProtocolTagsForUi('Visible reply.\n\n' + doneWrapped(wrappedProse('example')))).toBe('Visible reply.');
    expect(stripProtocolTags(doneWrapped(wrappedProse('example')))).toBe('');
  });

  it('keeps an unfinished streaming HTML fence inert', async() => {
    // risk: markup must not become active even before the closing fence arrives.
    const chat = new SyntheticChat();
    const turn = chat.mount();
    chat.send('assistant_message', { kind: 'streaming', content: '~~~html\n' + htmlSource });
    await nextTick();
    expect(turn.find('pre code').element.textContent?.trimEnd()).toBe(htmlSource);
    expect(turn.find('.iso-host').exists()).toBe(false);
    expect(turn.find('style, script').exists()).toBe(false);
    turn.unmount();
    chat.controller.dispose();
  });

  it('keeps a late closing fence in the same reply when only the final dump carries it', () => {
    // risk: a throttled stream must not lose the final tail or append a duplicate.
    const chat = new SyntheticChat();
    const partial = '~~~html\n' + htmlSource;
    const full = partial + '\n~~~\n\nDone.';
    chat.send('assistant_message', { kind: 'streaming', content: partial });
    const id = chat.controller.messages.value[0].id;
    chat.send('assistant_message', { kind: 'streaming_complete' });
    chat.send('assistant_message', { kind: 'text', content: full });
    expect(chat.controller.messages.value).toMatchObject([{ id, kind: 'sulla', text: full }]);
    expect(chat.controller.artifacts.value.list).toEqual([]);
    chat.controller.dispose();
  });

  it('preserves a non-streaming HTML reply verbatim through dispatch', () => {
    // risk: removing the HTML wrapper destroys the type information used by inline rendering.
    const chat = new SyntheticChat();
    chat.send('assistant_message', { kind: 'text', content: documentReply });
    expect(chat.controller.messages.value).toMatchObject([{ kind: 'sulla', text: documentReply }]);
    expect(chat.controller.artifacts.value).toEqual({ list: [], activeId: null });
    chat.controller.dispose();
  });

  it('opens legacy HTML history inline once, not an old drawer copy', async() => {
    // risk: legacy body-only history can disappear or reopen a redundant artifact.
    const chat = new SyntheticChat();
    const id = asMessageId('legacy-html');
    const legacy = '<div><table><tr><td>legacy row</td></tr></table><button onclick="void 0">safe button</button><iframe title="no source"></iframe></div>';
    const artifactId = chat.controller.openArtifact('html', { payload: { html: legacy } });
    chat.controller.appendMessage({ id, createdAt: 1, kind: 'html', html: legacy, artifactId });
    const snapshot = chat.controller.serialize();
    const reopened = new SyntheticChat(new ChatController({ hydrateFrom: snapshot }));
    const turn = reopened.mount();
    const assertLegacy = () => {
      expect(reopened.controller.artifacts.value).toEqual({ list: [], activeId: null });
      expect(reopened.controller.messages.value).toHaveLength(1);
      const markup = turn.find('.iso-host').element.shadowRoot!;
      expect(markup.querySelectorAll('table td')).toHaveLength(1);
      expect(markup.querySelector('td')?.textContent).toBe('legacy row');
      expect(markup.querySelector('iframe, [onclick]')).toBeNull();
    };
    assertLegacy();
    reopened.send('thread_restored', { messages: [{ id, role: 'assistant', kind: 'html', content: legacy }] });
    await nextTick();
    assertLegacy();
    reopened.controller.hydrate(snapshot);
    await nextTick();
    assertLegacy();
    turn.unmount();
    chat.controller.dispose();
    reopened.controller.dispose();
  });

  it('preserves explicit artifact focus when ordinary formatted replies arrive', () => {
    // risk: removing auto-promotion must neither break explicitly opened artifacts nor steal their focus.
    const chat = new SyntheticChat();
    chat.publishArtifact({
      id: 'explicit-code', kind: 'code', name: 'fixture.js', path: 'fixture.js', language: 'javascript',
      content: 'const example = 1;', status: 'done', isOpen: true, isDeleted: false,
      threadId: 'fixture-thread', version: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    });
    chat.send('assistant_message', { kind: 'text', content: documentReply });
    const reopened = new ChatController({ hydrateFrom: chat.controller.serialize() });
    for (const controller of [chat.controller, reopened]) {
      expect(controller.artifacts.value.list).toMatchObject([{ id: 'explicit-code', kind: 'code', persistent: true }]);
      expect(controller.activeArtifact.value?.id).toBe('explicit-code');
      controller.dispose();
    }
  });
});
