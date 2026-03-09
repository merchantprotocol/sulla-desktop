import fs from 'fs';
import os from 'os';
import path from 'path';

const SULLA_LOG_DIR = path.join(os.homedir(), 'sulla', 'logs');

export interface SullaLogEvent {
  topic:      string;
  level:      'info' | 'error' | 'debug' | 'warn';
  message:    string;
  data?:      unknown;
  error?:     unknown;
}

function ensureLogDir(): void {
  fs.mkdirSync(SULLA_LOG_DIR, { recursive: true });
}

function getLogFile(topic: string): string {
  return path.join(SULLA_LOG_DIR, `${ topic }.log`);
}

function formatError(err: unknown): string {
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

export function sullaLog(event: SullaLogEvent): void {
  try {
    ensureLogDir();
    const timestamp = new Date().toISOString();
    const errorBlock = event.error ? `\nerror:\n${ formatError(event.error) }` : '';
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

    fs.appendFileSync(getLogFile(event.topic), entry, { encoding: 'utf-8' });

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
