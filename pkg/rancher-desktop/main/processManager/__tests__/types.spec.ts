import { validateTarget, withCpu, type VmSnapshot } from '../types';

const boot = '12345678-1234-1234-1234-123456789abc';
const fixture = (overrides: Partial<VmSnapshot> = {}): VmSnapshot => ({
  boot,
  timestamp:       10,
  cores:           4,
  totalTicks:      4000,
  idleTicks:       2000,
  ticksPerSecond:  100,
  memoryTotal:     1000,
  memoryAvailable: 400,
  shared:          100,
  cache:           200,
  swapTotal:       0,
  swapUsed:        0,
  filesystems:     [],
  processes:       [{ pid: 20, started: '200', ticks: 100, memory: 20, name: 'test', user: 'test', uid: 501, state: 'S', parent: 1, protected: '' }],
  ...overrides,
});

test('first reading and reboot require fresh CPU sampling', () => {
  expect(withCpu(fixture()).cpu).toBeNull();
  expect(withCpu(fixture({ boot: 'another-boot', timestamp: 12 }), fixture()).processes[0].cpu).toBeNull();
});

test('CPU is normalized to total VM capacity and idle includes iowait', () => {
  const before = fixture();
  const after = fixture({ timestamp: 12, totalTicks: 4800, idleTicks: 2200, processes: [{ ...before.processes[0], ticks: 300 }] });
  const result = withCpu(after, before);

  expect(result.cpu).toBe(75);
  expect(result.processes[0].cpu).toBe(25);
});

test('reused PID does not inherit prior CPU usage', () => {
  const before = fixture();
  const after = fixture({ timestamp: 12, totalTicks: 4800, processes: [{ ...before.processes[0], started: 'new' }] });

  expect(withCpu(after, before).processes[0].cpu).toBeNull();
});

test.each([null, {}, { pid: -1 }, { pid: '20; kill -1' }, { pid: 1 }, { pid: 20, started: '200', boot, signal: 'STOP' }])('reject malformed kill request %j', input => {
  expect(() => validateTarget(input)).toThrow();
});

test('validates and strips extra kill request fields', () => {
  expect(validateTarget({ pid: 20, started: '200', boot, signal: 'KILL', command: 'ignored' })).toEqual({ pid: 20, started: '200', boot, signal: 'KILL' });
});
