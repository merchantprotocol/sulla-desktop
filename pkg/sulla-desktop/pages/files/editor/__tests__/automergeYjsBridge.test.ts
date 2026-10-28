/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as A from '@automerge/automerge';

import { AutomergeYjsBridge, type TextDoc } from '../automergeYjsBridge';

/** Stands in for the Files service live session: a plain Automerge doc with one sync state per peer. */
class Server {
  doc = A.from<TextDoc>({ text: 'First line.\nLast line.' });
  states = new Map<string, A.SyncState>();
  wire:Uint8Array[] = [];
  sync(peer:string, bridge:AutomergeYjsBridge, clientState:{ value:A.SyncState }) {
    let serverState = this.states.get(peer) ?? A.initSyncState();
    for (let round = 0; round < 20; round++) {
      const [nextClient, toServer] = A.generateSyncMessage(bridge.doc, clientState.value);
      clientState.value = nextClient;
      if (toServer) { this.wire.push(toServer); [this.doc, serverState] = A.receiveSyncMessage(this.doc, serverState, toServer) }
      const [nextServer, toClient] = A.generateSyncMessage(this.doc, serverState);
      serverState = nextServer;
      if (toClient) { this.wire.push(toClient); bridge.receive(doc => { const [next, state] = A.receiveSyncMessage(doc, clientState.value, toClient); clientState.value = state; return next }) }
      if (!toServer && !toClient) { this.states.set(peer, serverState); return }
    }
    throw new Error('Sync did not settle');
  }
}

describe('Automerge-backed Yjs editor view', () => {
  it('converges concurrent edits, undoes only local edits, and syncs nothing but Automerge', () => {
    const server = new Server();
    const human = new AutomergeYjsBridge(A.init<TextDoc>()), agent = new AutomergeYjsBridge(A.init<TextDoc>());
    const humanState = { value: A.initSyncState() }, agentState = { value: A.initSyncState() };

    server.sync('human', human, humanState);
    server.sync('agent', agent, agentState);
    expect(human.text).toBe('First line.\nLast line.');

    // Concurrent edits made through Y.Text, the way CodeMirror's binding writes them.
    human.undoManager.addTrackedOrigin('binding');
    human.ydoc.transact(() => human.ytext.insert(0, 'Human: '), 'binding');
    agent.setText('First line.\nLast line, edited by agent.');
    server.sync('human', human, humanState);
    server.sync('agent', agent, agentState);
    server.sync('human', human, humanState);

    const merged = 'Human: First line.\nLast line, edited by agent.';
    expect(server.doc.text).toBe(merged);
    expect(human.text).toBe(merged);
    expect(agent.text).toBe(merged);
    expect(human.doc.text).toBe(merged);

    // Undo reverts the human's own edit and leaves the agent's edit alone.
    human.undoManager.undo();
    server.sync('human', human, humanState);
    server.sync('agent', agent, agentState);
    expect(server.doc.text).toBe('First line.\nLast line, edited by agent.');
    expect(agent.text).toBe(server.doc.text);

    // Every message on the wire is an Automerge sync message, and the stored bytes load as plain Automerge.
    for (const message of server.wire) expect(() => A.decodeSyncMessage(message)).not.toThrow();
    expect(A.load<TextDoc>(A.save(server.doc)).text).toBe(server.doc.text);

    human.destroy(); agent.destroy();
  });
});
