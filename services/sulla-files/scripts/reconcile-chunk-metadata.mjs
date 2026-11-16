// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFile } from 'node:fs/promises';
import { request } from 'node:https';

const apply = process.argv.includes('--apply');
const token = process.env.SULLA_FILES_LOCAL_TOKEN;
if (!token) throw new Error('Set SULLA_FILES_LOCAL_TOKEN in the service environment');
const port = Number(process.env.SULLA_FILES_PORT ?? 8792);
const caPath = process.env.SULLA_FILES_TLS_CERTIFICATE_PATH;
if (!caPath) throw new Error('Set SULLA_FILES_TLS_CERTIFICATE_PATH to the service certificate');
const ca = await readFile(caPath);
const report = await new Promise((resolve, reject) => {
  const body = JSON.stringify({ apply });
  const call = request({ hostname:'127.0.0.1', port, path:'/v1/local/chunk-metadata/reconcile', method:'POST', ca,
    headers:{ 'content-type':'application/json', 'content-length':Buffer.byteLength(body), 'x-sulla-files-token':token } }, response => {
    let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk });
    response.on('end', () => {
      if (response.statusCode !== 200) return reject(new Error(`Chunk reconciliation failed with HTTP ${response.statusCode}`));
      try { resolve(JSON.parse(data)) } catch (error) { reject(error) }
    });
  });
  call.on('error', reject); call.end(body);
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
