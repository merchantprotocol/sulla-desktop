// "Sulla" is a trademark. See TRADEMARK.md.
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// Sulla Desktop · https://sulladesktop.com
import { BaseTool,ToolResponse } from '../base'; import { readMemoryPackDirectory,validateMemoryPackFiles } from '../../memory/MemoryPackLoader'; import { publishedPackFiles } from './common';
export class MemoryPackValidateWorker extends BaseTool{name='';description='';protected async _validatedCall(input:any):Promise<ToolResponse>{try{const slug=String(input.slug||'').trim(),p=String(input.path||'').trim();if(Boolean(slug)===Boolean(p))return{successBoolean:false,responseString:'Pass exactly one of slug or path.'};const errors=validateMemoryPackFiles(slug?await publishedPackFiles(slug):readMemoryPackDirectory(p));return{successBoolean:!errors.length,responseString:errors.length?errors.map(e=>`${e.file}:${e.line}: ${e.message}`).join('\n'):'Memory pack is valid.'}}catch(error){return{successBoolean:false,responseString:error instanceof Error?error.message:String(error)}}}}
