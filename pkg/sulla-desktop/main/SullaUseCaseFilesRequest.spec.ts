// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SullaUseCaseFilesRequest } from './SullaUseCaseFilesRequest';
import { SullaUseCaseFiles } from './sullaUseCaseFiles';

const { db } = vi.hoisted(() => ({ db:{ query:vi.fn(), queryOne:vi.fn(), transaction:vi.fn() } }));

vi.mock('electron', () => ({ Notification:{ isSupported:() => false } }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient:db }));
vi.mock('@pkg/agent/database/repositories/UseCaseRemovalRepository', () => ({ UseCaseRemovalRepository:class { listRemoved = vi.fn().mockResolvedValue([]) } }));
vi.mock('@pkg/agent/services/SkillDefinitionService', () => ({ hashSkillContent:vi.fn(), parseSkillMarkdown:vi.fn() }));
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({ installMemoryPackForSkill:vi.fn(), listPacks:vi.fn().mockResolvedValue([]), uninstallPack:vi.fn() }));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry:{ invalidate:vi.fn() } }));
vi.mock('@pkg/main/marketplace/databaseInstaller', () => ({ bundleToArtifact:() => ({ kind:'agent', manifest:{}, files:{} }) }));
vi.mock('@pkg/main/marketplace/databaseArtifacts', () => ({ readDatabaseArtifact:vi.fn() }));
vi.mock('@pkg/utils/logging', () => ({ default:{ background:{ warn:vi.fn() } } }));

describe('SullaUseCaseFilesRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.queryOne.mockResolvedValue({ initial_export_completed_at:'already-exported' });
    db.query.mockResolvedValue([]);
  });

  it('retries local system-area access through the service credential path when credentials become available', async() => {
    // risk: published Use Cases never activate if /v1/local/* is sent without Files service authority
    let serviceCredential:string | undefined;
    const ordinary = vi.fn(async() => new Response('wrong auth path', { status: 401 }));
    const local = vi.fn(async() => serviceCredential
      ? new Response(JSON.stringify([{ id:'home', systemArea:'' }]), { status:200, headers:{ 'content-type':'application/json' } })
      : new Response('unauthorized local request', { status:401 }));
    const request = new SullaUseCaseFilesRequest(ordinary, local);

    expect((await request.send('/v1/local/system-areas')).status).toBe(401);
    serviceCredential = 'available-after-vault-unlock';
    const areas = await request.send('/v1/local/system-areas');

    expect(areas.status).toBe(200);
    expect(await areas.json()).toEqual([{ id:'home', systemArea:'' }]);
    expect(local).toHaveBeenCalledTimes(2);
    expect(ordinary).not.toHaveBeenCalled();
    expect((await request.send('/v1/files?collectionId=home&path=Use%20Cases')).status).toBe(401);
    expect(ordinary).toHaveBeenCalledTimes(1);
  });

  it('retries a failed scheduled scan after local Files credentials become available and records the successful scan', async() => {
    // risk: published Use Cases never activate because one boot-time 401 permanently prevents indexing
    let serviceCredential:string | undefined;
    const ordinary = vi.fn(async(endpoint:string) => {
      if (endpoint.startsWith('/v1/files?')) return new Response(JSON.stringify([{ id:'agent-manifest', path:'Use Cases/agents/old-agent/agent.json', published_version_id:'v1' }]), { status:200 });
      if (endpoint.includes('/preview?')) return new Response('{}', { status:200 });
      throw new Error(`Unexpected ordinary Files request: ${ endpoint }`);
    });
    const local = vi.fn(async() => serviceCredential
      ? new Response(JSON.stringify([{ id:'home', systemArea:'' }]), { status:200 })
      : new Response('unauthorized local request', { status:401 }));
    const transport = new SullaUseCaseFilesRequest(ordinary, local);
    const scanner = new SullaUseCaseFiles((endpoint, init) => transport.send(endpoint, init));

    await (scanner as any).runScheduledScan();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('SET last_error=$1'), ['Files system areas unavailable (401)']);

    serviceCredential = 'available-after-vault-unlock';
    await (scanner as any).runScheduledScan();

    expect(db.query.mock.calls.some(([sql]) => String(sql).includes('SET last_scan_at=NOW(),last_error=NULL'))).toBe(true);
    expect(local).toHaveBeenCalledTimes(3); // failed first scan, then areas + non-fatal activation audit
    scanner.stop();
  });
});
