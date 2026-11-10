// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { PublicationLifecyclePolicy } from '../../../../../../services/sulla-files/src/publicationLifecyclePolicy';

describe('PublicationLifecyclePolicy',()=>{
  const policy=new PublicationLifecyclePolicy();

  it.each(['agent','agent-run'])('makes an %s mount write to Use Cases a draft',createdByType=>{
    // risk: permissions — agent mount writes must never bypass Decide.
    expect(policy.statusForWrite({collection:{system_area:null},path:'Use Cases/functions/x/function.yaml',createdByType})).toBe('draft');
  });

  it('excludes the logs collection from the Use Cases approval boundary',()=>{
    // risk: data availability — path text alone must not gate log replication.
    expect(policy.statusForWrite({collection:{system_area:'logs'},path:'Use Cases/log.txt',createdByType:'agent-run'})).toBeNull();
  });

  it('leaves a human Use Cases write on the existing immediate-publication path',()=>{
    // risk: data availability — Jonathon's own edits must keep their existing behavior.
    expect(policy.statusForWrite({collection:{system_area:null},path:'Use Cases/functions/x/function.yaml',createdByType:'user'})).toBeNull();
  });

  it('sanitizes malformed replicated Use Case publication but preserves approved publication and replay result', () => {
    // risk: permissions — replication must not reintroduce an unapproved runtime-visible Use Case.
    const malformed = policy.sanitizeReplication({
      collection:{system_area:'sulla'}, path:'Use Cases/skills/example/SKILL.md', createdByType:'agent-run',
      lifecycle:{publication_status:'published',published_at:null,published_by:null},
    });
    expect(malformed).toEqual({publication_status:'draft',published_at:null,published_by:null});
    expect(policy.sanitizeReplication({
      collection:{system_area:'sulla'}, path:'Use Cases/skills/example/SKILL.md', createdByType:'agent-run', lifecycle:malformed,
    })).toEqual(malformed);

    const approved = {publication_status:'published',published_at:'2026-11-05T00:00:00.000Z',published_by:'jonathon'};
    expect(policy.sanitizeReplication({
      collection:{system_area:'sulla'}, path:'Use Cases/skills/example/SKILL.md', createdByType:'agent', lifecycle:approved,
    })).toEqual(approved);
  });

  it.each(['Projects/p/TASKS.md','Brain/facts/example.md','Memory/example.md','Documents/example.md'])(
    'preserves replicated agent publication outside Use Cases at %s', path => {
      // risk: data availability — replication must retain immediate publication outside the approval boundary.
      const lifecycle={publication_status:'published',published_at:null,published_by:null};
      expect(policy.sanitizeReplication({collection:{system_area:'sulla'},path,createdByType:'agent-run',lifecycle})).toEqual(lifecycle);
    },
  );

});
