export const DEFAULT_CHAT_HEARTBEAT_MESSAGE =
  'Heartbeat: give me a short update on what moved since your last update, then keep working on anything unfinished. If nothing is in flight, reply in one line.';

export interface ChatHeartbeatConfig {
  intervalMinutes: number | null;
  message:         string;
}

export interface ChatHeartbeatStatus extends ChatHeartbeatConfig {
  threadId: string;
  enabled:  boolean;
  nextAt:   number | null;
  pending:  boolean;
}

export interface ChatHeartbeatBeat {
  threadId:        string;
  createdAt:       number;
  intervalMinutes: number;
  message:         string;
}

export function defaultChatHeartbeatConfig(): ChatHeartbeatConfig {
  return {
    intervalMinutes: null,
    message:          DEFAULT_CHAT_HEARTBEAT_MESSAGE,
  };
}

export function normalizeChatHeartbeatConfig(input?: Partial<ChatHeartbeatConfig> | null): ChatHeartbeatConfig {
  const rawInterval = Number(input?.intervalMinutes);
  const intervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0
    ? Math.min(rawInterval, 24 * 60)
    : null;
  const message = typeof input?.message === 'string' && input.message.trim()
    ? input.message.trim()
    : DEFAULT_CHAT_HEARTBEAT_MESSAGE;

  return { intervalMinutes, message };
}
