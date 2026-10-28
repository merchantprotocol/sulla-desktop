// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * End-to-end memory-pack check on a scratch database: seed the core, then install,
 * customize + sync, and uninstall a pack, scoring recall at each step. Never touches
 * the real `sulla` database. Usage: see README.md (add --pack <dir> to test another pack).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (flag:string) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const packDir = path.resolve(arg('--pack') || path.join(here, '../../examples/use-cases/everyday-work'));
const slug = path.basename(packDir);
const cues: { cue:string; skills:string[] }[] = JSON.parse(fs.readFileSync(arg('--cues') || path.join(here, 'pack-cues.json'), 'utf8'));
const database = `sulla_pack_test_${ process.pid }`;
const adminUrl = process.env.SULLA_SEED_EVAL_DATABASE_URL || 'postgresql://sulla:sulla_dev_password@192.168.5.2:30116/postgres';
const scratch = new URL(adminUrl); scratch.pathname = `/${ database }`;
process.env.SULLA_DATABASE_URL = scratch.toString();
process.env.SULLA_MEMORY_SEED_DIR ||= path.resolve(here, '../../resources/memory-seed');
process.env.SULLA_MODELS_DIR ||= '/mnt/worktrees/elephant-memory-offline-image/models';

let failures = 0;
const check = (ok:boolean, what:string) => { console.log(`${ ok ? 'PASS' : 'FAIL' }  ${ what }`); if (!ok) failures++; };
async function admin(sql:string, params:unknown[] = []) { const c = new Client({ connectionString: adminUrl }); c.on('error', () => {}); await c.connect(); try { await c.query(sql, params); } finally { await c.end(); } }

async function main(): Promise<void> {
  await admin(`CREATE DATABASE ${ database }`);
  const workDir = fs.mkdtempSync(path.join('/mnt/worktrees/_scratch', 'pack-test-'));
  try {
    const { postgresClient } = await import('../../pkg/sulla-desktop/agent/database/PostgresClient');
    await postgresClient.initialize();
    for (const m of ['0133_create_v7_subject_memory', '0135_seeded_subject_memory', '0136_create_memory_packs']) await postgresClient.query((await import(`../../pkg/sulla-desktop/agent/database/migrations/${ m }`)).up);
    await postgresClient.query(`CREATE TABLE sulla_settings(property text PRIMARY KEY,value text,"cast" text)`);
    await (await import('../../pkg/sulla-desktop/agent/database/seeders/MemorySeedSeeder')).initialize();
    const loader = await import('../../pkg/sulla-desktop/agent/memory/MemoryPackLoader');
    const mem = await import('../../pkg/sulla-desktop/agent/memory/V7SubjectMemory');
    const labels = async () => new Map((await postgresClient.query<{ slug:string; label:string }>(`SELECT slug,label FROM subject_memory.skills_at((extract(epoch from now())*1000)::bigint) WHERE status='active'`)).map(r => [r.slug, r.label]));
    let run = 0;
    const score = async (tag:string) => {
      await mem.warmV7SubjectMemory(); const L = await labels(); let hits = 0;
      for (const c of cues) {
        const r = await mem.recallV7SubjectMemory([c.cue], `pack-${ process.pid }-${ run++ }`, true) || '';
        if (c.skills.some(s => L.has(s) && r.includes(`### ${ L.get(s) }\n_Trigger:`))) hits++;
      }
      console.log(`      ${ tag }: pack cues answered by a pack skill ${ hits }/${ cues.length }`); return hits;
    };
    const packSkills = fs.readdirSync(path.join(packDir, 'memory', 'skills')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3));
    const coreBefore = (await labels()).size;

    check(loader.validateMemoryPackFiles(loader.readMemoryPackDirectory(packDir)).length === 0, `pack ${ slug } validates`);
    const broken = loader.readMemoryPackDirectory(packDir).map(f => f.name === 'memory/manifest.json' ? { ...f, content: '{"version":0}' } : f);
    check(loader.validateMemoryPackFiles(broken).length === 1, 'a broken manifest is reported with its file and line');
    const beforeLabels = await labels();
    check(packSkills.every(s => !beforeLabels.has(s)), 'pack skills are absent before install');
    await score('before install');

    const installed = await loader.installPack(packDir, slug);
    check(installed.skills === packSkills.length, `install loaded ${ installed.skills }/${ packSkills.length } skills, ${ installed.items } items`);
    const after = await score('after install');
    check(after >= Math.ceil(cues.length * 0.8), 'at least 80% of pack cues are answered by a pack skill');
    const again = await loader.installPack(packDir, slug);
    check(again.hash === installed.hash && (await loader.listPacks()).length === 1, 'reinstall is idempotent');

    // Customize: copy the pack, change one skill label, sync from the copy.
    const custom = path.join(workDir, slug); fs.cpSync(packDir, custom, { recursive: true });
    const target = path.join(custom, 'memory', 'skills', `${ packSkills[0] }.md`);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/^label: .*$/m, 'label: Customized by the human'));
    const mf = path.join(custom, 'memory', 'manifest.json'); fs.writeFileSync(mf, JSON.stringify({ version: JSON.parse(fs.readFileSync(mf, 'utf8')).version + 1 }));
    await loader.installPack(custom, slug);
    check((await labels()).get(packSkills[0]) === 'Customized by the human', 'a customized and synced skill replaces the pack original');

    // A subject the user owns, known only through an episode, must survive uninstall.
    await postgresClient.query(`INSERT INTO subject_memory.subjects(slug,kind,name,parent) VALUES('user-project','project','User project','global')`);
    await postgresClient.query(`INSERT INTO subject_memory.episodes(id,ts,source,text,keys) VALUES('ep-1',$1,'user','worked on the user project',ARRAY['user-project'])`, [Date.now()]);

    check(await loader.uninstallPack(slug), 'uninstall reports a removed pack');
    const left = await labels();
    check(packSkills.every(s => !left.has(s)), 'no pack skill stays active after uninstall');
    check(left.size === coreBefore, `core skills intact after uninstall (${ left.size }/${ coreBefore })`);
    const active = await postgresClient.queryOne<{ n:string }>(`SELECT count(*) n FROM subject_memory.current_items() WHERE id LIKE $1`, [`pack:${ slug }:%`]);
    check(Number(active?.n) === 0, 'no pack item stays active after uninstall');
    const userSubject = await postgresClient.queryOne(`SELECT 1 FROM subject_memory.subjects WHERE slug='user-project'`);
    check(Boolean(userSubject), "the user's own subject survives uninstall");
    const packSubject = await postgresClient.queryOne(`SELECT 1 FROM subject_memory.subjects WHERE slug=$1`, [slug]);
    check(!packSubject, 'the subject the pack created is removed');
    await score('after uninstall');
    await postgresClient.end();
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    await admin('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [database]);
    await admin(`DROP DATABASE IF EXISTS ${ database }`);
  }
  console.log(failures ? `FAILED: ${ failures } check(s)` : 'ALL CHECKS PASSED');
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
