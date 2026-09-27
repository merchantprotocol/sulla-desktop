/**
 * @jest-environment node
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';

let token = '';
jest.unstable_mockModule('@pkg/main/sullaCloudAuth', () => ({ getCurrentAccessToken: () => Promise.resolve(token) }));
jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: { background: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } },
}));

const { MarketplaceSearchWorker } = await import('../search');
const { MarketplaceInfoWorker } = await import('../info');
const { MarketplaceDownloadWorker } = await import('../download');
const { MarketplaceUpdateWorker } = await import('../update');
const { MarketplaceDiffWorker } = await import('../diff');
const { MarketplacePublishWorker } = await import('../publish');
const { MarketplaceUnpublishWorker } = await import('../unpublish');
const { MarketplaceListPublishedWorker } = await import('../list_published');

const call = (Worker: any, input: any) => new Worker()['_validatedCall'](input) as Promise<{ successBoolean: boolean; responseString: string }>;

function zipOf(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const [n, b] of Object.entries(files)) z.addBuffer(Buffer.from(b), n);
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });
}

function zipNames(buf: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const names: string[] = [];
      zip.on('entry', (e: yauzl.Entry) => { names.push(e.fileName); zip.readEntry() });
      zip.on('end', () => resolve(names));
      zip.readEntry();
    });
  });
}

interface Row { id: string; kind: string; slug: string; name: string; version: string; description?: string; download_count: number; author_display?: string; updated_at: string; zip: Buffer }
let rows: Row[];
let mine: any[];
let uploaded: Buffer | null;
let deleted: string[];
let home: string;
const realFetch = global.fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const pub = ({ zip: _z, ...r }: Row) => ({ ...r, tags: [], status: 'approved', bundle_status: 'uploaded' });

beforeEach(async() => {
  token = '';
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-mkt-tools-'));
  process.env.SULLA_HOME_DIR = home;
  uploaded = null;
  deleted = [];
  mine = [];
  rows = [
    { id: 'tpl_pdf', kind: 'function', slug: 'pdf-merge', name: 'PDF Merge', version: '1.0.0', description: 'Merge PDFs', download_count: 7, author_display: 'Sulla Labs', updated_at: '2026-01-01', zip: await zipOf({ 'pdf-merge/function.yaml': 'name: pdf-merge', 'pdf-merge/main.py': 'v1' }) },
    { id: 'tpl_seo', kind: 'routine', slug: 'seo-blog', name: 'SEO Blog', version: '2', download_count: 1, updated_at: '2026-01-02', zip: await zipOf({ 'seo-blog/routine.yaml': 'id: seo' }) },
  ];
  global.fetch = (async(input: any, init?: any) => {
    const u = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = init?.headers?.Authorization;
    if (u.pathname === '/marketplace/browse') {
      const kind = u.searchParams.get('kind');
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const hits = rows.filter(r => (!kind || r.kind === kind) && (!q || `${ r.name } ${ r.slug } ${ r.description ?? '' }`.toLowerCase().includes(q)));

      return json({ templates: hits.map(pub), total: hits.length, page: 1, limit: 25 });
    }
    let m = /^\/marketplace\/templates\/([^/]+)\/download$/.exec(u.pathname);
    if (m) {
      const r = rows.find(x => x.id === m![1]);

      return r ? new Response(new Uint8Array(r.zip), { headers: { 'Content-Type': 'application/zip' } }) : json({ error: 'Not found' }, 404);
    }
    m = /^\/marketplace\/templates\/([^/]+)$/.exec(u.pathname);
    if (m && method === 'GET') {
      const r = rows.find(x => x.id === m![1]);

      return r ? json({ template: { ...pub(r), manifest: { metadata: { category: 'Docs' }, functionSummary: { runtime: 'python' } } } }) : json({ error: 'Not found' }, 404);
    }
    if (!auth) return json({ error: 'Missing or invalid Authorization header' }, 401);
    if (u.pathname === '/marketplace/submit-manifest') return json({ template: { id: 'tpl_newsub', slug: 'my-fn', bundle_status: 'pending' } }, 201);
    if (u.pathname === '/marketplace/templates/tpl_newsub/bundle') {
      const chunks: Buffer[] = [];
      for await (const c of init.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
      uploaded = Buffer.concat(chunks);

      return json({ template: { id: 'tpl_newsub', bundle_status: 'uploaded', bundle_size: uploaded.length, status: 'pending' } });
    }
    if (u.pathname === '/marketplace/mine') return json({ templates: mine, total: mine.length, page: 1, limit: 100 });
    m = /^\/marketplace\/templates\/([^/]+)$/.exec(u.pathname);
    if (m && method === 'DELETE') { deleted.push(m[1]); return json({ success: true, action: 'withdrawn' }) }

    return json({ error: `unexpected ${ method } ${ u.pathname }` }, 500);
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.SULLA_HOME_DIR;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agent marketplace tools against the real API contract', () => {
  it('search lists live listings with author and downloads, signed out', async() => {
    const r = await call(MarketplaceSearchWorker, { query: 'pdf' });

    expect(r.successBoolean).toBe(true);
    expect(r.responseString).toContain('function/pdf-merge v1.0.0 — PDF Merge by Sulla Labs · 7 downloads');
  });

  it('accepts "routine" and "workflow" as the same kind', async() => {
    for (const kind of ['routine', 'workflow']) {
      const r = await call(MarketplaceSearchWorker, { kind });
      expect(r.responseString).toContain('routine/seo-blog');
      expect(r.responseString).not.toContain('pdf-merge');
    }
  });

  it('refuses agent kind for marketplace calls with a clear message', async() => {
    const r = await call(MarketplaceSearchWorker, { kind: 'agent' });

    expect(r.successBoolean).toBe(false);
    expect(r.responseString).toMatch(/Agents aren't distributed/);
  });

  it('info shows id, author, manifest summary and install status', async() => {
    const r = await call(MarketplaceInfoWorker, { kind: 'function', slug: 'pdf-merge' });

    expect(r.successBoolean).toBe(true);
    expect(r.responseString).toContain('Template id: tpl_pdf');
    expect(r.responseString).toContain('functionSummary');
    expect(r.responseString).toContain('Installed: no');
  });

  it('download installs to the user functions dir; repeat is a no-op', async() => {
    const first = await call(MarketplaceDownloadWorker, { kind: 'function', slug: 'pdf-merge' });
    const again = await call(MarketplaceDownloadWorker, { kind: 'function', slug: 'pdf-merge' });

    expect(first.responseString).toContain(`Installed PDF Merge v1.0.0 (function) at ${ path.join(home, 'functions', 'pdf-merge') }`);
    expect(again.responseString).toMatch(/already installed/);
    expect(fs.readdirSync(path.join(home, 'functions'))).toEqual(['pdf-merge']);
  });

  it('update pulls a newer version; diff shows the change first', async() => {
    await call(MarketplaceDownloadWorker, { kind: 'function', slug: 'pdf-merge' });
    expect((await call(MarketplaceUpdateWorker, { kind: 'function', slug: 'pdf-merge' })).responseString).toMatch(/already up to date/);

    rows[0] = { ...rows[0], version: '1.1.0', zip: await zipOf({ 'pdf-merge/function.yaml': 'name: pdf-merge', 'pdf-merge/main.py': 'v2' }) };
    const diff = await call(MarketplaceDiffWorker, { kind: 'function', slug: 'pdf-merge' });
    expect(diff.responseString).toContain('~ main.py');
    expect(diff.responseString).not.toContain('.marketplace.json');

    const up = await call(MarketplaceUpdateWorker, { kind: 'function', slug: 'pdf-merge' });
    expect(up.responseString).toContain('v1.0.0 → v1.1.0');
    expect(fs.readFileSync(path.join(home, 'functions', 'pdf-merge', 'main.py'), 'utf8')).toBe('v2');
  });

  it('publish needs a session and never uploads .env or node_modules', async() => {
    const dir = path.join(home, 'functions', 'my-fn');
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'function.yaml'), 'name: my-fn\ndescription: test\nversion: 1.0.0\nspec:\n  runtime: python\n  entrypoint: main.py::handler\n');
    fs.writeFileSync(path.join(dir, 'main.py'), 'def handler(): pass');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '');

    const signedOut = await call(MarketplacePublishWorker, { kind: 'function', slug: 'my-fn' });
    expect(signedOut.successBoolean).toBe(false);
    expect(signedOut.responseString).toMatch(/Sign in to Sulla Cloud/);

    token = 'tok';
    const r = await call(MarketplacePublishWorker, { kind: 'function', slug: 'my-fn' });
    expect(r.successBoolean).toBe(true);
    expect(r.responseString).toContain('tpl_newsub');
    const names = await zipNames(uploaded!);
    expect(names.sort()).toEqual(['my-fn/function.yaml', 'my-fn/main.py']);
  });

  it('list_published and unpublish target your newest live submission', async() => {
    token = 'tok';
    mine = [
      { id: 'tpl_old', kind: 'function', slug: 'my-fn', version: '0.9', status: 'rejected', bundle_status: 'missing', updated_at: '2026-01-01', admin_notes: 'Withdrawn by author' },
      { id: 'tpl_live', kind: 'function', slug: 'my-fn', version: '1.0', status: 'approved', bundle_status: 'uploaded', updated_at: '2026-02-01', download_count: 3 },
    ];

    const list = await call(MarketplaceListPublishedWorker, {});
    expect(list.responseString).toContain('function/my-fn v1.0 — live');
    expect(list.responseString).toContain('rejected / withdrawn');

    expect((await call(MarketplaceUnpublishWorker, { kind: 'function', slug: 'my-fn' })).successBoolean).toBe(false);
    const r = await call(MarketplaceUnpublishWorker, { kind: 'function', slug: 'my-fn', confirm: true });
    expect(r.responseString).toMatch(/Withdrew function\/my-fn v1.0 \(tpl_live\)/);
    expect(deleted).toEqual(['tpl_live']);
  });
});
