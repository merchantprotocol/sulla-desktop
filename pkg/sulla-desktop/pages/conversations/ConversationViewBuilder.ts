// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ConversationMessageData, ConversationThreadProjection } from './ConversationProjection';
import type { AvatarTone, MessageView, PersonView, PresenceClass, ThreadView } from './ConversationScreenStore';

/** A directory entry as the org host sends it. Only userId and displayName are guaranteed. */
export interface DirectoryPerson { userId: string; displayName: string; presence?: string; agentHostOnline?: boolean; agentName?: string; role?: string }

const TONES: AvatarTone[] = ['', 'm', 'p', 'd'];
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS: Record<PresenceClass, string> = { online: 'Active now', busy: 'Busy', away: 'Away', offline: 'Offline' };
const CONTROL_TEXT: Record<string, string> = {
  halt: 'stopped this thread',
  resume: 'resumed this thread',
  takeover: 'took over',
  release: 'handed back to the agent',
  allow_contact: 'allowed contact',
  block_contact: 'blocked contact',
};

/**
 * Turns the real directory and inbox data into the view rows the approved mockup templates render:
 * the People rows, the thread rows and the message rows (with day dividers, agent pills and system pills).
 * Pure: no IPC and no Vue, so the mapping rules can be tested directly.
 */
export class ConversationViewBuilder {
  constructor(
    private readonly people: readonly DirectoryPerson[],
    private readonly userId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  displayName(id: string): string {
    return this.people.find(person => person.userId === id)?.displayName ?? 'Organization member';
  }

  initials(label: string): string {
    return label.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase() || '?';
  }

  /** A stable gradient tone per member, so a person keeps the same avatar colour everywhere. You are always `a`. */
  tone(id: string): AvatarTone {
    if (id === this.userId) return 'a';
    let hash = 0;
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return TONES[hash % TONES.length];
  }

  presenceClass(presence: string | undefined): PresenceClass {
    const value = (presence ?? '').toLowerCase();
    if (value === 'online' || value === 'active' || value === 'available') return 'online';
    if (value === 'busy' || value === 'dnd') return 'busy';
    if (value === 'away' || value === 'idle') return 'away';
    return 'offline';
  }

  person(entry: DirectoryPerson): PersonView {
    const presenceClass = this.presenceClass(entry.presence);
    return {
      id: entry.userId,
      name: entry.displayName,
      firstName: entry.displayName.split(/\s+/)[0] || entry.displayName,
      initials: this.initials(entry.displayName),
      tone: this.tone(entry.userId),
      presence: entry.presence ?? '',
      presenceClass,
      status: entry.userId === this.userId && presenceClass === 'online' ? 'Available' : STATUS[presenceClass],
      role: typeof entry.role === 'string' ? entry.role.charAt(0).toUpperCase() + entry.role.slice(1) : '',
      agentOnline: !!entry.agentHostOnline,
    };
  }

  thread(thread: ConversationThreadProjection): ThreadView {
    const last = thread.messages.at(-1);
    const withId = thread.participantIds.find(id => id !== this.userId) ?? '';
    // Mockup agent-thread title: "Your agent and Alex's agent".
    const title = thread.kind === 'agent_thread' && withId ? `Your agent and ${this.displayName(withId).split(/\s+/)[0]}'s agent` : thread.title;
    return {
      id: thread.id,
      kind: thread.kind,
      title,
      participantIds: thread.participantIds,
      latest: last ? this.preview(last, thread.kind) : thread.latest,
      time: this.listTime(last?.createdAt ?? ''),
      unread: thread.unread,
      withId,
    };
  }

  /** The .t2 preview line: "You: ..." for your own messages, "Name: ..." in groups, like the mockup. */
  preview(message: ConversationMessageData, kind: ConversationThreadProjection['kind']): string {
    if (message.kind === 'control' || message.kind === 'system') return this.message(message).text;
    if (message.from.agentId) return message.body.text;
    if (message.from.userId === this.userId) return `You: ${message.body.text}`;
    if (kind === 'group') return `${this.displayName(message.from.userId).split(/\s+/)[0]}: ${message.body.text}`;
    return message.body.text;
  }

  message(message: ConversationMessageData): MessageView {
    const time = this.messageTime(message.createdAt);
    const day = this.dayLabel(message.createdAt);
    const fromName = message.from.userId === this.userId ? 'You' : this.displayName(message.from.userId);
    const base = { id: message.messageId, time, day, initials: '', tone: '' as AvatarTone, theirs: false, actsFor: '', sysTone: '' as const };
    if (message.kind === 'control' || message.kind === 'system') {
      const action = message.control?.action ?? '';
      const verb = CONTROL_TEXT[action];
      const text = verb ? `${fromName} ${verb}${time ? ` at ${time}` : ''}` : message.body.text;
      return { ...base, side: 'system', name: fromName, text, sysTone: action === 'halt' || action === 'block_contact' ? 'bad' : '' };
    }
    if (message.from.agentId) {
      const theirs = message.from.userId !== this.userId;
      const owner = this.displayName(message.from.userId);
      return {
        ...base,
        side: 'agent',
        theirs,
        name: theirs ? `${owner.split(/\s+/)[0]}'s agent` : 'Your agent',
        actsFor: theirs ? `Agent · acts for ${owner}` : 'Agent · acts for you',
        text: message.body.text,
      };
    }
    const mine = message.from.userId === this.userId;
    const name = mine ? 'You' : this.displayName(message.from.userId);
    const initialsSource = mine ? this.displayName(this.userId) : name;
    return { ...base, side: mine ? 'me' : 'person', name, initials: this.initials(initialsSource), tone: this.tone(message.from.userId), text: message.body.text };
  }

  /** Day divider text: TODAY, YESTERDAY, the weekday within the last week, otherwise NOV 3 (or NOV 3, 2025 for other years). */
  dayLabel(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '';
    const days = this.daysAgo(date);
    if (days === 0) return 'TODAY';
    if (days === 1) return 'YESTERDAY';
    if (days > 1 && days < 7) return DAYS[date.getDay()];
    const label = `${MONTHS[date.getMonth()].toUpperCase()} ${date.getDate()}`;
    return date.getFullYear() === this.now().getFullYear() ? label : `${label}, ${date.getFullYear()}`;
  }

  /** Thread list time: the clock time today, then Yesterday, the short weekday, then Nov 3. */
  listTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '';
    const days = this.daysAgo(date);
    if (days <= 0) return this.messageTime(value);
    if (days === 1) return 'Yesterday';
    if (days < 7) return SHORT_DAYS[date.getDay()];
    return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  }

  messageTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  private daysAgo(date: Date): number {
    const now = this.now();
    const start = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).valueOf();
    return Math.round((start(now) - start(date)) / 86_400_000);
  }
}
