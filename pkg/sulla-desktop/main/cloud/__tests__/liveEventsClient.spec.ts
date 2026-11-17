import { describe, expect, it, vi } from 'vitest';
import { CloudLiveEventsClient } from '../liveEventsClient';

class SocketFake {
  listeners=new Map<string,(event:any)=>void>(); closed=0; sent:string[]=[];
  addEventListener(type:string,listener:(event:any)=>void){this.listeners.set(type,listener)}
  send(value:string){this.sent.push(value)} close(){this.closed++}
  emit(type:string,event:any={}){this.listeners.get(type)?.(event)}
}

describe('CloudLiveEventsClient',()=>{
  it('dispatches Cloud topic events, ignores handshake frames, and reconnects with backoff',async()=>{
    const sockets:SocketFake[]=[];const dispatch=vi.fn();const timers:Array<()=>void>=[];
    const client=new CloudLiveEventsClient({token:async()=> 'access',userId:async()=> 'u1',signedIn:async()=>true,socket:()=>{const s=new SocketFake();sockets.push(s);return s},dispatch,random:()=>0,setTimeout:(fn)=>{timers.push(fn);return 1 as any},clearTimeout:vi.fn(),setInterval:()=>2 as any,clearInterval:vi.fn()});
    client.start();await Promise.resolve();await Promise.resolve();
    expect(sockets[0]).toBeDefined();
    sockets[0].emit('message',{data:JSON.stringify({type:'connected'})});
    sockets[0].emit('message',{data:JSON.stringify({type:'event',topic:'files',id:'collection'})});
    expect(dispatch).toHaveBeenCalledWith({type:'event',topic:'files',id:'collection'});
    sockets[0].emit('close');expect(timers).toHaveLength(1);timers[0]();await Promise.resolve();await Promise.resolve();expect(sockets).toHaveLength(2);
    client.stop();expect(sockets[1].closed).toBe(1);
  });
  it('stops the socket when sign-out ends the lifecycle',async()=>{
    const socket=new SocketFake();const client=new CloudLiveEventsClient({token:async()=> 'access',userId:async()=> 'u1',signedIn:async()=>true,socket:()=>socket,dispatch:vi.fn(),setInterval:()=>1 as any,clearInterval:vi.fn(),clearTimeout:vi.fn()});
    client.start();await Promise.resolve();await Promise.resolve();client.stop();expect(socket.closed).toBe(1);
  });
});
