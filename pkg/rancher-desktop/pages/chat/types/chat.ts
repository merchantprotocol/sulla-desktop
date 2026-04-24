// Branded ID types so you can't cross the streams.
//
// e.g. a function that expects a MessageId cannot be called with a ThreadId
// even though they are both strings at runtime.

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type ThreadId      = Brand<string, 'ThreadId'>;
export type MessageId     = Brand<string, 'MessageId'>;
export type ArtifactId    = Brand<string, 'ArtifactId'>;
export type AttachmentId  = Brand<string, 'AttachmentId'>;
export type QueuedId      = Brand<string, 'QueuedId'>;
export type TurnId        = Brand<string, 'TurnId'>;

export const newThreadId     = (): ThreadId     => makeId('t')  as ThreadId;
export const newMessageId    = (): MessageId    => makeId('m')  as MessageId;
export const newArtifactId   = (): ArtifactId   => makeId('af') as ArtifactId;
export const newAttachmentId = (): AttachmentId => makeId('a')  as AttachmentId;
export const newQueuedId     = (): QueuedId     => makeId('q')  as QueuedId;
export const newTurnId       = (): TurnId       => makeId('tr') as TurnId;

function makeId(prefix: string): string {
  return `${ prefix }_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 8) }`;
}

// Cast helpers for hydration from storage
export const asThreadId     = (s: string): ThreadId     => s as ThreadId;
export const asMessageId    = (s: string): MessageId    => s as MessageId;
export const asArtifactId   = (s: string): ArtifactId   => s as ArtifactId;
export const asAttachmentId = (s: string): AttachmentId => s as AttachmentId;
export const asQueuedId     = (s: string): QueuedId     => s as QueuedId;
export const asTurnId       = (s: string): TurnId       => s as TurnId;
