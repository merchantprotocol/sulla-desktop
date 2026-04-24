// Slash commands + mention targets available from the composer popover.

export interface SlashCommand {
  name:   string;     // "/clear" (includes the slash)
  label:  string;     // Human description shown in the popover
  hint?:  string;     // Keyboard hint shown on the right
  action?: 'clear' | 'new' | 'help' | 'model' | 'loop' | 'schedule' | 'voice' | 'pin' | 'fork';
}

export interface MentionTarget {
  /** The token inserted into the composer (e.g. "@file:GuestBridge.ts") */
  token:  string;
  label:  string;     // human-readable
  kind:   'file' | 'memory' | 'agent' | 'thread';
}

export const defaultSlashCommands: readonly SlashCommand[] = Object.freeze([
  { name: '/clear',    label: 'clear this conversation',        action: 'clear' },
  { name: '/new',      label: 'start a new chat',               hint: '⌘N', action: 'new' },
  { name: '/help',     label: 'show keyboard shortcuts',        hint: '?',  action: 'help' },
  { name: '/model',    label: 'switch model',                   hint: '⌘K', action: 'model' },
  { name: '/loop',     label: 'run this prompt on an interval',             action: 'loop' },
  { name: '/schedule', label: 'schedule a remote agent',                    action: 'schedule' },
  { name: '/voice',    label: 'start voice input',              hint: '⌘/', action: 'voice' },
  { name: '/pin',      label: 'pin the last reply',                         action: 'pin' },
  { name: '/fork',     label: 'branch this chat',                           action: 'fork' },
]);

export interface PopoverState {
  open:     boolean;
  mode:     'slash' | 'mention' | null;
  items:    readonly (SlashCommand | MentionTarget)[];
  selected: number;  // index into items
  query:    string;
}

export const popoverClosed = (): PopoverState => ({
  open: false, mode: null, items: [], selected: 0, query: '',
});
