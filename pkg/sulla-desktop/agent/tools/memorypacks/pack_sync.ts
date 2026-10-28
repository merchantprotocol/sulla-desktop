// "Sulla" is a trademark. See TRADEMARK.md.
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// Sulla Desktop · https://sulladesktop.com
import { BaseTool,ToolResponse } from '../base'; import { listPacks,syncPack } from '../../memory/MemoryPackLoader'; import { publishedPackFiles } from './common';
export class MemoryPackSyncWorker extends BaseTool{name='';description='';protected async _validatedCall(input:any):Promise<ToolResponse>{const slug=String(input.slug||'').trim();if(!slug)return{successBoolean:false,responseString:'Missing required field: slug.'};try{const installed=(await listPacks()).find(row=>row.slug===slug);const result=installed?.source?.startsWith('path:')?await syncPack(slug):await syncPack(slug,await publishedPackFiles(slug));return{successBoolean:true,responseString:`Synced memory pack ${slug} v${result.version}.`}}catch(error){return{successBoolean:false,responseString:error instanceof Error?error.message:String(error)}}}}
