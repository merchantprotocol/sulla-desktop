// Discriminated union of every message kind that can appear in a transcript.
// Each kind has a dedicated component in `components/` that renders it.
//
// Adding a new message kind:
//   1. Add a new member to MessageKind + a new interface extending MessageBase
//   2. Register a component in components/transcript/MessageRouter.vue
//   3. Done. TypeScript will force you to handle it everywhere that matters.

import type { ArtifactId, AttachmentId, MessageId } from '../types/chat';

export type MessageKind =
  | 'user'
  | 'sulla'
  | 'streaming'     // Sulla response still arriving
  | 'thinking'
  | 'tool'
  | 'tool_approval'
  | 'patch'
  | 'channel'       // message from another agent (Heartbeat, Workbench, Mobile)
  | 'subagent'      // sub-agent activity
  | 'citation'      // grounding sources
  | 'memory'        // memory saved/removed/updated
  | 'proactive'     // Sulla reaching out unprompted
  | 'tts'           // Sulla is currently speaking (transient)
  | 'interim'       // user voice transcript being drafted (transient)
  | 'error'         // error/recovery
  | 'html';         // rich HTML reply

export interface MessageBase {
  readonly id:        MessageId;
  readonly kind:      MessageKind;
  readonly createdAt: number;
  readonly turnId?:   string;  // groups messages that belong to one logical turn
  /** For pinning/bookmarking */
  pinned?:            boolean;
}

// ─── User ─────────────────────────────────────────────────────────
export interface UserMessage extends MessageBase {
  kind:         'user';
  text:         string;
  attachments?: readonly AttachedFile[];
  /** If this turn is a re-run of an earlier message */
  editedFrom?:  MessageId;
}

export interface AttachedFile {
  id:     AttachmentId;
  name:   string;
  size:   string;  // humanized e.g. "48 KB"
  kind:   'image' | 'json' | 'ts' | 'md' | 'log' | 'file';
  url?:   string;  // data URL for images (optional)
}

// ─── Sulla (complete) + Streaming (in-flight) ────────────────────
export interface SullaMessage extends MessageBase {
  kind:       'sulla';
  text:       string;        // markdown-ish; rendered by prose component
  model:      string;        // e.g. "opus-4.7"
  tokens?:    number;
}

export interface StreamingMessage extends MessageBase {
  kind:       'streaming';
  text:       string;        // grows over time
  startedAt:  number;
}

// ─── Thinking (live / settled / expanded rendered by Thinking.vue) ─
export interface ThinkingMessage extends MessageBase {
  kind:        'thinking';
  thoughts:    readonly string[];  // appended to while live
  startedAt:   number;
  completed:   boolean;            // false = live streaming
  completedAt?: number;            // wall-clock ms when completed flipped true — used to freeze the elapsed timer
  summary?:    string;             // one-line summary when settled
}

// ─── Tool call ────────────────────────────────────────────────────
export interface ToolMessage extends MessageBase {
  kind:       'tool';
  tool:       string;        // "Grep" | "Read" | "Bash" | …
  desc:       string;        // short human description
  status:     'running' | 'ok' | 'error';
  meta?:      string;        // "8 hits · 120ms" | "exit 0 · 94ms" | …
  output?:    string;        // captured output (may be truncated)
}

// ─── Tool approval ────────────────────────────────────────────────
export interface ToolApprovalMessage extends MessageBase {
  kind:        'tool_approval';
  reason:      string;         // what Sulla wants to do & why
  command:     string;         // the exact command/action
  decision:    'pending' | 'approved' | 'denied' | 'timed_out';
  /** Round-trip id that the renderer sends back on approve/deny so the
   *  backend's pending promise (parked in ApprovalService) can settle. */
  approvalId?: string;
  /** Optional origin tag — tool / workflow / vault / function / etc. */
  origin?:     { kind: string; [field: string]: unknown };
}

