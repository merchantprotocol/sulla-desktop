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

  it('leaves a human Use Cases write on the existing immediate-publication path',()=>{
    // risk: data availability — Jonathon's own edits must keep their existing behavior.
    expect(policy.statusForWrite({collection:{system_area:null},path:'Use Cases/functions/x/function.yaml',createdByType:'user'})).toBeNull();
  });
});
