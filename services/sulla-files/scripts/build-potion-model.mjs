import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const revision = '6fc8051fab2a1e0ee76689cf08c853792ac285e7';
const base = `https://huggingface.co/minishlab/potion-retrieval-32M/resolve/${ revision }`;
const expected = {
  'model.safetensors': '07609e5bd33aad37900b3fd62f4ec96f6daec88ca4d46b9d8b928bfababf6ea0',
  'tokenizer.json':     '7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18',
};
const destination = process.argv[2]; await mkdir(destination, { recursive: true });

async function download(name) {
  const response = await fetch(`${ base }/${ name }`); if (!response.ok) throw new Error(`${ name }: HTTP ${ response.status }`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected[name]) throw new Error(`${ name }: checksum mismatch`);
  await writeFile(join(destination, name), bytes);
}

await download('tokenizer.json'); await download('model.safetensors');
const buffer = await readFile(join(destination, 'model.safetensors'));
const headerLength = Number(buffer.readBigUInt64LE(0)); const header = JSON.parse(buffer.toString('utf8', 8, 8 + headerLength));
const key = Object.keys(header).find(value => value !== '__metadata__'); if (!key) throw new Error('Potion tensor missing');
const { dtype, shape, data_offsets: [start, end] } = header[key]; if (dtype !== 'F32' || shape.length !== 2) throw new Error('Unexpected Potion tensor');
const [rows, dim] = shape; const source = new Float32Array(rows * dim); Buffer.from(source.buffer).set(buffer.subarray(8 + headerLength + start, 8 + headerLength + end));
const output = Buffer.alloc(12 + rows * 4 + rows * dim); output.write('PTN1'); output.writeUInt32LE(rows, 4); output.writeUInt32LE(dim, 8);
for (let row = 0; row < rows; row++) {
  let maximum = 0; for (let d = 0; d < dim; d++) maximum = Math.max(maximum, Math.abs(source[row * dim + d]));
  const scale = maximum ? maximum / 127 : 1; output.writeFloatLE(scale, 12 + row * 4);
  for (let d = 0; d < dim; d++) output.writeInt8(Math.max(-127, Math.min(127, Math.round(source[row * dim + d] / scale))), 12 + rows * 4 + row * dim + d);
}
await writeFile(join(destination, 'model.int8.bin'), output);
await writeFile(join(destination, 'LICENSE'), `minishlab/potion-retrieval-32M @ ${ revision }\nMIT License\nhttps://huggingface.co/minishlab/potion-retrieval-32M\n`);
await writeFile(join(destination, 'REVISION'), `${ revision }\n`);
