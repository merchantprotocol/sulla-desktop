import { HookRegistry } from '../HookRegistry';
describe('HookRegistry', () => {
  test('orders filters by priority and transforms values', async() => {
    const registry = new HookRegistry();
    registry.register({ extensionId:'late', hook:'before_tool_call', priority:20, handler:(v:any)=>({ value:{ ...v, order:`${ v.order }b` } }) });
    registry.register({ extensionId:'early', hook:'before_tool_call', priority:5, handler:(v:any)=>({ value:{ ...v, order:`${ v.order }a` } }) });
    expect((await registry.runFilter('before_tool_call', { order:'' })).value).toEqual({ order:'ab' });
  });
  test('isolates throws and timeouts', async() => {
    const audit:any[]=[]; const registry = new HookRegistry({ audit:e=>audit.push(e), defaultTimeoutMs:5 });
    registry.register({ extensionId:'throw', hook:'after_tool_call', handler:()=>{ throw new Error('boom') } });
    registry.register({ extensionId:'slow', hook:'after_tool_call', handler:()=>new Promise(resolve=>setTimeout(resolve, 30)) });
    await expect(registry.runAction('after_tool_call', {})).resolves.toBeUndefined();
    expect(audit.map(e=>e.outcome)).toEqual(['error','timeout']);
  });
  test('does not run ungranted hooks', async() => {
    const handler=jest.fn(); const registry = new HookRegistry({ granted:()=>false });
    registry.register({ extensionId:'x', hook:'on_memory_write', handler }); await registry.runAction('on_memory_write', { value:1 });
    expect(handler).not.toHaveBeenCalled();
  });
  test('filter can deny a tool call', async() => {
    const registry = new HookRegistry(); registry.register({ extensionId:'guard', hook:'before_tool_call', handler:()=>({ denied:true, reason:'blocked' }) });
    expect(await registry.runFilter('before_tool_call', { toolName:'exec', args:{} })).toMatchObject({ denied:true, reason:'blocked' });
  });
});
