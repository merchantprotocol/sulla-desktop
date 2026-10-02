import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TopicLog } from '../SullaLogger';

describe('TopicLog rotation', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-topic-log-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('rotates the active log before it exceeds the size cap', () => {
    const logger = new TopicLog('frontend-graph', dir, { maxBytes: 320, backupCount: 2 });

    for (let index = 0; index < 8; index++) {
      logger.log(`message-${ index }-${ 'x'.repeat(80) }`);
    }

    const active = path.join(dir, 'frontend-graph.log');
    const backup = path.join(dir, 'frontend-graph.1.log');

    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.statSync(active).size).toBeLessThanOrEqual(320);
    expect(fs.statSync(backup).size).toBeLessThanOrEqual(320);
    expect(fs.readFileSync(active, 'utf-8')).toContain('message-7-');
  });

  test('retains only the configured number of rotated files', () => {
    const logger = new TopicLog('dispatcher', dir, { maxBytes: 220, backupCount: 2 });

    for (let index = 0; index < 20; index++) {
      logger.log(`message-${ index }-${ 'x'.repeat(100) }`);
    }

    expect(fs.existsSync(path.join(dir, 'dispatcher.1.log'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dispatcher.2.log'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dispatcher.3.log'))).toBe(false);
  });

  test('rotates an oversized pre-existing log on the next write', () => {
    const active = path.join(dir, 'websocket.log');
    fs.writeFileSync(active, 'old-data'.repeat(100));

    const logger = new TopicLog('websocket', dir, { maxBytes: 512, backupCount: 1 });
    logger.warn('new warning');

    expect(fs.readFileSync(path.join(dir, 'websocket.1.log'), 'utf-8')).toBe('old-data'.repeat(100));
    expect(fs.readFileSync(active, 'utf-8')).toContain('new warning');
    expect(fs.statSync(active).size).toBeLessThanOrEqual(512);
  });
});
