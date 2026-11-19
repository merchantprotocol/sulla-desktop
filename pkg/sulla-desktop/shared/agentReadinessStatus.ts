// SPDX-License-Identifier: GPL-2.0-or-later

export interface ReadinessStatus {
  readinessWaitId: string;
  readinessState:  'waiting' | 'resumed' | 'cancelled';
}

/** A transient check is updated in place, then removed on recovery or cancellation. */
interface ReadinessMessage { id: string; channelId: string; threadId?: string; role: string; kind?: string; content: string; readinessCleared?: boolean }
const LEGACY_WAIT = /^Waiting for (?:required services|database|recovery storage|model configuration|Password Vault|vault unlock|paused agents)\. (?:Work|Sulla) will continue when it is ready\.$/;

export class AgentReadinessStatus {
  static async wait(
    wait: (signal: AbortSignal | undefined, waiting: (reason: string) => void) => Promise<void>,
    signal: AbortSignal | undefined,
    publish: (content: string, status: ReadinessStatus) => Promise<unknown>,
  ): Promise<void> {
    const readinessWaitId = `readiness-${ globalThis.crypto.randomUUID() }`;
    let updates = Promise.resolve();
    let resumed = false;
    const send = (content: string, readinessState: ReadinessStatus['readinessState']) => {
      updates = updates.then(async() => { await publish(content, { readinessWaitId, readinessState }) })
        .catch(() => { console.warn('[AgentReadiness] Could not publish transient status') });
    };
    try {
      await wait(signal, reason => send(reason === 'Password Vault'
        ? 'Connecting to Password Vault. Sulla is retrying; this does not mean the vault is locked.'
        : reason === 'vault unlock'
          ? 'Password Vault is locked. Work will continue after it unlocks.'
          : `Waiting for ${ reason }. Sulla will retry automatically.`, 'waiting'));
      resumed = true;
    } finally {
      // Even an immediately successful check can clear a legacy waiting bubble.
      send('', resumed ? 'resumed' : 'cancelled');
      await updates;
    }
  }

  /** Consumes only our scoped status events, without changing chat run state. */
  static apply(messages: ReadinessMessage[], channelId: string, threadId: string, data: Record<string, unknown>): boolean {
    const id = data.readinessWaitId;
    const state = data.readinessState;
    if (typeof id !== 'string' || !/^readiness-[a-f0-9-]{36}$/.test(id) || !['waiting', 'resumed', 'cancelled'].includes(String(state))) return false;
    const scoped = (message: ReadinessMessage) => message.channelId === channelId && message.threadId === threadId && message.role === 'assistant';
    if (state !== 'waiting') {
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (scoped(message) && (message.id === id || (state === 'resumed' && message.kind === 'progress' && LEGACY_WAIT.test(message.content)))) { message.content = ''; message.readinessCleared = true }
      }
      return true;
    }
    if (typeof data.content !== 'string' || !data.content.trim()) return true;
    const existing = messages.find(message => message.id === id && scoped(message));
    if (existing) existing.content = data.content;
    else messages.push({ id, channelId, threadId, role: 'assistant', kind: 'progress', content: data.content });
    return true;
  }
}
