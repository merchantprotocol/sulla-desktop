export interface VmProcess {
  pid:       number;
  name:      string;
  user:      string;
  uid:       number;
  state:     string;
  parent:    number;
  started:   string;
  ticks:     number;
  memory:    number;
  protected: string;
  cpu?:      number | null;
}
export interface VmSnapshot {
  boot:            string;
  timestamp:       number;
  cores:           number;
  totalTicks:      number;
  idleTicks:       number;
  ticksPerSecond:  number;
  memoryTotal:     number;
  memoryAvailable: number;
  shared:          number;
  cache:           number;
  swapTotal:       number;
  swapUsed:        number;
  processes:       VmProcess[];
  filesystems:     { path: string; total: number; used: number }[];
  cpu?:            number | null;
}
export interface TerminateRequest {
  pid:     number;
  started: string;
  boot:    string;
  signal:  'TERM' | 'KILL';
}

/** CPU percentages use total VM capacity, so 100% means all virtual cores. */
export function withCpu(current: VmSnapshot, previous?: VmSnapshot): VmSnapshot {
  const elapsed = previous?.boot === current.boot ? current.timestamp - previous.timestamp : 0;
  const totalDelta = previous ? current.totalTicks - previous.totalTicks : 0;
  const prior = new Map(previous?.processes.map(p => [`${ p.pid }:${ p.started }`, p]) ?? []);
  const valid = elapsed > 0 && totalDelta > 0;
  const clamp = (n: number) => Math.max(0, Math.min(100, n));

  return {
    ...current,
    cpu:       valid ? clamp(100 * (1 - (current.idleTicks - previous!.idleTicks) / totalDelta)) : null,
    processes: current.processes.map(p => {
      const before = prior.get(`${ p.pid }:${ p.started }`);

      return { ...p, cpu: valid && before ? clamp(100 * (p.ticks - before.ticks) / (elapsed * current.ticksPerSecond * current.cores)) : null };
    }),
  };
}

export function validateTarget(value: unknown): TerminateRequest {
  const v = value as Partial<TerminateRequest> | null;

  if (!v || !Number.isSafeInteger(v.pid) || v.pid! <= 1 ||
      typeof v.started !== 'string' || !/^\d+$/.test(v.started) ||
      typeof v.boot !== 'string' || !/^[a-f0-9-]{36}$/.test(v.boot) ||
      !['TERM', 'KILL'].includes(v.signal ?? '')) {
    throw new Error('Invalid process selection. Refresh and try again.');
  }

  return { pid: v.pid!, started: v.started, boot: v.boot, signal: v.signal! };
}
