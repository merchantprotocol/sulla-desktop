// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import path from 'path';

import paths from '@pkg/utils/paths';

export interface SullaLogEvent {
  topic:   string;
  level:   'info' | 'error' | 'debug' | 'warn';
  message: string;
  data?:   unknown;
  error?:  unknown;
}

/** Appends structured per-topic entries to ~/sulla/logs/<topic>.log and echoes them to the console. */
export class SullaTopicLogger {
  private static sharedInstance: SullaTopicLogger | undefined;

  static get shared(): SullaTopicLogger {
    SullaTopicLogger.sharedInstance ??= new SullaTopicLogger();

    return SullaTopicLogger.sharedInstance;
  }

  constructor(private readonly logDir: string = path.join(paths.sullaHome, 'logs')) {}

  log(event: SullaLogEvent): void {
    try {
      this.ensureLogDir();
      const timestamp = new Date().toISOString();
      const errorBlock = event.error ? `\nerror:\n${ SullaTopicLogger.formatError(event.error) }` : '';
      let dataBlock = '';

      if (event.data !== undefined) {
        try {
          dataBlock = `\ndata:\n${ JSON.stringify(event.data, null, 2) }`;
        } catch {
          dataBlock = `\ndata:\n${ String(event.data) }`;
        }
      }

      const entry = [
        '---',
        `timestamp: ${ timestamp }`,
        `level: ${ event.level }`,
        `topic: ${ event.topic }`,
        `message: ${ event.message }`,
        dataBlock,
        errorBlock,
        '',
      ].join('\n') + '\n';

      fs.appendFileSync(this.getLogFile(event.topic), entry, { encoding: 'utf-8' });

      const prefix = `[${ event.topic }]`;

      if (event.error) {
        console.error(prefix, event.message, event.error);
      } else {
        console.log(prefix, event.message, event.data ?? '');
      }
    } catch (writeError) {
      console.error('[sullaLog] Failed to write log:', writeError);
    }
  }

  private ensureLogDir(): void {
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  private getLogFile(topic: string): string {
    return path.join(this.logDir, `${ topic }.log`);
  }

  static formatError(err: unknown): string {
    if (err instanceof Error) {
      const extra: Record<string, unknown> = {};

      for (const key of Object.keys(err)) {
        if (key !== 'message' && key !== 'stack') {
          extra[key] = (err as any)[key];
        }
      }
      const parts = [err.stack || err.message];

      if (Object.keys(extra).length > 0) {
        parts.push(JSON.stringify(extra, null, 2));
      }

      return parts.join('\n');
    }

    try {
      return JSON.stringify(err, null, 2);
    } catch {
      return String(err);
    }
  }
}

/** @deprecated use SullaTopicLogger.shared.log */
export function sullaLog(event: SullaLogEvent): void {
  SullaTopicLogger.shared.log(event);
}
