import { build } from '/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop/node_modules/esbuild/lib/main.js';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url)); const out = resolve(root, 'dist');
await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
for (const entry of ['background', 'content', 'popup', 'options']) await build({ entryPoints: [resolve(root, `src/${entry}.ts`)], bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', nodePaths: ['/mnt/data/devcache/deps/_sulla_vault-crypto-ba6ccc44206000be/node_modules'], outfile: resolve(out, `${entry}.js`), sourcemap: false });
for (const file of ['manifest.json', 'src/popup.html', 'src/options.html', 'src/popup.css']) await cp(resolve(root, file), resolve(out, file.replace('src/', '')));
