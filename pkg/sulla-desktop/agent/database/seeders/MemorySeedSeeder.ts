// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';
import { installCoreSeed, MEMORY_SEED_WORKER } from '../../memory/MemoryPackLoader';
import { resolveMemorySeedDir } from '../../utils/sullaPaths';

export { MEMORY_SEED_WORKER };
function readSeedVersion():number { try{return Number(JSON.parse(fs.readFileSync(path.join(resolveMemorySeedDir(),'manifest.json'),'utf8')).version)||0}catch(error){console.warn('[MemorySeedSeeder] memory seed pack unavailable:',error instanceof Error?error.message:error);return 0} }
export const MEMORY_SEED_VERSION=readSeedVersion();
export async function initialize():Promise<void>{if(!MEMORY_SEED_VERSION)throw new Error('memory seed pack missing or has no version; skipped');const result=await installCoreSeed(resolveMemorySeedDir());console.log(`[MemorySeedSeeder] Seed v${result.version}: ${JSON.stringify(result.counts)}`)}
