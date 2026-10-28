// "Sulla" is a trademark. See TRADEMARK.md.
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// Sulla Desktop · https://sulladesktop.com
import { BaseTool,ToolResponse } from '../base'; import { installPack,installPackFiles } from '../../memory/MemoryPackLoader'; import { publishedPackFiles } from './common';
export class MemoryPackInstallWorker extends BaseTool{name='';description='';protected async _validatedCall(input:any):Promise<ToolResponse>{try{const slug=String(input.slug||'').trim(),p=String(input.path||'').trim();if(Boolean(slug)===Boolean(p))return{successBoolean:false,responseString:'Pass exactly one of slug or path.'};const result=slug?await installPackFiles(slug,await publishedPackFiles(slug)):await installPack(p,input.pack_slug?String(input.pack_slug):undefined);return{successBoolean:true,responseString:`Installed memory pack ${result.slug} v${result.version}: ${result.subjects} subjects, ${result.items} items, ${result.skills} skills.`}}catch(error){return{successBoolean:false,responseString:error instanceof Error?error.message:String(error)}}}}
