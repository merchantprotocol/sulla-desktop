// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import type { ToolManifest } from '../registry';
export const memoryPackToolManifests:ToolManifest[]=[
{name:'pack_list',category:'memory',description:'List installed memory packs with version, published source, install time and content hash.',schemaDef:{},operationTypes:['read'],loader:()=>import('./pack_list')},
{name:'pack_install',category:'memory',description:'Install memory from a published Files skill by slug, or from a local seed-format directory by path. Exactly one is required.',schemaDef:{slug:{type:'string',optional:true,description:'Published memory-pack skill slug in Files.'},path:{type:'string',optional:true,description:'Local directory containing manifest.json, subjects/ and skills/, or a skill directory containing memory/.'},pack_slug:{type:'string',optional:true,description:'Slug to use with path; defaults to the directory name.'}},operationTypes:['create','update'],loader:()=>import('./pack_install')},
{name:'pack_sync',category:'memory',description:'Reload an installed memory pack from its active published Files skill. Retires bullets removed since the prior version.',schemaDef:{slug:{type:'string',description:'Installed memory-pack skill slug.'}},operationTypes:['update'],loader:()=>import('./pack_sync')},
{name:'pack_uninstall',category:'memory',description:'Uninstall a memory pack. Its memory becomes inactive and the seed or authored memory it overrode becomes effective again.',schemaDef:{slug:{type:'string',description:'Installed memory-pack slug.'}},operationTypes:['delete'],loader:()=>import('./pack_uninstall')},
{name:'pack_validate',category:'memory',description:'Validate a published memory-pack skill or local pack directory without installing it. Reports format errors with file and line.',schemaDef:{slug:{type:'string',optional:true,description:'Published memory-pack skill slug.'},path:{type:'string',optional:true,description:'Local pack directory.'}},operationTypes:['read'],loader:()=>import('./pack_validate')},
];
