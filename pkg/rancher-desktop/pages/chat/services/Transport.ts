/*
  Transport — the ONLY module that talks to the backend/WS/IPC.

  Phase 0: a stub that drives canned responses so the controller + UI
  can be exercised end-to-end without a real agent. Phase 5 swaps the
  internals to wire into AgentPersonaRegistry / ChatInterface.

  The transport *never* mutates state. It dispatches controller methods.
*/

import type { ChatController } from '../controller/ChatController';
import type { UserMessage, ThinkingMessage, ToolMessage, SullaMessage } from '../models/Message';
import { newMessageId, newTurnId } from '../types/chat';

export class Transport {
  constructor(private readonly controller: ChatController) {}

  /**
   * Demo/mock handler — in phase 0 we respond to every user send with
   * a canned thinking + tool + reply sequence so the UI is testable.
   */
  respondDemo(userMsg: UserMessage): void {
    const c = this.controller;
    const turnId = userMsg.turnId ?? newTurnId();

    // 1. Thinking pass
    const thinkingId = newMessageId();
    const thinking: ThinkingMessage = {
      id: thinkingId, kind: 'thinking', createdAt: Date.now(), turnId,
      thoughts: [], startedAt: Date.now(), completed: false,
    };
    c.appendMessage(thinking);
    c.transitionRun({ type: 'think', messageId: thinkingId });

    const thoughts = [
      'reading the room…',
      'this looks like the kind of race I saw yesterday',
      'checking whether the prior fix applies',
      'yes — same shape, different call site',
      'drafting the answer',
    ];
    let i = 0;
    const stream = setInterval(() => {
      if (i >= thoughts.length) {
        clearInterval(stream);
        c.updateMessage<ThinkingMessage>(thinkingId, {
          thoughts: [...thoughts],
          completed: true,
          summary: 'Traced it to the same compositor race — retry window covers it',
        });
        spawnTool();
        return;
      }
      const next = thoughts.slice(0, i + 1);
      c.updateMessage<ThinkingMessage>(thinkingId, { thoughts: next });
      i++;
    }, 550);

    const spawnTool = () => {
      const toolId = newMessageId();
      const tool: ToolMessage = {
        id: toolId, kind: 'tool', createdAt: Date.now(), turnId,
        tool: 'Grep', desc: 'captureScreenshot · pkg/rancher-desktop', status: 'running',
      };
      c.appendMessage(tool);
      c.transitionRun({ type: 'spawnTool', messageId: toolId, tool: 'Grep' });
      setTimeout(() => {
        c.updateMessage<ToolMessage>(toolId, { status: 'ok', meta: '4 hits · 94ms' });
        c.transitionRun({ type: 'toolDone' });
        spawnReply();
      }, 900);
    };

    const spawnReply = () => {
      const replyId = newMessageId();
      const reply: SullaMessage = {
        id: replyId, kind: 'sulla', createdAt: Date.now(), turnId,
        text: '', model: c.model.value.name,
      };
      c.appendMessage(reply);
      c.transitionRun({ type: 'stream', messageId: replyId });

      const fullText =
        'The symptom is real and the explanation is quiet: a newly-created `WebContentsView` placed off-screen hasn\'t painted yet. Chromium\'s compositor has nothing to hand back, so `capturePage` returns an empty NativeImage the very first time you ask.\n\n' +
        'A short retry loop inside `captureScreenshot` — **four attempts, four hundred milliseconds apart** — closes the race without any upstream changes.';

      let idx = 0;
      const tick = setInterval(() => {
        idx += 12;
        c.updateMessage<SullaMessage>(replyId, { text: fullText.slice(0, idx) });
        if (idx >= fullText.length) {
          clearInterval(tick);
          c.transitionRun({ type: 'streamEnd' });
        }
      }, 50);
    };
  }
}
