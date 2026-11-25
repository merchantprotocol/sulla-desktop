// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Discriminated union of every message kind that can appear in a transcript.
// Each kind has a dedicated component in `components/` that renders it.
//
// Adding a new message kind:
//   1. Add a new member to MessageKind + a new interface extending MessageBase
//   2. Register a component in components/transcript/MessageRouter.vue
//   3. Done. TypeScript will force you to handle it everywhere that matters.

import type { AgentResultCardData } from '@pkg/shared/agentResults/AgentResultCard';

import type { ArtifactId, AttachmentId, MessageId } from '../types/chat';

export type MessageKind =
  | 'user'
  | 'sulla'
  | 'streaming'     // Sulla response still arriving
  | 'thinking'
  | 'tool'
  | 'tool_approval'
  | 'tool_question'
  | 'patch'
  | 'channel'       // message from another agent (for example Heartbeat or Mobile)
  | 'subagent'      // sub-agent activity
  | 'subagent_exchange' // compact parent ↔ sub-agent handoff
  | 'citation'      // grounding sources
  | 'memory'        // memory saved/removed/updated
  | 'proactive'     // Sulla reaching out unprompted
  | 'heartbeat'     // scheduled wake for this thread
  | 'tts'           // Sulla is currently speaking (transient)
  | 'interim'       // user voice transcript being drafted (transient)
  | 'error'         // error/recovery
  | 'notice'        // neutral informational notice
  | 'html'
  | 'inline_file_reference';

export interface MessageBase {
  readonly id:        MessageId;
  readonly kind:      MessageKind;
  readonly createdAt: number;
  readonly turnId?:   string;  // groups messages that belong to one logical turn
  /** For pinning/bookmarking */
  agentReporting?: 'brief' | 'standard';
  pinned?:            boolean;
  /** The agent and model that were running when this block arrived (work blocks only). */
  by?:                { agent?: string; model?: string; modelStatus?: import('../../../shared/agentState/AgentModelStatus').AgentModelStatusValue };
}

// ─── User ─────────────────────────────────────────────────────────
export interface UserMessage extends MessageBase {
  kind:           'user';
  text:           string;
  voiceIdentity?: { voiceId: string; voiceLabel: string; isOwner: boolean; score: number };
  attachments?:   readonly AttachedFile[];
  /** If this turn is a re-run of an earlier message */
  editedFrom?:    MessageId;
}

export interface AttachedFile {
  id:       AttachmentId;
  name:     string;
  size:     string;  // humanized e.g. "48 KB"
  kind:     'image' | 'json' | 'ts' | 'md' | 'log' | 'file';
  url?:     string;  // data URL for images (optional)
  fileRef?: {
    fileId:          string;
    versionId:       string;
    path:            string;
    mime:            string;
    size:            number;
    createdByType?:  string;
    createdById?:    string;
    collectionId?:   string;
    collectionKind?: string;
    agentRunId?:     string;
  };
}

// ─── Sulla (complete) + Streaming (in-flight) ────────────────────
export interface SullaMessage extends MessageBase {
  decisionFollowUpId?: string;
  /** Stable identifier shared by completed text segments from one assistant turn. */
  replyStreamId?: string;
  kind:            'sulla';
  text:            string;        // markdown-ish; rendered by prose component
  /** Legacy snapshots may contain a selector value, not the model that ran. */
  model?:          string;
  /** Recorded on this reply's backend event, never inferred from the thread picker. */
  replyAttribution?: { agent?: string; model?: string };
  tokens?:         number;
  /** Keep the existing reply renderer for run-ending assistant posts. */
  terminalRunError?: boolean;
  fileReferences?: readonly AttachedFile[];
  /** Only inline links were found; no structured attachments were recorded. */
  fileReferencesInferred?: true;
}

export interface StreamingMessage extends MessageBase {
  decisionFollowUpId?: string;
  /** Stable identifier shared by streamed text segments from one assistant turn. */
  replyStreamId?: string;
  kind:      'streaming';
  text:      string;        // grows over time
  startedAt: number;
}

