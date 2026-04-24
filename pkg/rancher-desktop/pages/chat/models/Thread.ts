import type { ThreadId, ArtifactId }      from '../types/chat';
import type { Message }                   from './Message';
import type { Artifact }                  from './Artifact';
import type { Attachment }                from './Attachment';
import type { QueuedMessage }             from './QueuedMessage';
import type { PopoverState }              from './Command';
import type { RunState }                  from './RunState';
import type { VoiceState }                from './VoiceState';

export interface ModelDescriptor {
  id:     string;
  name:   string;
  tier:   'hosted' | 'local';
  ctx:    string;     // "1M ctx" | "200K ctx"
}

export type ConnectionState = 'online' | 'degraded' | 'offline';

export interface ModalState {
  which: 'model' | 'shortcuts' | 'search' | 'tokens' | null;
}

/**
 * Aggregate token and cost metrics for the current thread/session.
 * Mirrored from the backend's AgentPersonaService state via the adapter.
 */
export interface TokenUsage {
  totalTokens:       number;
  promptTokens:      number;
  completionTokens:  number;
  inputCost:         number;   // USD
  outputCost:        number;   // USD
  totalCost:         number;   // USD
  responseCount:     number;
  avgResponseMs:     number;
  tokensPerSecond:   number;
}

export const emptyTokenUsage = (): TokenUsage => ({
  totalTokens:      0,
  promptTokens:     0,
  completionTokens: 0,
  inputCost:        0,
  outputCost:       0,
  totalCost:        0,
  responseCount:    0,
  avgResponseMs:    0,
  tokensPerSecond:  0,
});

export interface SidebarState {
  historyOpen: boolean;
}

/**
 * A full, serializable snapshot of a single chat thread.
 *
 * The controller's state is a reactive wrapper around this; calling
 * `controller.serialize()` returns a ThreadState; `ChatController.hydrate(state)`
 * constructs a fresh controller bound to that state.
 *
 * Persistence happens at this granularity. Live mutations happen through the
 * controller so the reactive view layer can respond.
 */
export interface Thread {
  id:        ThreadId;
  title:     string;
  createdAt: number;
  updatedAt: number;
  messages:  Message[];
  /** Metadata about the backend conversation/thread (for resumption) */
  backendThreadId?: string;
}

/** The full saveable state of a live chat session. */
export interface ThreadState {
  thread:         Thread;
  runState:       RunState;
  queue:          QueuedMessage[];
  staged:         Attachment[];
  voice:          VoiceState;
  artifacts:      Artifact[];
  activeArtifactId: ArtifactId | null;
  popover:        PopoverState;
  modals:         ModalState;
  sidebar:        SidebarState;
  connection:     ConnectionState;
  model:          ModelDescriptor;
}
