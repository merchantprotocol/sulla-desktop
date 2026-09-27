/** @jest-environment node */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  describeTurnForAgent,
  normalizeMobileContent,
  persistMobileAttachments,
  safeFileName,
  transcriptText,
} from '@pkg/main/mobileRelayContent';

const png = Buffer.from('fake-png').toString('base64');
const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');

describe('normalizeMobileContent', () => {
  it('passes plain strings through trimmed', () => {
    expect(normalizeMobileContent('  hello  ')).toEqual({ text: 'hello', images: [], files: [] });
  });

  it('splits text, image and document parts instead of throwing on arrays', () => {
    const turn = normalizeMobileContent([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf }, title: 'quote.pdf' },
    ]);

    expect(turn.text).toBe('What is this?');
    expect(turn.images).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }]);
    expect(turn.files.map(f => [f.kind, f.name, f.mediaType])).toEqual([
      ['image', 'photo-1.png', 'image/png'],
      ['document', 'quote.pdf', 'application/pdf'],
    ]);
  });

  it('ignores malformed parts and non-content values', () => {
    expect(normalizeMobileContent([{ type: 'image', source: { type: 'url', url: 'x' } }, null, 3])).toEqual({ text: '', images: [], files: [] });
    expect(normalizeMobileContent(undefined)).toEqual({ text: '', images: [], files: [] });
  });
});

describe('agent and transcript text', () => {
  const turn = normalizeMobileContent([
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf }, title: 'quote.pdf' },
  ]);

  it('gives attachment-only turns a non-empty transcript so retries dedupe', () => {
    expect(transcriptText(turn)).toBe('📎 quote.pdf');
    expect(transcriptText(normalizeMobileContent('hi'))).toBe('hi');
  });

  it('tells the agent where each file was saved', () => {
    const text = describeTurnForAgent(turn, ['/tmp/x/quote.pdf']);
    expect(text).toContain('[Attached from Sulla Mobile]');
    expect(text).toContain('Document "quote.pdf" (application/pdf) — saved at /tmp/x/quote.pdf');
    expect(describeTurnForAgent(normalizeMobileContent('plain'), [])).toBe('plain');
  });
});

describe('persistMobileAttachments', () => {
  it('writes decoded files inside the conversation folder with safe names', async() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-attach-'));
    const turn = normalizeMobileContent([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf }, title: '../../etc/passwd' },
    ]);
    const [saved] = await persistMobileAttachments(dir, 'conv/../1', 'msg-1', turn.files);

    expect(path.dirname(saved).startsWith(dir)).toBe(true);
    expect(path.basename(saved)).toBe('msg-1-passwd');
    expect(fs.readFileSync(saved, 'utf8')).toBe('%PDF-1.4 fake');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never produces dotfiles or empty names', () => {
    expect(safeFileName('..')).toBe('attachment');
    expect(safeFileName('.env')).toBe('env');
  });
});