// ─── Thinking (live / settled / expanded rendered by Thinking.vue) ─
export interface ThinkingMessage extends MessageBase {
  kind:         'thinking';
  chatToolActivity?: import('../../../agent/tools/ChatToolReporting').ChatToolActivity;
  reportingActivity?: 'status' | 'tool';
  thoughts:     readonly string[];  // appended to while live
  startedAt:    number;
  completed:    boolean;            // false = live streaming
  completedAt?: number;            // wall-clock ms when completed flipped true — used to freeze the elapsed timer
  summary?:     string;             // one-line summary when settled
}

// ─── Tool call ────────────────────────────────────────────────────
export interface ToolMessage extends MessageBase {
  kind:          'tool';
  providerTool?: boolean;
  toolPayloadRef?: { threadId: string; toolRunId: string };
  recordedToolName?: string;
  tool:          string;        // Standard-view label; Detailed uses recordedToolName
  desc:          string;        // formatter description when available
  status:        'running' | 'ok' | 'error';
  meta?:         string;
  input?:        string;        // full serialized arguments
  output?:       string;        // full captured result
  error?:        string;        // failure detail
  outputFormat?: 'text' | 'code' | 'url' | 'json';
}

// ─── Tool approval ────────────────────────────────────────────────
export interface ToolApprovalMessage extends MessageBase {
  resolutionError?: string;
  kind:             'tool_approval';
  reason:           string;         // what Sulla wants to do & why
  command:          string;         // the exact command/action
  title?:           string;         // durable approval title from DecisionService
  expiresAt?:       number;         // DecisionService deadline, retained with the transcript
  decision:         'pending' | 'approved' | 'denied' | 'timed_out';
  /** Round-trip id that the renderer sends back on approve/deny so the
   *  backend's pending promise (parked in ApprovalService) can settle. */
  approvalId?:      string;
  /** Optional origin tag — tool / workflow / vault / function / etc. */
  origin?:          { kind: string; [field: string]: unknown };
  requestedBy?:     { agentId?: string; label?: string };
}

// ─── Tool question (multiple choice) ──────────────────────────────
export interface ToolQuestionOption {
  label:        string;
  description?: string;
}
export interface ToolQuestionItem {
  question:     string;
  header?:      string;
  multiSelect?: boolean;
  options:      readonly ToolQuestionOption[];
  /** Something the user must do, answered with Done (see ask_user_question `task`). */
  task?:        boolean;
  /** For a task: the command the user runs. */
  command?:     string;
}
/** One element of the user's answer — the selected option labels (and/or
 *  free-form text) for a single question. */
export interface ToolQuestionAnswerItem {
  question: string;
  selected: readonly string[];
}
export interface ToolQuestionMessage extends MessageBase {
  resolutionError?: string;
  resolutionNote?:  string;
  kind:             'tool_question';
  questions:        readonly ToolQuestionItem[];
  status:           'pending' | 'answered' | 'timed_out';
  /** Round-trip id sent back on answer so the backend's parked promise
   *  (ApprovalService.parkQuestion) can settle. */
  questionId?:      string;
  /** Populated once the user answers — mirrors what was sent back. */
  answers?:         readonly ToolQuestionAnswerItem[];
  /** When the backend stops waiting for an answer (ms epoch), from the decisions store. */
  expiresAt?:       number;
}

// ─── Patch ────────────────────────────────────────────────────────
export interface PatchMessage extends MessageBase {
  kind:        'patch';
  path:        string;         // "pkg/sulla-desktop/main/browserTabs/GuestBridge.ts"
  stat:        { added: number; removed: number };
  hunks:       readonly PatchHunk[];
  state:       'proposed' | 'applied' | 'rejected';
  /** Opaque payload used by the main-process revert handler. Only present
   *  for patches emitted post-hoc after an agent Edit/Write tool_use. */
  revertMeta?: PatchRevertMeta;
}
export type PatchRevertMeta =
  | { op: 'edit'; path: string; oldString: string; newString: string }
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
  agent:   string;          // e.g. "Heartbeat" | "Mobile"
  channel: string;          // e.g. "heartbeat"
  text:    string;          // HTML/markdown-ish
  senderLabel?: string;
  senderThreadId?: string;
  senderJobId?: string;
}

