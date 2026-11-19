// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { reactive } from 'vue';
import type { ConversationMessageData } from './ConversationProjection';
import { DirectoryPersonNormalizer, type NormalizedDirectoryPerson } from './DirectoryPersonNormalizer';

/** One org conversations IPC read. Each call is independent, so one failing read never blanks the others. */
export interface OrgConversationsGateway {
  directory(org: string): Promise<unknown>;
  inbox(org: string): Promise<unknown>;
  participant(org: string): Promise<unknown>;
  contactRequests(org: string): Promise<unknown>;
  memberships(org: string): Promise<unknown>;
  invitations(org: string): Promise<unknown>;
}

export interface PendingInvitation { id: string; email: string; expiresAt: string }

/**
 * The result of one load. A field is undefined when its read failed, so the caller keeps the last good value
 * for that field. `problems` lists each failed read in words the person can act on.
 */
export interface OrgConversationLoad {
  people?: NormalizedDirectoryPerson[];
  invited?: PendingInvitation[];
  messages?: ConversationMessageData[];
  requests?: ConversationMessageData[];
  userId?: string;
  problems: string[];
}

/** Reads the org conversations IPC and turns each reply into a load. It never throws: a failure becomes a problem. */
export class OrgConversationsLoader {
  constructor(
    private readonly gateway: OrgConversationsGateway,
    private readonly normalizer: DirectoryPersonNormalizer = new DirectoryPersonNormalizer(),
  ) {}

  async load(org: string): Promise<OrgConversationLoad> {
    const [directory, inbox, participant, contacts, memberships, invitations] = await Promise.all([
      settle(() => this.gateway.directory(org)),
      settle(() => this.gateway.inbox(org)),
      settle(() => this.gateway.participant(org)),
      settle(() => this.gateway.contactRequests(org)),
      // Roles and invitations are best-effort: a failed read hides the pill or section instead of showing a wrong one.
      settle(() => this.gateway.memberships(org)),
      settle(() => this.gateway.invitations(org)),
    ]);
    const problems: string[] = [];
    const load: OrgConversationLoad = { problems };

    if (directory.ok) {
      const people = listField(directory.value, ['directory', 'people']);
      if (people) load.people = this.normalizer.withRoles(people as Record<string, unknown>[], memberships.ok ? (listField(memberships.value, ['memberships']) ?? []) as { userId?: unknown; role?: unknown }[] : []);
      else problems.push('Members response was malformed.');
    } else problems.push(`Members could not be loaded (${directory.error}).`);

    if (inbox.ok) {
      const messages = listField(inbox.value, ['messages']);
      if (messages) load.messages = messages as ConversationMessageData[];
      else problems.push('Conversations response was malformed.');
    } else problems.push(`Conversations could not be loaded (${inbox.error}).`);

    if (participant.ok) {
      const userId = (participant.value as { userId?: unknown } | null)?.userId;
      if (typeof userId === 'string' && userId) load.userId = userId;
      else problems.push('Your member id could not be read.');
    } else problems.push(`Your member id could not be read (${participant.error}).`);

    if (contacts.ok) {
      const requests = listField(contacts.value, ['requests']);
      if (requests) load.requests = requests as ConversationMessageData[];
    } else problems.push(`Contact requests could not be loaded (${contacts.error}).`);

    if (invitations.ok) load.invited = (listField(invitations.value, ['invitations']) ?? []) as PendingInvitation[];
    return load;
  }
}

/** The data the Conversations screen renders for one org. */
export interface ConversationData {
  org: string;
  people: NormalizedDirectoryPerson[];
  invited: PendingInvitation[];
  messages: ConversationMessageData[];
  requests: ConversationMessageData[];
  userId: string;
  /** Messages this window sent that the inbox has not returned yet. Dropped once the inbox includes them. */
  localSent: ConversationMessageData[];
  /** Failed reads from the last load, shown as the screen's status. Empty when everything loaded. */
  problems: string[];
}

/**
 * Owns the Conversations data and its merge rules. Only the newest load may write. A failed read keeps the
 * last good value for the same org, so a Cloud or vault hiccup never blanks the list. An org switch starts empty.
 */
export class ConversationDataState {
  readonly data = reactive<ConversationData>(emptyData(''));
  private latest = 0;

  /** Starts a load for `org` and returns its token. A newer begin() makes the older load stale. */
  begin(org: string): number {
    this.latest += 1;
    if (this.data.org !== org) Object.assign(this.data, emptyData(org));
    return this.latest;
  }

  /** Applies a finished load. Returns false (and changes nothing) when a newer load has started since. */
  apply(token: number, org: string, load: OrgConversationLoad): boolean {
    if (token !== this.latest) return false;
    const base: ConversationData = this.data.org === org ? this.data : emptyData(org);
    const messages = load.messages ?? base.messages;
    const inbox = new Set(messages.map(message => message.messageId));
    Object.assign(this.data, {
      org,
      people: load.people ?? base.people,
      invited: load.invited ?? base.invited,
      messages,
      requests: load.requests ?? base.requests,
      userId: load.userId ?? base.userId,
      localSent: base.localSent.filter(sent => !inbox.has(sent.messageId)),
      problems: load.problems,
    });
    return true;
  }

  /** Keeps a message this window just sent visible until the inbox returns it. */
  addSent(message: ConversationMessageData): void {
    if (message.orgId !== this.data.org) return;
    this.data.localSent = [...this.data.localSent, message];
  }
}

function emptyData(org: string): ConversationData {
  return { org, people: [], invited: [], messages: [], requests: [], userId: '', localSent: [], problems: [] };
}

type Settled = { ok: true; value: unknown } | { ok: false; error: string };

async function settle(read: () => Promise<unknown>): Promise<Settled> {
  try { return { ok: true, value: await read() }; }
  catch (cause) { return { ok: false, error: describeFailure(cause) }; }
}

/** Reads an array at a path of an IPC reply. Returns undefined when the path does not hold an array. */
function listField(value: unknown, path: string[]): unknown[] | undefined {
  let current: unknown = value;
  for (const key of path) current = (current as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(current) ? current : undefined;
}

/** Strips the Electron IPC prefix so the status reads as the cause, not as a stack of wrappers. */
function describeFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? 'unknown error');
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'unknown error';
}
