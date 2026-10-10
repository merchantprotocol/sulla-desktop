/**
 * @jest-environment node
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as yazl from 'yazl';

jest.unstable_mockModule('@pkg/main/sullaCloudAuth', () => ({ getCurrentAccessToken: () => Promise.resolve('') }));
jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: { background: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } },
}));

const mockFindAgent = jest.fn<any>();
const mockImportAgentManifest = jest.fn<any>();
jest.unstable_mockModule('@pkg/agent/services/AgentDefinitionService', () => ({
  agentDefinitionService: {
    findBySlug:     mockFindAgent,
    importManifest: mockImportAgentManifest,
    list:           jest.fn(() => Promise.resolve([])),
  },
}));

const { installTemplate, listInstalled, findInstalledBySlug, INSTALL_MARKER } = await import('../install');
const { listBundleFiles } = await import('../bundleFiles');

type Files = Record<string, string>;
interface Listing { id: string; kind: string; slug: string; name: string; version: string; zip: Buffer; manifest?: Record<string, unknown> }

function makeZip(files: Files): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, body] of Object.entries(files)) zip.addBuffer(Buffer.from(body), name);
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

let home: string;
let listings: Record<string, Listing>;
let failDownloads: boolean;
const realFetch = global.fetch;

async function publish(l: Omit<Listing, 'zip'>, files: Files) {
  listings[l.id] = { ...l, zip: await makeZip(files) };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-mkt-test-'));
  process.env.SULLA_HOME_DIR = home;
  listings = {};
  failDownloads = false;
  mockFindAgent.mockReset();
  mockImportAgentManifest.mockReset();
  // eslint-disable-next-line @typescript-eslint/require-await -- fetch stub
  global.fetch = (async(input: any) => {
    const url = String(input);
    const m = /\/marketplace\/templates\/([^/?]+)(\/download)?$/.exec(url);
    const l = m ? listings[decodeURIComponent(m[1])] : undefined;
    if (!m || !l) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    if (m[2]) {
      if (failDownloads) return new Response('boom', { status: 500, statusText: 'Server Error' });

      return new Response(new Uint8Array(l.zip), { status: 200, headers: { 'Content-Type': 'application/zip' } });
    }
    const { zip: _z, ...row } = l;

    return new Response(JSON.stringify({ template: { ...row, manifest: l.manifest ?? {} } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.SULLA_HOME_DIR;
  fs.rmSync(home, { recursive: true, force: true });
});

const fnDir = () => path.join(home, 'functions');
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

describe('marketplace installTemplate', () => {
  it('installs into the kind directory and writes an install marker', async() => {
    await publish({ id: 'tpl_1', kind: 'function', slug: 'demo-fn', name: 'Demo', version: '1.0.0' }, {
      'demo-fn/function.yaml': 'name: demo', 'demo-fn/main.py': 'print(1)',
    });

    const res = await installTemplate('tpl_1');

    expect(res).toMatchObject({ kind: 'function', slug: 'demo-fn', version: '1.0.0', path: path.join(fnDir(), 'demo-fn') });
    expect(read(fnDir(), 'demo-fn', 'main.py')).toBe('print(1)');
    expect(JSON.parse(read(fnDir(), 'demo-fn', INSTALL_MARKER))).toMatchObject({ templateId: 'tpl_1', version: '1.0.0', slug: 'demo-fn' });
  });

  it('is a no-op the second time instead of creating a -2 copy', async() => {
    await publish({ id: 'tpl_1', kind: 'function', slug: 'demo-fn', name: 'Demo', version: '1.0.0' }, { 'demo-fn/function.yaml': 'a' });
    await installTemplate('tpl_1');

    const again = await installTemplate('tpl_1');

    expect(again.alreadyInstalled).toBe(true);
    expect(fs.readdirSync(fnDir())).toEqual(['demo-fn']);
  });

  it('recognises an install whose folder name differs from the slug', async() => {
    await publish({ id: 'tpl_r', kind: 'recipe', slug: 'twenty-crm', name: 'Twenty', version: '1' }, { 'twenty/manifest.yaml': 'x' });
    await installTemplate('tpl_r');

    expect((await installTemplate('tpl_r')).alreadyInstalled).toBe(true);
    expect(findInstalledBySlug('recipe', 'twenty-crm')?.path).toBe(path.join(home, 'recipes', 'twenty'));
  });

  it('does not clobber an unrelated local folder with the same name', async() => {
    fs.mkdirSync(path.join(fnDir(), 'demo-fn'), { recursive: true });
    fs.writeFileSync(path.join(fnDir(), 'demo-fn', 'mine.py'), 'keep');
    await publish({ id: 'tpl_1', kind: 'function', slug: 'demo-fn', name: 'Demo', version: '1.0.0' }, { 'demo-fn/function.yaml': 'a' });

    const res = await installTemplate('tpl_1');

    expect(res.path).toBe(path.join(fnDir(), 'demo-fn-2'));
    expect(read(fnDir(), 'demo-fn', 'mine.py')).toBe('keep');
  });

  it('updates in place with overwrite and leaves no backups behind', async() => {
    await publish({ id: 'tpl_1', kind: 'function', slug: 'demo-fn', name: 'Demo', version: '1.0.0' }, { 'demo-fn/main.py': 'v1', 'demo-fn/old.txt': 'x' });
    await installTemplate('tpl_1');
    await publish({ id: 'tpl_1', kind: 'function', slug: 'demo-fn', name: 'Demo', version: '2.0.0' }, { 'demo-fn/main.py': 'v2' });

    const res = await installTemplate('tpl_1', { overwrite: true });

    expect(res).toMatchObject({ updated: true, previousVersion: '1.0.0', version: '2.0.0' });
    expect(fs.readdirSync(fnDir())).toEqual(['demo-fn']);
    expect(read(fnDir(), 'demo-fn', 'main.py')).toBe('v2');
    expect(fs.existsSync(path.join(fnDir(), 'demo-fn', 'old.txt'))).toBe(false);
  });

  it('replaces an older listing (different template id, same slug) when told what it replaces', async() => {
    await publish({ id: 'tpl_old', kind: 'function', slug: 'demo-fn', name: 'Demo', version: '1.0.0' }, { 'demo-fn/main.py': 'v1' });
    await installTemplate('tpl_old');
    await publish({ id: 'tpl_new', kind: 'function', slug: 'demo-fn', name: 'Demo', version: '1.1.0' }, { 'demo-fn/main.py': 'v1.1' });

    const res = await installTemplate('tpl_new', { overwrite: true, replaces: 'tpl_old' });

    expect(res.updated).toBe(true);
    expect(fs.readdirSync(fnDir())).toEqual(['demo-fn']);
    expect(listInstalled().map(a => a.templateId)).toEqual(['tpl_new']);
  });

  it('keeps the original install intact when an update fails', async() => {
    await publish({ id: 'tpl_1', kind: 'function', slug: 'demo-fn', name: 'Demo', version: '1.0.0' }, { 'demo-fn/main.py': 'v1' });
    await installTemplate('tpl_1');
    await publish({ id: 'tpl_1', kind: 'function', slug: 'demo-fn', name: 'Demo', version: '2.0.0' }, { 'demo-fn/main.py': 'v2' });
    failDownloads = true;

    await expect(installTemplate('tpl_1', { overwrite: true })).rejects.toThrow(/download failed: 500/);

    expect(read(fnDir(), 'demo-fn', 'main.py')).toBe('v1');
    expect(fs.readdirSync(fnDir())).toEqual(['demo-fn']);
  });

  it('rejects bundles with path traversal and installs nothing', async() => {
    // yazl refuses to write "..", so write a same-length name and patch the
    // bytes (the filename isn't covered by the CRC).
    const zip = await makeZip({ 'bad/aa/aa/escape.txt': 'pwn' });
    listings.tpl_bad = {
      id: 'tpl_bad',
kind: 'function',
slug: 'bad',
name: 'Bad',
version: '1',
      zip: Buffer.from(zip.toString('latin1').split('bad/aa/aa/').join('bad/../../'), 'latin1'),
    };

    await expect(installTemplate('tpl_bad')).rejects.toThrow(/path traversal|invalid relative path/);
    expect(fs.existsSync(path.join(home, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(fnDir()) ? fs.readdirSync(fnDir()) : []).toEqual([]);
  });

  it('updates an integration and its bundled function without collisions', async() => {
    const integ = (v: string) => ({
      'qb/integration.yaml': 'id: qb\nbundled:\n  functions: [sync]\n',
      'qb/functions/sync/function.yaml': `version: ${ v }`,
    });
    await publish({ id: 'tpl_i', kind: 'integration', slug: 'qb', name: 'QB', version: '1' }, integ('1'));
    await installTemplate('tpl_i');
    expect(read(fnDir(), 'qb-sync', 'function.yaml')).toBe('version: 1');

    await publish({ id: 'tpl_i', kind: 'integration', slug: 'qb', name: 'QB', version: '2' }, integ('2'));
    await installTemplate('tpl_i', { overwrite: true });

    expect(read(fnDir(), 'qb-sync', 'function.yaml')).toBe('version: 2');
    expect(fs.readdirSync(fnDir())).toEqual(['qb-sync']);
  });

  it('imports an agent bundle into the database without writing ~/sulla/agents', async() => {
    const agentManifest = {
      apiVersion:      'sulla/v3',
      kind:            'Agent',
      manifestVersion: 1,
      metadata: { slug: 'reviewer', title: 'Reviewer', description: 'Reviews changes', version: '1.0.0' },
      spec: { prompt: 'Review carefully.', tools: [], skills: [], config: {}, promptFiles: {} },
    };
    await publish({ id: 'tpl_agent', kind: 'agent', slug: 'reviewer', name: 'Reviewer', version: '1.0.0', manifest: { agentSummary: { requires: { skills: [] } } } }, {
      'reviewer/agent.json': JSON.stringify(agentManifest),
      'reviewer/README.md': '# Reviewer',
    });
    mockFindAgent.mockResolvedValue(null);
    mockImportAgentManifest.mockResolvedValue({ name: 'Reviewer' });

    const result = await installTemplate('tpl_agent');

    expect(result).toMatchObject({ kind: 'agent', slug: 'reviewer', path: 'database:agent_definitions/reviewer', version: '1.0.0' });
    expect(mockImportAgentManifest).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ slug: 'reviewer', marketplaceTemplateId: 'tpl_agent' }),
    }));
    expect(fs.existsSync(path.join(home, 'agents'))).toBe(false);
  });

  it('protects a local database agent unless overwrite is explicit', async() => {
    const agentManifest = {
      apiVersion:      'sulla/v3',
      kind:            'Agent',
      manifestVersion: 1,
      metadata: { slug: 'reviewer', title: 'Reviewer', description: '', version: '1.0.0' },
      spec: { prompt: 'Review carefully.', tools: [], skills: [], config: {}, promptFiles: {} },
    };
    await publish({ id: 'tpl_agent', kind: 'agent', slug: 'reviewer', name: 'Reviewer', version: '1.0.0' }, {
      'reviewer/agent.json': JSON.stringify(agentManifest),
    });
    mockFindAgent.mockResolvedValue({ id: 'local-1', slug: 'reviewer', name: 'My Reviewer', source_kind: 'local' });

    await expect(installTemplate('tpl_agent')).rejects.toThrow(/local custom agent.*overwrite:true/);
    expect(mockImportAgentManifest).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, 'agents'))).toBe(false);
  });
});

describe('listBundleFiles (what publish uploads)', () => {
  it('excludes secrets, VCS, dependencies and the install marker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-bundle-'));
    const files = [
      'function.yaml', 'main.py', '.env.example', '.routine-meta.yaml', 'lib/util.py',
      '.env', '.env.local', '.marketplace.json', '.DS_Store', 'server.pem',
      '.git/config', 'node_modules/x/index.js', '__pycache__/m.pyc', '.venv/bin/python',
    ];
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), 'x');
    }

    const listed = listBundleFiles(root).map(f => path.relative(root, f)).sort();

    expect(listed).toEqual(['.env.example', '.routine-meta.yaml', 'function.yaml', 'lib/util.py', 'main.py'].sort());
    fs.rmSync(root, { recursive: true, force: true });
  });
});