// ─── Sub-agent activity ───────────────────────────────────────────
export interface SubAgentMessage extends MessageBase {
  kind:   'subagent';
  name:   string;          // "code-researcher"
  desc:   string;          // current step or final summary
  status: 'running' | 'done' | 'error';
  steps:  readonly { tag: string; text: string }[];
}

export interface SubAgentExchangeMessage extends MessageBase {
  kind:            'subagent_exchange';
  direction:       'to_agent' | 'from_agent';
  agentId:         string;
  label:           string;
  summary:         string;
  detail:          string;
  status:          'running' | 'done' | 'failed' | 'stopped';
  jobId?:          string;
  taskIndex?:      number;
  conversationId?: string;
  native?:         boolean;
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
  kind:     'memory';
  memId:    string;           // e.g. "w9oK"
  action:   'saved' | 'updated' | 'removed';
  summary?: string;
}

// ─── Proactive ────────────────────────────────────────────────────
export interface ProactiveMessage extends MessageBase {
  kind:     'proactive';
  headline: string;
  body:     string;         // markdown-ish
  /** Finished background agents: drawn as a result card instead of the text. */
  result?:  AgentResultCardData;
}

export interface HeartbeatMessage extends MessageBase {
  kind:            'heartbeat';
  text:            string;
  intervalMinutes: number;
}

// ─── TTS (transient speaking indicator) ──────────────────────────
export interface TtsMessage extends MessageBase {
  kind:    'tts';
  text:    string;       // what's being spoken
  refId?:  MessageId;    // the sulla message this narrates
  endsAt?: number;       // expected end
}

// ─── Interim user voice transcript ────────────────────────────────
export interface InterimMessage extends MessageBase {
  kind:      'interim';
  text:      string;      // grows as user speaks
  startedAt: number;
}

// ─── Error ────────────────────────────────────────────────────────
export interface ErrorMessage extends MessageBase {
  kind:    'error';
  text:    string;
  detail?: string;
  action?: { label: string; kind: 'retry' | 'continue' | 'dismiss' | 'connect' };
}

export interface NoticeMessage extends MessageBase {
  kind:    'notice';
  text:    string;
  detail?: string;
  action?: { label: string; kind: 'retry' | 'continue' | 'dismiss' | 'connect' };
}

// ─── HTML reply ───────────────────────────────────────────────────
export interface HtmlMessage extends MessageBase {
  kind:        'html';
  html:        string;      // sanitized by the inline renderer
  artifactId?: ArtifactId;  // legacy snapshot link, never assigned to new replies
}


export interface InlineFileReferenceMessage extends MessageBase {
  kind: 'inline_file_reference';
  fileId: string;
  collectionId: string;
  toolCallId: string;
  threadId: string;
}

// ─── The union ────────────────────────────────────────────────────
export type Message =
  | UserMessage
  | SullaMessage
  | StreamingMessage
  | ThinkingMessage
  | ToolMessage
  | ToolApprovalMessage
  | ToolQuestionMessage
  | PatchMessage
  | ChannelMessage
  | SubAgentMessage
  | SubAgentExchangeMessage
  | CitationMessage
  | MemoryMessage
  | ProactiveMessage
  | HeartbeatMessage
  | TtsMessage
  | InterimMessage
  | ErrorMessage
  | NoticeMessage
  | HtmlMessage
  | InlineFileReferenceMessage;

export const isTransient = (m: Message): boolean =>
  m.kind === 'streaming' || m.kind === 'tts' || m.kind === 'interim';
