// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Startup trace for the first-run Electron E2E harness. It imports nothing but
// fs and electron so it can run before the main bundle loads. Only an
// unpackaged app with SULLA_E2E=1 and SULLA_E2E_MAIN_LOG writes anything.

import fs from 'fs';

import { app } from 'electron';

export interface E2eTraceSinks {
  appendFileSync(file: string, line: string): void;
  writeStderr(line: string): void;
  onProcess(event: 'uncaughtException' | 'unhandledRejection', listener: (value: unknown) => void): void;
}

const processSinks: E2eTraceSinks = {
  appendFileSync: (file, line) => fs.appendFileSync(file, line),
  writeStderr:    line => { process.stderr.write(line) },
  onProcess:      (event, listener) => { process.on(event as 'uncaughtException', listener) },
};

/** Synchronous E2E harness trace writer. An empty trace path turns every method into a no-op. */
export class E2eTraceWriter {
  /** The trace path the current process should use: set only for unpackaged E2E runs. */
  static tracePathFor(isPackaged: boolean | undefined, env: NodeJS.ProcessEnv): string {
    return !(isPackaged ?? true) && env.SULLA_E2E === '1' ? env.SULLA_E2E_MAIN_LOG || '' : '';
  }

  constructor(
    private readonly tracePath: string = E2eTraceWriter.tracePathFor(app?.isPackaged, process.env),
    private readonly sinks: E2eTraceSinks = processSinks,
  ) {}

  /** Append one line to stderr and the harness trace file, synchronously. */
  write(message: string): void {
    if (!this.tracePath) return;
    const line = `[sulla-e2e] ${ new Date().toISOString() } pid=${ process.pid } ${ message }\n`;

    this.sinks.writeStderr(line);
    try {
      this.sinks.appendFileSync(this.tracePath, line);
    } catch {}
  }

  /**
   * Report main-process crashes instead of letting Electron's default handler
   * open a native error box. That box blocks the main thread under xvfb, so the
   * process stays alive with no window and prints nothing.
   */
  installCrashTrace(): void {
    if (!this.tracePath) return;
    const describe = (error: unknown) => error instanceof Error ? error.stack || `${ error.name }: ${ error.message }` : String(error);

    this.sinks.onProcess('uncaughtException', error => this.write(`uncaughtException: ${ describe(error) }`));
    this.sinks.onProcess('unhandledRejection', reason => this.write(`unhandledRejection: ${ describe(reason) }`));
  }
}

/** Shared main-process trace writer; the trace path is read once, as before. */
export const e2eTrace = new E2eTraceWriter();
