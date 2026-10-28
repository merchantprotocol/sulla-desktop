// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PoolClient } from 'pg';

import { postgresClient } from '../database/PostgresClient';
import { resolveMemorySeedDir } from '../utils/sullaPaths';
import { resetV7SubjectMemoryCache } from './V7SubjectMemory';

export const MEMORY_SEED_WORKER = 'memory-seed';
export const PACK_VERSION_BASE = 1_000_000_000_000;

export interface MemoryPackFile { name:string; content:string; }
export interface MemoryPackValidationError { file:string; line:number; message:string; severity?:'error'|'warning'; }
export interface MemoryPackDocument { front:Record<string,any>; body:string; file:string; }
interface MemoryItem { id:string; subject:string; kind:'policy'|'conclusion'; ptype:string|null; text:string; why:string|null; alwaysOn:boolean; }
interface MemorySubject extends MemoryPackDocument { slug:string; overview:string; items:MemoryItem[]; }
interface ParsedPack { version:number; subjects:MemorySubject[]; skills:MemoryPackDocument[]; hash:string; }
export interface MemoryPackResult { slug:string; version:number; hash:string; subjects:number; items:number; skills:number; }

const normalize = (name:string) => name.replace(/\\/g,'/').replace(/^\.\//,'');
function doc(source:string, file:string):MemoryPackDocument {
  const match=source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) throw new Error(`${file}:1: missing YAML frontmatter`);
  try { return { front:parseYaml(match[1]) || {}, body:match[2].trim(), file }; }
  catch(error) { const pos=(error as any)?.linePos?.[0]; throw new Error(`${file}:${pos?.line || 1}: ${error instanceof Error?error.message:String(error)}`); }
}
function section(body:string, heading:string):string { return body.match(new RegExp(`(?:^|\\n)## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`,'i'))?.[1].trim() || ''; }
function bullets(markdown:string):string[] { return markdown.split('\n').map(line=>line.match(/^\s*-\s+(.+?)\s*$/)?.[1]).filter((x):x is string=>Boolean(x)); }
function itemFor(owner:string, subject:string, raw:string):MemoryItem {
  const tagged=raw.match(/^(DO|DON'T|LESSON|PREFER|DECIDED):\s*(.+)$/i);
  const ptypes:Record<string,string>={ DO:'do', "DON'T":'dont', LESSON:'lesson', PREFER:'preference', DECIDED:'direction' };
  const ptype=tagged ? ptypes[tagged[1].toUpperCase()] : null, content=tagged ? tagged[2] : raw;
  const whyAt=content.search(/\s+Why:\s*/i), text=(whyAt<0?content:content.slice(0,whyAt)).trim(), why=whyAt<0?null:content.slice(whyAt).replace(/^\s*Why:\s*/i,'').trim();
  const hash=crypto.createHash('sha1').update(`${ptype || ''}${text}`).digest('hex').slice(0,12);
  const prefix=owner===MEMORY_SEED_WORKER?'seed':`pack:${owner.slice('memory-pack:'.length)}`;
  return { id:`${prefix}:${subject}:${hash}`,subject,kind:ptype?'policy':'conclusion',ptype,text,why,alwaysOn:owner===MEMORY_SEED_WORKER&&subject==='sulla'&&Boolean(ptype) };
}
function parentFirst(subjects:MemorySubject[]):MemorySubject[] {
  const pending=new Map(subjects.map(x=>[x.slug,x])), output:MemorySubject[]=[];
  while(pending.size) { const ready=[...pending.values()].filter(x=>!x.front.parent||x.front.parent==='global'||!pending.has(String(x.front.parent))); if(!ready.length) throw new Error(`subjects:1: subject parent cycle: ${[...pending.keys()].join(', ')}`); for(const x of ready){output.push(x);pending.delete(x.slug)} }
  return output;
}
function parseFiles(files:MemoryPackFile[], owner:string):ParsedPack {
  const map=new Map(files.map(f=>[normalize(f.name),f.content]));
  const manifestName=map.has('manifest.json')?'manifest.json':'memory/manifest.json';
  let version=0; try { version=Number(JSON.parse(map.get(manifestName)||'{}').version)||0 } catch(error) { throw new Error(`${manifestName}:1: ${error instanceof Error?error.message:String(error)}`) }
  if(!Number.isInteger(version)||version<1||version>=1_000_000) throw new Error(`${manifestName}:1: version must be an integer between 1 and 999999`);
  const prefix=manifestName.startsWith('memory/')?'memory/':'';
  const subjects=[...map].filter(([name])=>name.startsWith(`${prefix}subjects/`)&&name.endsWith('.md')).sort().map(([name,source])=>{ const d=doc(source,name), slug=String(d.front.slug||'').trim(); if(!slug) throw new Error(`${name}:2: subject has no slug`); return {...d,slug,overview:section(d.body,'Overview'),items:[...bullets(section(d.body,'Facts')),...bullets(section(d.body,'Rules'))].map(x=>itemFor(owner,slug,x))}; });
  const skills=[...map].filter(([name])=>name.startsWith(`${prefix}skills/`)&&name.endsWith('.md')).sort().map(([name,source])=>{ const d=doc(source,name); if(!String(d.front.slug||'').trim()) throw new Error(`${name}:2: skill has no slug`); if(!d.front.label||!d.front.trigger_when) throw new Error(`${name}:2: skill requires label and trigger_when`); return d; });
  if(!subjects.length&&!skills.length) throw new Error(`${prefix || '.'}:1: pack has no subjects or skills`);
  const hash=crypto.createHash('sha256').update([...map].sort(([a],[b])=>a.localeCompare(b)).map(([n,c])=>`${n}\0${c}`).join('\0')).digest('hex');
  return {version,subjects:parentFirst(subjects),skills,hash};
}
export function validateMemoryPackFiles(files:MemoryPackFile[], owner='memory-pack:validate'):MemoryPackValidationError[] {
  try {
    const pack=parseFiles(files,owner);
    if(owner===MEMORY_SEED_WORKER)return [];
    const core=parseFiles(readMemoryPackDirectory(resolveMemorySeedDir()),MEMORY_SEED_WORKER);
    const coreSubjects=new Set(core.subjects.map(subject=>subject.slug));
    return pack.subjects.filter(subject=>coreSubjects.has(subject.slug)).map(subject=>({file:subject.file,line:2,message:`subject "${subject.slug}" is part of the core seed's sulla root; pack content can override it while installed`,severity:'warning' as const}));
  } catch(error) {
    const m=String(error instanceof Error?error.message:error).match(/^(.*?):(\d+):\s*(.*)$/);
    return [{file:m?.[1]||'memory',line:Number(m?.[2]||1),message:m?.[3]||String(error),severity:'error'}];
  }
}
export function readMemoryPackDirectory(dir:string):MemoryPackFile[] { const out:MemoryPackFile[]=[]; const walk=(root:string,rel='')=>{for(const ent of fs.readdirSync(root,{withFileTypes:true})){const r=normalize(path.join(rel,ent.name)),p=path.join(root,ent.name);if(ent.isDirectory())walk(p,r);else if(ent.isFile())out.push({name:r,content:fs.readFileSync(p,'utf8')})}}; walk(dir); return out; }

async function apply(client:PoolClient, slug:string, pack:ParsedPack, source:string):Promise<MemoryPackResult> {
  const owner=`memory-pack:${slug}`, now=Date.now(), ids=pack.subjects.flatMap(s=>s.items.map(i=>i.id));
  await client.query(`INSERT INTO subject_memory.packs(slug,version,source,installed_at,files_hash) VALUES($1,$2,$3,NOW(),$4) ON CONFLICT(slug) DO NOTHING`,[slug,pack.version,source,pack.hash]);
  const prior=await client.query<{created_subjects:string[];install_seq:string}>('SELECT created_subjects,install_seq FROM subject_memory.packs WHERE slug=$1 FOR UPDATE',[slug]);
  if(!prior.rowCount)throw new Error(`Could not reserve memory pack ${slug}`);
  const created=new Set<string>(prior.rows[0].created_subjects||[]);
  const seq=Number(prior.rows[0].install_seq);
  const ts=PACK_VERSION_BASE+seq*1_000_000+pack.version;
  await client.query(`INSERT INTO subject_memory.subjects(slug,kind,name,parent,aliases,updated_ts) VALUES('global','global','Global',NULL,'{}',$1) ON CONFLICT DO NOTHING`,[now]);
  for(const s of pack.subjects){
    const exists=await client.query('SELECT 1 FROM subject_memory.subjects WHERE slug=$1',[s.slug]);
    if(!exists.rowCount)created.add(s.slug);
    const aliases=Array.isArray(s.front.aliases)?s.front.aliases.map(String):[];
    await client.query(`INSERT INTO subject_memory.subjects(slug,kind,name,parent,aliases,updated_ts) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(slug) DO UPDATE SET aliases=(SELECT ARRAY(SELECT DISTINCT x FROM unnest(subject_memory.subjects.aliases||excluded.aliases)x)),updated_ts=excluded.updated_ts`,[s.slug,s.front.kind,s.front.name,s.front.parent||'global',aliases,now]);
    if(s.overview)await client.query(`INSERT INTO subject_memory.overviews(subject,ts,text,status,worker) VALUES($1,$2,$3,'active',$4) ON CONFLICT(subject,ts) DO UPDATE SET text=excluded.text,status='active' WHERE subject_memory.overviews.worker=$4`,[s.slug,ts,s.overview,owner]);
    for(const i of s.items)await client.query(`INSERT INTO subject_memory.items(id,kind,ptype,text,why,scope,origin,ts,always_on,worker) VALUES($1,$2,$3,$4,$5,$6,'seeded',$7,$8,$9) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,ptype=excluded.ptype,text=excluded.text,why=excluded.why,scope=excluded.scope,always_on=excluded.always_on,superseded_by=NULL,superseded_ts=NULL WHERE subject_memory.items.origin='seeded' AND subject_memory.items.worker=$9`,[i.id,i.kind,i.ptype,i.text,i.why,[i.subject],now,i.alwaysOn,owner]);
  }
  await client.query(`UPDATE subject_memory.items SET superseded_ts=$1 WHERE worker=$2 AND origin='seeded' AND superseded_ts IS NULL AND NOT(id=ANY($3::text[]))`,[now,owner,ids]);
  await client.query(`DELETE FROM subject_memory.overviews WHERE worker=$1 AND ts<>$2`,[owner,ts]);
  await client.query(`DELETE FROM subject_memory.skills WHERE worker=$1`,[owner]);
  for(const skill of pack.skills){
    const f=skill.front;
    await client.query(`INSERT INTO subject_memory.skills(slug,version_ts,label,trigger_when,trigger_actions,trigger_phrases,body,scope,strength,status,worker) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'active',$9) ON CONFLICT(slug,version_ts) DO UPDATE SET label=excluded.label,trigger_when=excluded.trigger_when,trigger_actions=excluded.trigger_actions,trigger_phrases=excluded.trigger_phrases,body=excluded.body,scope=excluded.scope,strength=excluded.strength,status='active' WHERE subject_memory.skills.worker=$9`,[String(f.slug),ts,f.label,f.trigger_when,f.trigger_actions||[],f.trigger_phrases||[],skill.body,f.scope||['global'],owner]);
  }
  await client.query(`UPDATE subject_memory.packs SET version=$2,source=$3,installed_at=NOW(),files_hash=$4,created_subjects=$5 WHERE slug=$1`,[slug,pack.version,source,pack.hash,[...created]]);
  return {slug,version:pack.version,hash:pack.hash,subjects:pack.subjects.length,items:ids.length,skills:pack.skills.length};
}
export async function installPackFiles(slug:string, files:MemoryPackFile[], source=`files:Use Cases/skills/${slug}`):Promise<MemoryPackResult>{if(!/^[a-z0-9][a-z0-9._-]*$/i.test(slug))throw new Error('Invalid pack slug');const pack=parseFiles(files,`memory-pack:${slug}`);const result=await postgresClient.transaction(c=>apply(c,slug,pack,source));resetV7SubjectMemoryCache();return result;}
export async function installPack(dir:string, slug=path.basename(path.resolve(dir))):Promise<MemoryPackResult>{return installPackFiles(slug,readMemoryPackDirectory(dir),`path:${path.resolve(dir)}`)}
export async function syncPack(slug:string, files?:MemoryPackFile[]):Promise<MemoryPackResult>{if(files)return installPackFiles(slug,files);const row=await postgresClient.queryOne<{source:string}>('SELECT source FROM subject_memory.packs WHERE slug=$1',[slug]);if(!row?.source.startsWith('path:'))throw new Error(`Pack ${slug} must be synced from its published Files skill`);return installPack(row.source.slice(5),slug)}
export async function uninstallPack(slug:string):Promise<boolean>{const owner=`memory-pack:${slug}`,changed=await postgresClient.transaction(async client=>{const row=await client.query<{created_subjects:string[]}>('DELETE FROM subject_memory.packs WHERE slug=$1 RETURNING created_subjects',[slug]);const createdSubjects=row.rows[0]?.created_subjects||[];await client.query(`UPDATE subject_memory.items SET superseded_ts=COALESCE(superseded_ts,$2) WHERE worker=$1 AND origin='seeded' AND superseded_ts IS NULL`,[owner,Date.now()]);await client.query('DELETE FROM subject_memory.skills WHERE worker=$1',[owner]);await client.query('DELETE FROM subject_memory.overviews WHERE worker=$1',[owner]);// Only subjects this pack created, and only when nothing else (items, overviews, skills, children, episodes) refers to them.
  await client.query(`DELETE FROM subject_memory.subjects s WHERE s.slug=ANY($1::text[]) AND s.slug<>'global' AND NOT EXISTS(SELECT 1 FROM subject_memory.episodes e WHERE s.slug=ANY(e.keys)) AND NOT EXISTS(SELECT 1 FROM subject_memory.items i WHERE s.slug=ANY(i.scope) AND i.superseded_ts IS NULL) AND NOT EXISTS(SELECT 1 FROM subject_memory.overviews o WHERE o.subject=s.slug) AND NOT EXISTS(SELECT 1 FROM subject_memory.skills k WHERE s.slug=ANY(k.scope)) AND NOT EXISTS(SELECT 1 FROM subject_memory.subjects c WHERE c.parent=s.slug)`,[createdSubjects]);return Boolean(row.rowCount)});resetV7SubjectMemoryCache();return changed;}
export async function listPacks():Promise<any[]>{return postgresClient.query('SELECT slug,version,source,installed_at,files_hash FROM subject_memory.packs ORDER BY slug')}

/** Load the built-in seed through the same parser while preserving all historical ids and versions. */
export async function installCoreSeed(dir:string):Promise<{version:number;counts:Record<string,number>}>{
  const pack=parseFiles(readMemoryPackDirectory(dir),MEMORY_SEED_WORKER), now=Date.now();
  const activeItemIds=pack.subjects.flatMap(x=>x.items.map(i=>i.id)), activeSkillSlugs=pack.skills.map(x=>String(x.front.slug));
  const counts=await postgresClient.transaction(async client=>{
    const count={subjects:0,aliases:0,overviews:0,items:0,retiredItems:0,skills:0,retiredSkills:0,skippedSkills:0};
    await client.query(`INSERT INTO subject_memory.subjects(slug,kind,name,parent,aliases,updated_ts) VALUES('global','global','Global',NULL,'{}',$1) ON CONFLICT DO NOTHING`,[now]);
    for(const s of pack.subjects){const aliases=Array.isArray(s.front.aliases)?s.front.aliases.map(String):[];const inserted=await client.query(`INSERT INTO subject_memory.subjects(slug,kind,name,parent,aliases,updated_ts) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING slug`,[s.slug,s.front.kind,s.front.name,s.front.parent||'global',aliases,now]);count.subjects+=inserted.rowCount||0;const merged=await client.query(`UPDATE subject_memory.subjects SET aliases=(SELECT ARRAY(SELECT DISTINCT x FROM unnest(aliases||$2::text[])x)) WHERE slug=$1 AND NOT aliases @>$2::text[] RETURNING slug`,[s.slug,aliases]);count.aliases+=merged.rowCount||0;if(s.overview){const r=await client.query(`INSERT INTO subject_memory.overviews(subject,ts,text,status,worker) VALUES($1,$2,$3,'active',$4) ON CONFLICT DO NOTHING RETURNING subject`,[s.slug,pack.version,s.overview,MEMORY_SEED_WORKER]);count.overviews+=r.rowCount||0}for(const i of s.items){const r=await client.query(`INSERT INTO subject_memory.items(id,kind,ptype,text,why,scope,origin,ts,always_on,worker) VALUES($1,$2,$3,$4,$5,$6,'seeded',$7,$8,$9) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,ptype=excluded.ptype,text=excluded.text,why=excluded.why,scope=excluded.scope,always_on=excluded.always_on,superseded_by=NULL,superseded_ts=NULL,worker=excluded.worker WHERE subject_memory.items.origin='seeded' RETURNING id`,[i.id,i.kind,i.ptype,i.text,i.why,[i.subject],now,i.alwaysOn,MEMORY_SEED_WORKER]);count.items+=r.rowCount||0}}
    const retired=await client.query(`UPDATE subject_memory.items SET superseded_ts=$1 WHERE id LIKE 'seed:%' AND origin='seeded' AND worker=$3 AND superseded_ts IS NULL AND NOT(id=ANY($2::text[])) RETURNING id`,[now,activeItemIds,MEMORY_SEED_WORKER]);count.retiredItems=retired.rowCount||0;
    for(const skill of pack.skills){const f=skill.front,slug=String(f.slug);const authored=await client.query(`SELECT 1 FROM subject_memory.skills WHERE slug=$1 AND version_ts>1000000000000 AND worker IS DISTINCT FROM $2 LIMIT 1`,[slug,MEMORY_SEED_WORKER]);if(authored.rowCount){count.skippedSkills++;continue}const r=await client.query(`INSERT INTO subject_memory.skills(slug,version_ts,label,trigger_when,trigger_actions,trigger_phrases,body,scope,strength,status,worker) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'active',$9) ON CONFLICT DO NOTHING RETURNING slug`,[slug,pack.version,f.label,f.trigger_when,f.trigger_actions||[],f.trigger_phrases||[],skill.body,f.scope||['global'],MEMORY_SEED_WORKER]);count.skills+=r.rowCount||0}
    const missing=await client.query<{slug:string}>(`SELECT DISTINCT slug FROM subject_memory.skills WHERE worker=$1 AND status='active' AND NOT(slug=ANY($2::text[]))`,[MEMORY_SEED_WORKER,activeSkillSlugs]);for(const {slug} of missing.rows){const r=await client.query(`INSERT INTO subject_memory.skills(slug,version_ts,label,trigger_when,body,scope,status,worker) SELECT $1,$2,label,trigger_when,'',scope,'retired',$3 FROM subject_memory.skills WHERE slug=$1 ORDER BY version_ts DESC LIMIT 1 ON CONFLICT DO NOTHING RETURNING slug`,[slug,pack.version,MEMORY_SEED_WORKER]);count.retiredSkills+=r.rowCount||0}return count;
  }); resetV7SubjectMemoryCache(); return {version:pack.version,counts};
}
