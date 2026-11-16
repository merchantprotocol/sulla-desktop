// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data loss. Edits typed while the live session is offline exist only in the local CRDT.
// Closing that editor (switching tabs) must keep them in the recovery store so the next editor for
// the same file resumes the same history; a cleanly synced close must not leave stale history.
import * as A from '@automerge/automerge';
import { describe, expect, it } from 'vitest';

import { LiveDocument } from './liveDocument';
import { LiveDocumentRecoveryStore } from './LiveDocumentRecoveryStore';

import type { FilesLiveConnection, FilesLiveEvent } from '../liveTypes';
import type { FilesDataSource } from '../types';

const encode = (bytes:Uint8Array) => Buffer.from(bytes).toString('base64');
const decode = (value:string) => new Uint8Array(Buffer.from(value, 'base64'));

/** The Files service side of a live session: one Automerge peer answering sync messages. */
class FakeLivePeer {
  doc = A.from<{ text:string }>({ text: 'hello' });
  offline = false;
  private state = A.initSyncState();

  source():FilesDataSource {
    return { openLive: async(_fileId:string, _onEvent:(event:FilesLiveEvent) => void):Promise<FilesLiveConnection> => {
      this.state = A.initSyncState();
      return {
        join:  { peerId: 'peer-1', editable: true, versionId: 'v1' },
        close: async() => undefined,
        sync:  async(message:string) => {
          if (this.offline) throw new Error('offline');
          [this.doc, this.state] = A.receiveSyncMessage(this.doc, this.state, decode(message));
          const [state, reply] = A.generateSyncMessage(this.doc, this.state);

          this.state = state;
          return { message: reply ? encode(reply) : null };
        },
      };
    } } as unknown as FilesDataSource;
  }
}

const open = (peer:FakeLivePeer, store:LiveDocumentRecoveryStore, statuses:string[] = []) => new LiveDocument(peer.source(), 'file-1', () => undefined, status => statuses.push(status), () => undefined, store);

describe('LiveDocument recovery', () => {
  it('keeps offline edits for the next editor of the same file, in the injected store only', async() => {
    const peer = new FakeLivePeer();
    const store = new LiveDocumentRecoveryStore();
    const statuses:string[] = [];
    const first = open(peer, store, statuses);

    await first.start();
    expect(first.ytext.toString()).toBe('hello');
    peer.offline = true;
    first.edit('hello offline');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(statuses.at(-1)).toBe('offline');
    await first.close();

    expect(store.has('file-1')).toBe(true);
    expect(open(peer, store).ytext.toString()).toBe('hello offline');
    expect(open(peer, new LiveDocumentRecoveryStore()).ytext.toString()).toBe('');
    expect(peer.doc.text).toBe('hello');
  });

  it('drops saved history after a close that synced everything to the service', async() => {
    const peer = new FakeLivePeer();
    const store = new LiveDocumentRecoveryStore();
    const doc = open(peer, store);

    await doc.start();
    doc.edit('hello synced');
    await doc.close();

    expect(store.has('file-1')).toBe(false);
    expect(peer.doc.text).toBe('hello synced');
  });
});
