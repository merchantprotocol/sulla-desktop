// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { deviceMessage } from '../../deviceKey';
import { requireHumanFilesSync } from '..';

describe('Files sync v1 signed and human-only contracts',()=>{
  test('signature message has the binding purpose and exact parts order',()=>{
    expect(deviceMessage('files-sync-v1',['user','device','collection','commit','abc',123])).toBe('sulla-files-sync-v1\nuser\ndevice\ncollection\ncommit\nabc\n123');
  });
  test('agents cannot change backup or invoke restore',()=>{
    expect(()=>requireHumanFilesSync({kind:'agent',agentId:'untrusted'})).toThrow('Only the person using this desktop');
    expect(()=>requireHumanFilesSync({kind:'human'})).not.toThrow();
  });
});