// ─── Patch ────────────────────────────────────────────────────────
export interface PatchMessage extends MessageBase {
  kind:     'patch';
  path:     string;         // "pkg/rancher-desktop/main/browserTabs/GuestBridge.ts"
  stat:     { added: number; removed: number };
  hunks:    readonly PatchHunk[];
  state:    'proposed' | 'applied' | 'rejected';
  /** Opaque payload used by the main-process revert handler. Only present
   *  for patches emitted post-hoc after an agent Edit/Write tool_use. */
  revertMeta?: PatchRevertMeta;
}
export type PatchRevertMeta =
  | { op: 'edit';  path: string; oldString: string; newString: string }
  | { op: 'write'; path: string; oldContent: string };
export interface PatchHunk {
  lines: readonly PatchLine[];
}
export interface PatchLine {
  n:    number;      // line number (new side)
  text: string;      // syntax-highlighted html ok
  op:   'add' | 'remove' | 'context';
}

// ─── Channel (other agent) ────────────────────────────────────────
export interface ChannelMessage extends MessageBase {
  kind:    'channel';
  agent:   string;          // "Heartbeat" | "Workbench" | "Mobile"
  channel: string;          // e.g. "heartbeat"
  text:    string;          // HTML/markdown-ish
}

// ─── Sub-agent activity ───────────────────────────────────────────
export interface SubAgentMessage extends MessageBase {
  kind:    'subagent';
  name:    string;          // "code-researcher"
  desc:    string;          // current step or final summary
  status:  'running' | 'done' | 'error';
  steps:   readonly { tag: string; text: string }[];
}

// ─── Citations ────────────────────────────────────────────────────
export interface CitationMessage extends MessageBase {
  kind:    'citation';
  sources: readonly Citation[];
}
export interface Citation {
  num:    number;
  title:  string;
  origin: string;           // "electronjs.org" | "browserTabs" | "sulla-memory"
  url?:   string;
}

// ─── Memory saved/updated/removed ────────────────────────────────
export interface MemoryMessage extends MessageBase {
  kind:   'memory';
  memId:  string;           // e.g. "w9oK"
  action: 'saved' | 'updated' | 'removed';
  summary?: string;
}

// ─── Proactive ────────────────────────────────────────────────────
export interface ProactiveMessage extends MessageBase {
  kind:     'proactive';
  headline: string;
  body:     string;         // markdown-ish
}

// ─── TTS (transient speaking indicator) ──────────────────────────
export interface TtsMessage extends MessageBase {
  kind:       'tts';
  text:       string;       // what's being spoken
  refId?:     MessageId;    // the sulla message this narrates
  endsAt?:    number;       // expected end
}

// ─── Interim user voice transcript ────────────────────────────────
export interface InterimMessage extends MessageBase {
  kind:        'interim';
  text:        string;      // grows as user speaks
  startedAt:   number;
}

// ─── Error ────────────────────────────────────────────────────────
export interface ErrorMessage extends MessageBase {
  kind:    'error';
  text:    string;
  detail?: string;
  action?: { label: string; kind: 'retry' | 'continue' | 'dismiss' };
}

// ─── HTML reply ───────────────────────────────────────────────────
export interface HtmlMessage extends MessageBase {
  kind:     'html';
  html:     string;         // sanitized
  artifactId?: ArtifactId;  // if rendered as a separate artifact
}

// ─── The union ────────────────────────────────────────────────────
export type Message =
  | UserMessage
  | SullaMessage
  | StreamingMessage
  | ThinkingMessage
  | ToolMessage
  | ToolApprovalMessage
  | PatchMessage
  | ChannelMessage
  | SubAgentMessage
  | CitationMessage
  | MemoryMessage
  | ProactiveMessage
  | TtsMessage
  | InterimMessage
  | ErrorMessage
  | HtmlMessage;

export const isTransient = (m: Message): boolean =>
  m.kind === 'streaming' || m.kind === 'tts' || m.kind === 'interim';
