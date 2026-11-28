// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true } }));

import { E2eTraceWriter, type E2eTraceSinks } from './e2eTrace';

function sinks(): E2eTraceSinks & { listeners: Record<string, (v: unknown) => void> } {
  const listeners: Record<string, (v: unknown) => void> = {};

  return { listeners, appendFileSync: vi.fn(), writeStderr: vi.fn(), onProcess: vi.fn((event, listener) => { listeners[event] = listener }) };
}

describe('E2eTraceWriter', () => {
  it('only enables tracing for unpackaged SULLA_E2E=1 runs with a log path', () => {
    const env = { SULLA_E2E: '1', SULLA_E2E_MAIN_LOG: '/log' };

    expect(E2eTraceWriter.tracePathFor(false, env)).toBe('/log');
    expect(E2eTraceWriter.tracePathFor(true, env)).toBe('');
    expect(E2eTraceWriter.tracePathFor(undefined, env)).toBe('');
    expect(E2eTraceWriter.tracePathFor(false, { SULLA_E2E: '0', SULLA_E2E_MAIN_LOG: '/log' })).toBe('');
    expect(E2eTraceWriter.tracePathFor(false, { SULLA_E2E: '1' })).toBe('');
  });

  it('is a no-op without a trace path', () => {
    const s = sinks();
    const writer = new E2eTraceWriter('', s);

    writer.write('hello');
    writer.installCrashTrace();
    expect(s.writeStderr).not.toHaveBeenCalled();
    expect(s.appendFileSync).not.toHaveBeenCalled();
    expect(s.onProcess).not.toHaveBeenCalled();
  });

  it('writes the line to stderr and the trace file, swallowing file errors', () => {
    const s = sinks();

    vi.mocked(s.appendFileSync).mockImplementation(() => { throw new Error('disk') });
    new E2eTraceWriter('/log', s).write('hello');
    expect(s.writeStderr).toHaveBeenCalledWith(expect.stringMatching(/^\[sulla-e2e\] .* pid=\d+ hello\n$/));
    expect(s.appendFileSync).toHaveBeenCalledWith('/log', expect.stringContaining('hello'));
  });

  it('installs crash listeners that trace uncaught errors', () => {
    const s = sinks();

    new E2eTraceWriter('/log', s).installCrashTrace();
    s.listeners.uncaughtException(new Error('boom'));
    s.listeners.unhandledRejection('why');
    expect(s.appendFileSync).toHaveBeenCalledWith('/log', expect.stringContaining('uncaughtException: Error: boom'));
    expect(s.appendFileSync).toHaveBeenCalledWith('/log', expect.stringContaining('unhandledRejection: why'));
  });
});
