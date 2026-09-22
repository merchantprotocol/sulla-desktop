import { jest } from '@jest/globals';

const handlers = new Map<string, (...args: any[]) => any>();
const execute = jest.fn<any>();
const confirm = jest.fn<any>();
const frame = { url: 'app://./process-manager.html' };
const webContents = { mainFrame: frame };
const window = { webContents };
let currentWindow: typeof window | null = window;
const event = { sender: webContents, senderFrame: frame };
const boot = '12345678-1234-1234-1234-123456789abc';
const target = { pid: 123, started: '456', boot, signal: 'TERM' };
const snapshot = { boot, processes: [{ pid: 123, started: '456', name: 'sleep', protected: '' }] };

jest.unstable_mockModule('node:child_process', () => ({ execFile: () => {} }));
jest.unstable_mockModule('node:util', () => ({ promisify: () => execute }));
jest.unstable_mockModule('electron', () => ({
  app:     { isPackaged: true },
  dialog:  { showMessageBox: confirm },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) },
}));
jest.unstable_mockModule('@pkg/utils/paths', () => ({ default: { limactl: '/lima/bin/limactl', lima: '/vm-home' } }));
jest.unstable_mockModule('@pkg/window', () => ({
  createWindow: () => window, getWindow: () => currentWindow, webRoot: 'app://.',
}));
const { openProcessManager } = await import('../processManager');
openProcessManager();
const terminate = (e = event, input: unknown = target) => handlers.get('vm-process-manager:terminate')!(e, input);

beforeEach(() => {
  currentWindow = window;
  frame.url = 'app://./process-manager.html';
  execute.mockReset().mockResolvedValue({ stdout: JSON.stringify(snapshot) });
  confirm.mockReset().mockResolvedValue({ response: 0 });
});

test('rejects another renderer, a subframe, and a navigated window', async() => {
  await expect(terminate({ ...event, sender: {} } as any)).rejects.toThrow('own window');
  await expect(terminate({ ...event, senderFrame: { ...frame } })).rejects.toThrow('own window');
  frame.url = 'https://example.com/process-manager.html';
  await expect(terminate()).rejects.toThrow('own window');
  expect(execute).not.toHaveBeenCalled();
});

test('rejects a closed window', async() => {
  currentWindow = null;
  await expect(terminate()).rejects.toThrow('own window');
  expect(execute).not.toHaveBeenCalled();
});

test('cancel never invokes the signal probe', async() => {
  expect(await terminate()).toEqual({ sent: false });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][1]).toMatchObject({ defaultId: 0, cancelId: 0 });
});

test('protected or stale selections never open confirmation', async() => {
  execute.mockResolvedValueOnce({ stdout: JSON.stringify({ ...snapshot, processes: [{ ...snapshot.processes[0], protected: 'Core service' }] }) });
  await expect(terminate()).rejects.toThrow('Core service');
  await expect(terminate(event, { ...target, started: '999' })).rejects.toThrow('changed');
  expect(confirm).not.toHaveBeenCalled();
});

test('confirmed force quit uses only fixed limactl arguments and validated identity', async() => {
  confirm.mockResolvedValue({ response: 1 });
  execute.mockResolvedValueOnce({ stdout: JSON.stringify(snapshot) }).mockResolvedValueOnce({ stdout: '{"sent":true}' });
  expect(await terminate(event, { ...target, signal: 'KILL' })).toEqual({ sent: true });
  const [binary, args, options] = execute.mock.calls[1] as [string, string[], { env: { LIMA_HOME: string } }];
  expect(binary).toBe('/lima/bin/limactl');
  expect(args.slice(0, 6)).toEqual(['shell', '0', '--', 'python3', '-c', expect.any(String)]);
  expect(JSON.parse(args[6])).toEqual({ ...target, signal: 'KILL', action: 'terminate' });
  expect(options.env.LIMA_HOME).toBe('/vm-home');
});

test('VM failure never falls back to a host shell', async() => {
  execute.mockRejectedValue(new Error('VM unavailable'));
  await expect(terminate()).rejects.toThrow('Could not reach the VM');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
});

test('window navigation during confirmation blocks the signal', async() => {
  confirm.mockImplementation(() => { frame.url = 'app://./index.html'; return Promise.resolve({ response: 1 }) });
  await expect(terminate()).rejects.toThrow('own window');
  expect(execute).toHaveBeenCalledTimes(1);
});
