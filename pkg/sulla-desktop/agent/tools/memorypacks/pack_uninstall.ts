// "Sulla" is a trademark. See TRADEMARK.md.
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// Sulla Desktop · https://sulladesktop.com
import { BaseTool,ToolResponse } from '../base'; import { uninstallPack } from '../../memory/MemoryPackLoader';
export class MemoryPackUninstallWorker extends BaseTool{name='';description='';protected async _validatedCall(input:any):Promise<ToolResponse>{const slug=String(input.slug||'').trim();if(!slug)return{successBoolean:false,responseString:'Missing required field: slug.'};const changed=await uninstallPack(slug);return{successBoolean:true,responseString:changed?`Uninstalled memory pack ${slug}.`:`Memory pack ${slug} was not installed.`}}}
