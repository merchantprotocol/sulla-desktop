// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { reactive } from 'vue';

export const CONV_STORE = Symbol('conversations-screen-store');

/** One row in the org switcher. Comes from the org conversations IPC. */
export interface OrgView { id: string; name: string; initials: string; memberCount: number }
/** Avatar gradient tone from the mockup: '' (blue), m (amber), d (violet), p (green), a (you). */
export type AvatarTone = '' | 'm' | 'd' | 'p' | 'a';
/** Presence dot class from the mockup. An empty value means online (the default green dot). */
export type PresenceClass = 'online' | 'busy' | 'away' | 'offline';
/** A member of the active org, from the directory IPC. Role is empty when the directory doesn't send one. */
export interface PersonView { id: string; name: string; firstName: string; initials: string; tone: AvatarTone; presence: string; presenceClass: PresenceClass; status: string; role: string; agentOnline: boolean }
/** A projected conversation for the active org. `withId` is the other person in a direct or agent thread. */
export interface ThreadView { id: string; kind: 'direct' | 'group' | 'agent_thread'; title: string; participantIds: string[]; latest: string; time: string; unread: number; withId: string }
/** A pending contact request (read-only). Accepting or declining is not wired yet. */
export interface RequestView { senderId: string; name: string; initials: string; latest: string; time: string; count: number }
/**
 * One message row. Text is plain user content and is rendered escaped. `side` picks the mockup template:
 * me (youMsg), person (pMsg), agent (agentMsg, `theirs` for another member's agent) or system (a .sys pill).
 * `day` is the divider label (TODAY, YESTERDAY, MONDAY...) for the message's calendar day.
 */
export interface MessageView { id: string; side: 'me' | 'person' | 'agent' | 'system'; name: string; initials: string; tone: AvatarTone; theirs: boolean; actsFor: string; time: string; day: string; text: string; sysTone: '' | 'bad' }

/** Everything the screens render. The root builds it from the real IPC data only. */
export interface LiveSnapshot {
  orgId: string;
  orgName: string;
  orgs: OrgView[];
  /** The signed-in member (the YOU group). Null until the directory lists them. */
  me: PersonView | null;
  people: PersonView[];
  threads: ThreadView[];
  requests: RequestView[];
  bodies: Record<string, MessageView[]>;
}

export type ListTab = 'threads' | 'people' | 'agents' | 'notes' | 'followed';

export interface ConvState {
  org: string;
  listTab: ListTab;
  thread: string | null;
  orgMenu: boolean;
  infoOpen: boolean;
}

/**
 * Owns the Conversations screen state. Every list, body and label comes from the live snapshot the
 * root builds from the org conversations IPC. With no snapshot the screens show their empty states.
 */
export class ConversationScreenStore {
  readonly s = reactive<ConvState>({ org: '', listTab: 'threads', thread: null, orgMenu: false, infoOpen: false });
  private snapshot: LiveSnapshot | null = null;

  /** Root hooks: send a message, switch the active org, open a direct conversation, open Secretary Mode. */
  sendHandler: ((text: string) => void) | null = null;
  orgSwitchHandler: ((orgId: string) => void) | null = null;
  directHandler: ((personId: string) => void) | null = null;
  groupHandler: ((personIds: string[]) => void) | null = null;
  secretaryHandler: (() => void) | null = null;

  setLive(snapshot: LiveSnapshot | null): void {
    this.snapshot = snapshot;
    if (snapshot) this.s.org = snapshot.orgId;
    if (this.s.thread && !this.threads().some(thread => thread.id === this.s.thread)) this.s.thread = null;
  }

  orgs(): OrgView[] { return this.snapshot?.orgs ?? []; }
  org(): OrgView { return this.orgs().find(org => org.id === this.s.org) ?? { id: '', name: '', initials: '', memberCount: 0 }; }
  me(): PersonView | null { return this.snapshot?.me ?? null; }
  people(): PersonView[] { return this.snapshot?.people ?? []; }
  requests(): RequestView[] { return this.snapshot?.requests ?? []; }
  threads(): ThreadView[] { return this.snapshot?.threads ?? []; }
  thread(id: string | null): ThreadView | undefined { return id ? this.threads().find(thread => thread.id === id) : undefined; }
  personFor(id: string): PersonView | undefined { return this.people().find(person => person.id === id) ?? (this.me()?.id === id ? this.me() ?? undefined : undefined); }
  bodyFor(id: string | null): MessageView[] { return id && this.snapshot ? this.snapshot.bodies[id] ?? [] : []; }

  /** Agent threads and the main list come from projected data. Followed threads and notes have no backend yet. */
  threadsForTab(): ThreadView[] {
    if (this.s.listTab === 'agents') return this.threads().filter(thread => thread.kind === 'agent_thread');
    return this.threads();
  }

  openThread(id: string): void {
    this.s.thread = id;
    this.s.infoOpen = false;
  }

  setListTab(tab: ListTab): void { this.s.listTab = tab; }
  toggleOrgMenu(): void { this.s.orgMenu = !this.s.orgMenu; }
  toggleInfo(): void { this.s.infoOpen = !this.s.infoOpen; }

  switchOrg(orgId: string): void {
    this.s.orgMenu = false;
    if (orgId !== this.s.org) this.orgSwitchHandler?.(orgId);
  }

  send(text: string): void {
    const clean = text.trim();
    if (clean) this.sendHandler?.(clean);
  }

  openDirect(personId: string): void { this.directHandler?.(personId); }
  createGroup(personIds: string[]): void { this.groupHandler?.(personIds); }
  requestSecretary(): void { this.secretaryHandler?.(); }

  dispose(): void {
    this.sendHandler = null;
    this.orgSwitchHandler = null;
    this.directHandler = null;
    this.groupHandler = null;
    this.secretaryHandler = null;
    this.snapshot = null;
  }
}
