// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { postgresClient } from '../../database/PostgresClient';
import type { MemoryPackFile } from '../../memory/MemoryPackLoader';
export async function publishedPackFiles(slug:string):Promise<MemoryPackFile[]>{const row=await postgresClient.queryOne<any>(`SELECT frontmatter,files,enabled,deleted_at,use_case_version_id FROM skill_definitions WHERE slug=$1`,[slug]);if(!row||!row.enabled||row.deleted_at||!row.use_case_version_id)throw new Error(`Published pack skill not found or inactive: ${slug}`);const front=typeof row.frontmatter==='string'?JSON.parse(row.frontmatter):row.frontmatter;if(front?.memory_pack!==true)throw new Error(`Skill ${slug} does not declare memory_pack: true`);const files=typeof row.files==='string'?JSON.parse(row.files):row.files||{};return Object.entries(files).filter(([name])=>name.startsWith('memory/')).map(([name,content])=>({name:String(name),content:typeof content==='string'?content:Buffer.from((content as any).content,'base64').toString('utf8')}));}
