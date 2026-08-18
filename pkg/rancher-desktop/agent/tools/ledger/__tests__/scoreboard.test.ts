import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { countDatedLines } from '../scoreboard';

const tmpDirs: string[] = [];

function writeTempLedger(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-ledger-scoreboard-'));
  const file = path.join(dir, 'OUTCOMES.md');

  tmpDirs.push(dir);
  fs.writeFileSync(file, contents, 'utf8');

  return file;
}

describe('countDatedLines', () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts date-only and timestamped ledger outcome rows', () => {
    const file = writeTempLedger([
      '- 2026-08-13 — Legacy date-only outcome.',
      '- 2026-08-17 18:07 — Timestamped outcome.',
      '- 2026-08-17 17:2x — Approximate timestamp outcome.',
      '- 2026-08-17 heartbeat — Actor-attributed outcome.',
      '- 2026-08-17 18:07 heartbeat — Timestamp plus actor outcome.',
      '- Not a dated ledger row.',
      '  - 2026-08-17 — Nested note, not an outcome row.',
    ].join('\n'));

    const result = countDatedLines(file, 30);

    expect(result.total).toBe(5);
    expect(result.recent).toBe(5);
    expect(result.newestDate).toBe('2026-08-17');
  });
});
