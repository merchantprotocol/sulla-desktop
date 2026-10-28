// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CloudDataSync } from '../cloudDataSync';
import { syncRuntimeProjections } from '../runtimeProjection/sync';
const cloudRequest=jest.fn();
jest.mock('../cloudFetch',()=>({isCloudSignedIn:jest.fn(async()=>true),cloudRequest:(...args:any[])=>cloudRequest(...args)}));
jest.mock('../cloudSettings',()=>({getCloudPreferences:jest.fn(async()=>({enabled:false,workflows:true,liveAgents:true})),isCloudKindEnabled:(p:any,k:string)=>p.enabled&&p[k]}));
jest.mock('../runtimeProjection/workflows',()=>({buildWorkflowProjection:jest.fn(async()=>[{id:'workflow'}]),pushWorkflowProjection:jest.fn(async(upload:any)=>upload('/cloud-runtime/v1/device/workflows',{}))}));
jest.mock('@pkg/agent/tools/agents/cloudProjection',()=>({buildAgentProjection:jest.fn(async()=>[{id:'agent'}]),pushAgentProjection:jest.fn(async(upload:any)=>upload('/cloud-runtime/v1/device/agents',{}))}));
describe('Cloud sync consent gate',()=>{it('does not call cloudRequest while the master switch is off',async()=>{await syncRuntimeProjections(true);await CloudDataSync.syncEnabled(true);expect(cloudRequest).not.toHaveBeenCalled()})});
