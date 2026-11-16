// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { IpcMainInvokeEvent } from 'electron';
import type { SullaFilesIpcApi, SullaFilesIpcRegistrar } from './SullaFilesIpcSupport';

interface LivePeer { fileId:string; owner:number; abort:AbortController }

/**
 * Live co-editing sessions. A renderer owns its peer; guessing another
 * renderer's id cannot proxy its session. Errors are returned as data.
 */
export class SullaFilesIpcLiveHandlers {
  private readonly livePeers = new Map<string, LivePeer>();

  constructor(private readonly api:SullaFilesIpcApi) {}

  private liveError(error:unknown):{ error:string } { return { error: error instanceof Error ? error.message : String(error) } }

  private ownedLive(event:IpcMainInvokeEvent, peerId:string):LivePeer {
    const peer = this.livePeers.get(peerId);
    if (!peer || peer.owner !== event.sender.id) throw new Error('Live peer not found');
    return peer;
  }

  private livePath(fileId:string, peerId:string):string { return `/v1/files/${ encodeURIComponent(fileId) }/live/${ encodeURIComponent(peerId) }` }

  private async leaveLive(peerId:string):Promise<void> {
    const peer = this.livePeers.get(peerId);
    if (!peer) return;
    this.livePeers.delete(peerId);
    peer.abort.abort();
    await this.api.json(this.livePath(peer.fileId, peerId), { method: 'DELETE' }).catch(() => undefined);
  }

  private async pump(event:IpcMainInvokeEvent, peerId:string, peer:LivePeer, reader:ReadableStreamDefaultReader<Uint8Array>):Promise<void> {
    let pending = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Live stream disconnected');
        pending += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data && !event.sender.isDestroyed()) event.sender.send(`sulla-files:live:${ peerId }`, JSON.parse(data));
        }
      }
    } catch (error) {
      if (!peer.abort.signal.aborted && !event.sender.isDestroyed()) event.sender.send(`sulla-files:live:${ peerId }`, { type: 'error', ...this.liveError(error) });
    } finally {
      reader.releaseLock();
    }
  }

  register(ipc:SullaFilesIpcRegistrar):void {
    ipc.handle('sulla-files:live-join', async(event, input:{ fileId:string }) => {
      try {
        const joined = await this.api.json(`/v1/files/${ encodeURIComponent(input.fileId) }/live`, { method: 'POST', body: '{}' });
        this.livePeers.set(joined.peerId, { fileId: input.fileId, owner: event.sender.id, abort: new AbortController() });
        event.sender.once('destroyed', () => void this.leaveLive(joined.peerId));
        return joined;
      } catch (error) { return this.liveError(error) }
    });
    ipc.handle('sulla-files:live-start', async(event, input:{ peerId:string }) => {
      try {
        const peer = this.ownedLive(event, input.peerId);
        const response = await this.api.client.stream(`${ this.livePath(peer.fileId, input.peerId) }/events`, {}, peer.abort.signal);
        if (!response.ok || !response.body) throw new Error(`Live stream failed (${ response.status })`);
        const reader = response.body.getReader();
        void this.pump(event, input.peerId, peer, reader);
        return {};
      } catch (error) { return this.liveError(error) }
    });
    ipc.handle('sulla-files:live-sync', async(event, input:{ peerId:string; message:string }) => {
      try {
        const peer = this.ownedLive(event, input.peerId);
        return await this.api.json(`${ this.livePath(peer.fileId, input.peerId) }/sync`, { method: 'POST', body: JSON.stringify({ message: input.message }) });
      } catch (error) { return this.liveError(error) }
    });
    ipc.handle('sulla-files:live-leave', async(event, input:{ peerId:string }) => {
      try {
        this.ownedLive(event, input.peerId);
        await this.leaveLive(input.peerId);
        return {};
      } catch (error) { return this.liveError(error) }
    });
  }
}
