// SPDX-License-Identifier: GPL-2.0-or-later
import { HookRegistry } from '../HookRegistry';
const granted = () => true;
describe('HookRegistry', () => {
  test('returns the original value by identity when no hooks exist', async() => {
    const registry = new HookRegistry(); const input = { password:'real', nested:{ token:'secret' } };
    expect((await registry.runFilter('before_tool_call', input)).value).toBe(input);
  });
  test('restores redacted fields and prevents handlers from injecting them', async() => {
    const registry = new HookRegistry({ granted });
    registry.register({ extensionId:'x', hook:'before_tool_call', handler:(v:any) => ({ value:{ ...v, args:{ ...v.args, password:'injected', token:'[REDACTED]', safe:'changed' } } }) });
    const input = { args:{ password:'real-password', token:'real-token', safe:'before' } };
    expect((await registry.runFilter('before_tool_call', input)).value).toEqual({ args:{ password:'real-password', token:'real-token', safe:'changed' } });
  });
  test('orders filters by priority and transforms values', async() => {
    const registry = new HookRegistry({ granted });
    registry.register({ extensionId:'late', hook:'before_tool_call', priority:20, handler:(v:any)=>({ value:{ ...v, order:`${ v.order }b` } }) });
    registry.register({ extensionId:'early', hook:'before_tool_call', priority:5, handler:(v:any)=>({ value:{ ...v, order:`${ v.order }a` } }) });
    expect((await registry.runFilter('before_tool_call', { order:'' })).value).toEqual({ order:'ab' });
  });
  test('isolates throws and timeouts', async() => {
    const audit:any[]=[]; const registry = new HookRegistry({ granted, audit:e=>audit.push(e), defaultTimeoutMs:5 });
    registry.register({ extensionId:'throw', hook:'after_tool_call', handler:()=>{ throw new Error('boom') } });
    registry.register({ extensionId:'slow', hook:'after_tool_call', handler:()=>new Promise(resolve=>setTimeout(resolve, 30)) });
    await expect(registry.runAction('after_tool_call', {})).resolves.toBeUndefined();
    expect(audit.map(e=>e.outcome)).toEqual(['error','timeout']);
  });
  test('does not run or transform through ungranted hooks', async() => {
    const handler=jest.fn(()=>({ value:{ changed:true } })); const registry = new HookRegistry({ granted:()=>false });
    registry.register({ extensionId:'x', hook:'before_tool_call', handler }); const input={ value:1 };
    expect((await registry.runFilter('before_tool_call', input)).value).toBe(input);
    expect(handler).not.toHaveBeenCalled();
  });
  test('filter can deny a tool call', async() => {
    const registry = new HookRegistry({ granted }); registry.register({ extensionId:'guard', hook:'before_tool_call', handler:()=>({ denied:true, reason:'blocked' }) });
    expect(await registry.runFilter('before_tool_call', { toolName:'exec', args:{} })).toMatchObject({ denied:true, reason:'blocked' });
  });
});
