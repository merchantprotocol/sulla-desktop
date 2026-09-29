import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it, jest } from '@jest/globals';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));

jest.mock('@pkg/utils/paths', () => ({ __esModule: true, default: { sullaConfig: tmp } }));
jest.mock('@pkg/utils/logging', () => ({ __esModule: true, default: { background: { log: () => {} } } }));

// eslint-disable-next-line import/first
import { systemPromptFromMessages, writeSystemPromptFile } from '../cliSystemPromptFile';

describe('cliSystemPromptFile', () => {
  it('joins only system-role text, in order', () => {
    const text = systemPromptFromMessages([
      { role: 'system', content: 'You are the Reflex Trainer.' },
      { role: 'user', content: 'hello' },
      { role: 'system', content: [{ type: 'text', text: 'End with a wrapper.' }] },
    ] as any);
    expect(text).toBe('You are the Reflex Trainer.\n\nEnd with a wrapper.');
  });

  it('writes a private file under sullaConfig/system-prompts, or nothing for an empty prompt', () => {
    const file = writeSystemPromptFile('prompt body');
    expect(file && path.dirname(file)).toBe(path.join(tmp, 'system-prompts'));
    expect(fs.readFileSync(file!, 'utf-8')).toBe('prompt body');
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    expect(writeSystemPromptFile('   ')).toBeNull();
  });
});
