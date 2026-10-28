// "Sulla" is a trademark. See TRADEMARK.md.
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// Sulla Desktop · https://sulladesktop.com
import { BaseTool,ToolResponse } from '../base'; import { listPacks } from '../../memory/MemoryPackLoader';
export class MemoryPackListWorker extends BaseTool{name='';description='';protected async _validatedCall():Promise<ToolResponse>{const rows=await listPacks();return{successBoolean:true,responseString:rows.length?JSON.stringify(rows,null,2):'No memory packs are installed.'}}}
