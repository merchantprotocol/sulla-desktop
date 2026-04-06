/**
 * Model — structured logger with file rotation.
 *
 * Writes to ~/Library/Logs/audio-driver/ on macOS,
 * %APPDATA%/audio-driver/logs/ on Windows.
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_BACKUPS = 3;

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const isDev = !app.isPackaged;
let currentLevel = LEVELS[process.env.AUDIO_DRIVER_LOG_LEVEL ?? ''] ?? (isDev ? LEVELS.debug : LEVELS.info);
let consoleEnabled = isDev || process.env.AUDIO_DRIVER_LOG_CONSOLE === '1';
let logDir: string | null = null;

function getLogDir(): string {
  if (logDir) return logDir;
  if (process.platform === 'darwin') {
    logDir = path.join(app.getPath('home'), 'Library', 'Logs', 'audio-driver');
  } else {
    logDir = path.join(app.getPath('userData'), 'logs');
  }
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function getLogPath(name: string): string {
  return path.join(getLogDir(), `${ name }.log`);
}

function rotate(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_SIZE) return;
  } catch {
    return;
  }
  for (let i = MAX_BACKUPS; i >= 1; i--) {
    const older = `${ filePath }.${ i }`;
    const newer = i === 1 ? filePath : `${ filePath }.${ i - 1 }`;
    try { if (i === MAX_BACKUPS) fs.unlinkSync(older); } catch { /* */ }
    try { fs.renameSync(newer, older); } catch { /* */ }
  }
}

function formatLine(level: string, tag: string, message: string, data?: unknown): string {
  const ts = new Date().toISOString();
  let line = `${ ts } [${ level.toUpperCase() }] [${ tag }] ${ message }`;
  if (data !== undefined) {
    try { line += ` ${ JSON.stringify(data) }`; } catch { /* */ }
  }
  return `${ line }\n`;
}

function writeLog(fileName: string, level: string, tag: string, message: string, data?: unknown): void {
  if ((LEVELS[level] ?? 0) > currentLevel) return;
  const filePath = getLogPath(fileName);
  const line = formatLine(level, tag, message, data);
  if (consoleEnabled) {
    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }
  try {
    rotate(filePath);
    fs.appendFileSync(filePath, line);
  } catch (e: any) {
    process.stderr.write(`[logger] Failed to write to ${ filePath }: ${ e.message }\n`);
  }
}

export interface Logger {
  error: (tag: string, msg: string, data?: unknown) => void;
  warn: (tag: string, msg: string, data?: unknown) => void;
  info: (tag: string, msg: string, data?: unknown) => void;
  debug: (tag: string, msg: string, data?: unknown) => void;
  getLogDir: () => string;
  getLogPath: () => string;
}

export function createLogger(fileName: string): Logger {
  return {
    error: (tag, msg, data) => writeLog(fileName, 'error', tag, msg, data),
    warn:  (tag, msg, data) => writeLog(fileName, 'warn', tag, msg, data),
    info:  (tag, msg, data) => writeLog(fileName, 'info', tag, msg, data),
    debug: (tag, msg, data) => writeLog(fileName, 'debug', tag, msg, data),
    getLogDir,
    getLogPath: () => getLogPath(fileName),
  };
}

export const log = createLogger('main');

export function setLevel(level: string): void {
  if (LEVELS[level] !== undefined) {
    currentLevel = LEVELS[level];
    log.info('Logger', 'Log level set', { level });
  }
}

export function setConsole(enabled: boolean): void {
  consoleEnabled = enabled;
}
