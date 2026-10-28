// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

interface Cue { cue:string; subjects:string[]; skills:string[]; }
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureMode = process.argv.includes('--fixtures');
const seedDir = fixtureMode ? path.join(here,'fixtures') : path.resolve(here,'../../resources/memory-seed');
const database = `sulla_seed_eval_${ process.pid }`;
const adminUrl = process.env.SULLA_SEED_EVAL_DATABASE_URL || 'postgresql://sulla:sulla_dev_password@192.168.5.2:30116/postgres';
const scratchUrl = new URL(adminUrl); scratchUrl.pathname = `/${ database }`;
process.env.SULLA_DATABASE_URL = scratchUrl.toString();
process.env.SULLA_MEMORY_SEED_DIR = seedDir;
process.env.SULLA_MODELS_DIR ||= '/mnt/worktrees/elephant-memory-offline-image/models';

const fixtures: Cue[] = [
  { cue:'send a slack message to #general', subjects:['tool-slack'], skills:['sulla-tool-slack'] },
  { cue:'find the Slack channel for engineering', subjects:['tool-slack'], skills:['sulla-tool-slack'] },
  { cue:'Sulla Desktop should use its shipped tools', subjects:[], skills:[] },
];
const cuesArg = process.argv.indexOf('--cues');
const cuesFile = cuesArg > 0 ? path.resolve(process.argv[cuesArg + 1]) : path.join(here,'cues.json');
// use-cases.json rows graded 'gap' have no expected answer yet; they are reported, not scored.
const cues: Cue[] = fixtureMode ? fixtures : JSON.parse(fs.readFileSync(cuesFile,'utf8'));

async function main(): Promise<void> {
  const admin = new Client({ connectionString:adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${ database }`);
    const { postgresClient } = await import('../../pkg/sulla-desktop/agent/database/PostgresClient');
    const m133 = await import('../../pkg/sulla-desktop/agent/database/migrations/0133_create_v7_subject_memory');
    const m135 = await import('../../pkg/sulla-desktop/agent/database/migrations/0135_seeded_subject_memory');
    await postgresClient.initialize();
    await postgresClient.query(m133.up);
    await postgresClient.query(m135.up);
    await postgresClient.query(`CREATE TABLE sulla_settings(property text PRIMARY KEY,value text,"cast" text)`);
    const seeder = await import('../../pkg/sulla-desktop/agent/database/seeders/MemorySeedSeeder');
    await seeder.initialize();
    const { recallV7SubjectMemory, warmV7SubjectMemory } = await import('../../pkg/sulla-desktop/agent/memory/V7SubjectMemory');
    // Recall embeds lazily in the background; warm once so every cue is scored on vectors.
    await warmV7SubjectMemory();
    const labelRows = await postgresClient.query<{slug:string;label:string}>(`SELECT slug,label FROM subject_memory.skills_at((extract(epoch from now())*1000)::bigint) WHERE status='active'`);
    const labelOf = new Map(labelRows.map(x => [x.slug, x.label]));
    // A cue passes when recall surfaces ANY of its acceptable subjects (and, separately, skills).
    let subjectHits=0, subjectTotal=0, skillHits=0, skillTotal=0;
    for (const [index,cue] of cues.entries()) {
      const recalled = await recallV7SubjectMemory([cue.cue],`eval-${ process.pid }-${ index }`,true) || '';
      const chosen = [...recalled.matchAll(/^## project-([a-z0-9-]+)\.md/gm)].map(m => m[1]);
      const shownSkills = [...labelOf].filter(([,label]) => recalled.includes(`### ${ label }\n_Trigger:`)).map(([slug]) => slug);
      const subjectHit = cue.subjects.length ? cue.subjects.some(s => chosen.includes(s)) : null;
      const skillHit = cue.skills.length ? cue.skills.some(s => shownSkills.includes(s)) : null;
      if (subjectHit !== null) { subjectTotal++; if (subjectHit) subjectHits++; }
      if (skillHit !== null) { skillTotal++; if (skillHit) skillHits++; }
      const mark = (hit:boolean|null) => hit === null ? 'n/a' : hit ? 'hit' : 'MISS';
      if (index === 0) console.log(`recall block: ${ recalled.length } chars; core rules section: ${ recalled.includes('## sulla.md') ? 'present' : 'MISSING' }`);
      console.log(`${index+1}. ${cue.cue}\n   subject ${mark(subjectHit)} [${chosen.join(', ')}]  skill ${mark(skillHit)} [${shownSkills.join(', ')}]`);
    }
    console.log(`TOTAL subject=${subjectHits}/${subjectTotal} (${subjectTotal ? (100*subjectHits/subjectTotal).toFixed(1):'100.0'}%) skill=${skillHits}/${skillTotal} (${skillTotal ? (100*skillHits/skillTotal).toFixed(1):'100.0'}%)`);
    await postgresClient.end();
  } finally {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`,[database]);
    await admin.query(`DROP DATABASE IF EXISTS ${ database }`);
    await admin.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode=1; });
