/**
 * @jest-environment node
 */
/* eslint-disable @typescript-eslint/require-await -- async mocks stand in for Postgres/fetch */
import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('electron', () => ({
  default:       { ipcMain: { handle: jest.fn(), on: jest.fn() } },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  ipcMain:       { handle: jest.fn(), on: jest.fn() },
  session:       { fromPartition: () => ({}) },
}));

const load = async() => (await import('../bookmarksIpc')).fetchFaviconDataUrl;

function response(body: Buffer, type: string, init: { status?: number; length?: number } = {}) {
  return new Response(new Uint8Array(body), {
    status:  init.status ?? 200,
    headers: { 'content-type': type, ...(init.length ? { 'content-length': String(init.length) } : {}) },
  });
}

describe('fetchFaviconDataUrl', () => {
  it('returns a data URL for a small image', async() => {
    const fetchFaviconDataUrl = await load();
    const fetcher = jest.fn(async() => response(Buffer.from([1, 2, 3]), 'image/png'));

    await expect(fetchFaviconDataUrl('https://a.test/icon.png', fetcher as any)).resolves.toBe('data:image/png;base64,AQID');
  });

  it('normalises the microsoft icon MIME type', async() => {
    const fetchFaviconDataUrl = await load();
    const fetcher = jest.fn(async() => response(Buffer.from([0]), 'image/vnd.microsoft.icon'));

    await expect(fetchFaviconDataUrl('https://a.test/favicon.ico', fetcher as any)).resolves.toBe('data:image/x-icon;base64,AA==');
  });

  it('rejects non-images, errors, oversize bodies and non-http URLs', async() => {
    const fetchFaviconDataUrl = await load();
    const html = jest.fn(async() => response(Buffer.from('<html>'), 'text/html'));
    const missing = jest.fn(async() => response(Buffer.from(''), 'image/png', { status: 404 }));
    const huge = jest.fn(async() => response(Buffer.alloc(70 * 1024), 'image/png'));
    const thrown = jest.fn(async() => { throw new Error('offline') });

    await expect(fetchFaviconDataUrl('https://a.test/', html as any)).resolves.toBeNull();
    await expect(fetchFaviconDataUrl('https://a.test/', missing as any)).resolves.toBeNull();
    await expect(fetchFaviconDataUrl('https://a.test/', huge as any)).resolves.toBeNull();
    await expect(fetchFaviconDataUrl('https://a.test/', thrown as any)).resolves.toBeNull();
    await expect(fetchFaviconDataUrl('file:///etc/passwd', html as any)).resolves.toBeNull();
  });
});
